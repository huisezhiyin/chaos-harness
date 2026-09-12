import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { JsonValue } from "../../../kernel/src/index.js"
import {
  CodexAppServerError,
  CodexAppServerRpcError,
  abortedError,
} from "./errors.js"
import {
  decodeCodexWireMessage,
  decodeInitializeResponse,
  type CodexClientNotification,
  type CodexClientRequest,
  type CodexInitializeResponse,
  type CodexRequestId,
  type CodexServerNotification,
  type CodexServerRequest,
} from "./protocol.js"

export interface AppServerProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: "error", listener: (error: Error) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export type AppServerProcessFactory = () => AppServerProcess

export interface CodexAppServerClientOptions {
  command?: string
  env?: NodeJS.ProcessEnv
  processFactory?: AppServerProcessFactory
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxStderrBytes?: number
  serverRequestHandler?: CodexServerRequestHandler
}

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
  signal: AbortSignal,
) => JsonValue | Promise<JsonValue>

interface PendingRequest {
  resolve(value: JsonValue): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal: AbortSignal | undefined
  abortListener: (() => void) | undefined
}

export interface CodexClientDiagnostics {
  stderr: string
  stderrTruncated: boolean
  notificationCount: number
  serverRequestCount: number
}

export const DEFAULT_CODEX_COMMAND = "/opt/homebrew/bin/codex"

export class CodexAppServerClient {
  private readonly child: AppServerProcess
  private readonly requestTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly maxStderrBytes: number
  private readonly serverRequestHandler: CodexServerRequestHandler | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notificationListeners = new Set<(value: CodexServerNotification) => void>()
  private readonly serverRequestAbort = new AbortController()
  private readonly exitPromise: Promise<void>
  private resolveExit!: () => void
  private nextRequestId = 1
  private fatalError: CodexAppServerError | undefined
  private closing = false
  private exited = false
  private stderrText = ""
  private stderrTruncated = false
  private notificationCount = 0
  private serverRequestCount = 0

  constructor(options: CodexAppServerClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_000
    this.maxStderrBytes = options.maxStderrBytes ?? 16_384
    this.serverRequestHandler = options.serverRequestHandler
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.child = options.processFactory?.() ?? spawnAppServer(options.command, options.env)
    this.attachProcess()
  }

  async initialize(signal?: AbortSignal): Promise<CodexInitializeResponse> {
    const result = await this.request(
      "initialize",
      {
        clientInfo: {
          name: "chaos-harness",
          title: "Chaos Harness",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
      { signal },
    )
    const initialized = decodeInitializeResponse(result)
    if (initialized === undefined) {
      throw new CodexAppServerError("protocol", "Invalid initialize response")
    }
    this.notify("initialized")
    return initialized
  }

  steerTurn(
    threadId: string,
    expectedTurnId: string,
    content: string,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<JsonValue> {
    return this.request(
      "turn/steer",
      {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text: content, text_elements: [] }],
      },
      options,
    )
  }

  interruptTurn(
    threadId: string,
    turnId: string,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<JsonValue> {
    return this.request("turn/interrupt", { threadId, turnId }, options)
  }

  request<T extends JsonValue = JsonValue>(
    method: string,
    params: JsonValue,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<T> {
    if (this.fatalError !== undefined) {
      return Promise.reject(this.fatalError)
    }
    if (this.closing || this.exited) {
      return Promise.reject(new CodexAppServerError("transport", "Codex app-server is closed"))
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortedError())
    }

    const id = this.nextRequestId
    this.nextRequestId += 1
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlePending(id, new CodexAppServerError(
          "timeout",
          `Codex app-server request timed out: ${method}`,
          true,
        ))
      }, timeoutMs)
      timer.unref()
      const abortListener = options.signal === undefined
        ? undefined
        : () => this.settlePending(id, abortedError())
      if (abortListener !== undefined) {
        options.signal?.addEventListener("abort", abortListener, { once: true })
      }
      this.pending.set(requestKey(id), {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal: options.signal,
        abortListener,
      })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.settlePending(
          id,
          new CodexAppServerError(
            "transport",
            error instanceof Error ? error.message : "Failed to write app-server request",
          ),
        )
      }
    })
  }

  notify(method: string, params?: JsonValue): void {
    const notification: CodexClientNotification = params === undefined
      ? { method }
      : { method, params }
    this.write(notification)
  }

  onNotification(listener: (value: CodexServerNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  waitForNotification(
    method: string,
    predicate: (value: CodexServerNotification) => boolean = () => true,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<CodexServerNotification> {
    if (options.signal?.aborted === true) {
      return Promise.reject(abortedError())
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout
      const cleanup = (): void => {
        clearTimeout(timer)
        unsubscribe()
        options.signal?.removeEventListener("abort", onAbort)
      }
      const listener = (notification: CodexServerNotification): void => {
        if (notification.method === method && predicate(notification)) {
          cleanup()
          resolve(notification)
        }
      }
      const unsubscribe = this.onNotification(listener)
      const onAbort = (): void => {
        cleanup()
        reject(abortedError())
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new CodexAppServerError(
          "timeout",
          `Timed out waiting for notification: ${method}`,
          true,
        ))
      }, timeoutMs)
      timer.unref()
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  diagnostics(): CodexClientDiagnostics {
    return {
      stderr: this.stderrText,
      stderrTruncated: this.stderrTruncated,
      notificationCount: this.notificationCount,
      serverRequestCount: this.serverRequestCount,
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) {
      await this.exitPromise
      return
    }
    this.closing = true
    this.serverRequestAbort.abort()
    this.rejectAll(new CodexAppServerError("shutdown", "Codex app-server is shutting down"))
    if (!this.exited) {
      this.child.stdin.end()
      await this.waitForExit(this.shutdownTimeoutMs)
    }
    if (!this.exited) {
      this.child.kill("SIGTERM")
      await this.waitForExit(this.shutdownTimeoutMs)
    }
    if (!this.exited) {
      this.child.kill("SIGKILL")
      await this.waitForExit(this.shutdownTimeoutMs)
    }
  }

  private attachProcess(): void {
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => this.receiveLine(line))
    this.child.stderr.on("data", (chunk: Buffer | string) => this.captureStderr(chunk))
    this.child.once("error", (error) => {
      this.fail(new CodexAppServerError("startup", `Failed to start Codex app-server: ${error.message}`))
      this.finishExit()
    })
    this.child.once("exit", (code, signal) => {
      this.finishExit()
      if (!this.closing) {
        this.fail(new CodexAppServerError(
          "process_exit",
          `Codex app-server exited before shutdown (code=${String(code)}, signal=${String(signal)})`,
          true,
        ))
      }
    })
  }

  private receiveLine(line: string): void {
    if (line.trim().length === 0 || this.fatalError !== undefined) {
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      this.fail(new CodexAppServerError("protocol", "Codex app-server emitted malformed JSON"))
      return
    }
    const wire = decodeCodexWireMessage(decoded)
    if (wire === undefined) {
      this.fail(new CodexAppServerError("protocol", "Codex app-server emitted an invalid message"))
      return
    }
    if (wire.kind === "response") {
      this.settlePending(wire.message.id, undefined, wire.message.result)
      return
    }
    if (wire.kind === "error") {
      this.settlePending(
        wire.message.id,
        new CodexAppServerRpcError(
          wire.message.error.code,
          wire.message.error.message,
          wire.message.error.data,
        ),
      )
      return
    }
    if (wire.kind === "notification") {
      this.notificationCount += 1
      for (const listener of this.notificationListeners) {
        listener(wire.message)
      }
      return
    }
    this.serverRequestCount += 1
    void this.handleServerRequest(wire.message)
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    if (this.closing || this.exited) {
      return
    }
    if (this.serverRequestHandler === undefined) {
      this.write({
        id: request.id,
        error: { code: -32601, message: `No client handler for ${request.method}` },
      })
      return
    }
    try {
      const result = await this.serverRequestHandler(request, this.serverRequestAbort.signal)
      if (!this.closing && !this.exited) {
        this.write({ id: request.id, result })
      }
    } catch (error) {
      if (!this.closing && !this.exited) {
        this.write({
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Client request handler failed",
          },
        })
      }
    }
  }

  private settlePending(id: CodexRequestId, error?: Error, result?: JsonValue): void {
    const pending = this.pending.get(requestKey(id))
    if (pending === undefined) {
      return
    }
    this.pending.delete(requestKey(id))
    clearTimeout(pending.timer)
    if (pending.abortListener !== undefined) {
      pending.signal?.removeEventListener("abort", pending.abortListener)
    }
    if (error !== undefined) {
      pending.reject(error)
    } else {
      pending.resolve(result ?? null)
    }
  }

  private write(message: CodexClientRequest | CodexClientNotification | Record<string, unknown>): void {
    if (this.closing || this.exited) {
      throw new CodexAppServerError("transport", "Cannot write to closed Codex app-server")
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private captureStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    const remaining = this.maxStderrBytes - Buffer.byteLength(this.stderrText)
    if (remaining <= 0) {
      this.stderrTruncated = true
      return
    }
    const buffer = Buffer.from(text)
    this.stderrText += buffer.subarray(0, remaining).toString("utf8")
    if (buffer.byteLength > remaining) {
      this.stderrTruncated = true
    }
  }

  private fail(error: CodexAppServerError): void {
    if (this.fatalError === undefined) {
      this.fatalError = error
      this.rejectAll(error)
    }
  }

  private rejectAll(error: Error): void {
    for (const key of [...this.pending.keys()]) {
      const separator = key.indexOf(":")
      const rawId = key.slice(separator + 1)
      const id: CodexRequestId = key.startsWith("number:") ? Number(rawId) : rawId
      this.settlePending(id, error)
    }
  }

  private finishExit(): void {
    if (!this.exited) {
      this.exited = true
      this.resolveExit()
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) {
      return
    }
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref()
      }),
    ])
  }
}

function spawnAppServer(command = DEFAULT_CODEX_COMMAND, env = process.env): ChildProcessWithoutNullStreams {
  return spawn(command, ["app-server", "--listen", "stdio://"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
}

function requestKey(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`
}
