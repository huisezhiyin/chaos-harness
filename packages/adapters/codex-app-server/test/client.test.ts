import { afterEach, describe, expect, it, vi } from "vitest"
import { CodexAppServerClient } from "../src/client.js"
import { CodexAppServerError, CodexAppServerRpcError } from "../src/errors.js"
import { isRecord } from "../src/protocol.js"
import { FakeAppServerProcess } from "./fake-process.js"

const clients: CodexAppServerClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()))
})

describe("CodexAppServerClient", () => {
  it("performs initialize then initialized without opting into experimental APIs", async () => {
    const process = new FakeAppServerProcess()
    process.onMessage = (message) => {
      const record = isRecord(message) ? message : undefined
      if (record?.method === "initialize") {
        process.send({
          id: record.id,
          result: {
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "codex-cli/0.133.0",
          },
        })
      }
    }
    const client = createClient(process)

    await expect(client.initialize()).resolves.toMatchObject({
      platformFamily: "unix",
      platformOs: "macos",
    })
    expect(process.received).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "chaos-harness", title: "Chaos Harness", version: "0.0.0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      },
      { method: "initialized" },
    ])
  })

  it("correlates out-of-order responses by monotonically increasing id", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)
    const first = client.request("first", {})
    const second = client.request("second", {})

    process.send({ id: 2, result: "two" })
    process.send({ id: 1, result: "one" })

    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"])
  })

  it("routes notifications independently from responses", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)
    const seen: string[] = []
    client.onNotification((notification) => seen.push(notification.method))
    const waiting = client.waitForNotification("turn/completed")

    process.send({ method: "item/started", params: { id: "item-1" } })
    process.send({ method: "turn/completed", params: { threadId: "thread-1" } })

    await expect(waiting).resolves.toMatchObject({ method: "turn/completed" })
    expect(seen).toEqual(["item/started", "turn/completed"])
  })

  it("exposes stable steer and interrupt request seams", async () => {
    const process = new FakeAppServerProcess()
    process.onMessage = (message) => {
      const record = isRecord(message) ? message : undefined
      if (record?.id !== undefined) {
        process.send({ id: record.id, result: {} })
      }
    }
    const client = createClient(process)

    await client.steerTurn("thread-1", "turn-1", "Focus on the failing test")
    await client.interruptTurn("thread-1", "turn-1")

    expect(process.received).toContainEqual({
      id: 1,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Focus on the failing test", text_elements: [] }],
      },
    })
    expect(process.received).toContainEqual({
      id: 2,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    })
  })

  it("responds to server-initiated requests through the explicit handler", async () => {
    const process = new FakeAppServerProcess()
    const client = new CodexAppServerClient({
      processFactory: () => process,
      serverRequestHandler: async () => ({ decision: "decline" }),
    })
    clients.push(client)

    process.send({
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1" },
    })

    await vi.waitFor(() => {
      expect(process.received).toContainEqual({
        id: "approval-1",
        result: { decision: "decline" },
      })
    })
  })

  it("fails closed for an unhandled server request instead of hanging", async () => {
    const process = new FakeAppServerProcess()
    createClient(process)
    process.send({ id: 7, method: "item/tool/call", params: {} })

    await vi.waitFor(() => {
      expect(process.received).toContainEqual({
        id: 7,
        error: { code: -32601, message: "No client handler for item/tool/call" },
      })
    })
  })

  it("bounds captured stderr", async () => {
    const process = new FakeAppServerProcess()
    const client = new CodexAppServerClient({
      processFactory: () => process,
      maxStderrBytes: 5,
    })
    clients.push(client)

    process.stderr.write("123456789")
    await vi.waitFor(() => expect(client.diagnostics().stderrTruncated).toBe(true))
    expect(client.diagnostics().stderr).toBe("12345")
  })

  it("classifies a bounded request timeout", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)

    await expect(client.request("model/list", {}, { timeoutMs: 5 })).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    })
  })

  it("cleans up an aborted pending request", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)
    const abort = new AbortController()
    const pending = client.request("model/list", {}, { signal: abort.signal })

    abort.abort()

    await expect(pending).rejects.toMatchObject({ kind: "aborted" })
    process.send({ id: 1, result: { data: [] } })
    await expect(client.request("next", {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(
      CodexAppServerError,
    )
  })

  it("classifies overload -32001 separately", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)
    const pending = client.request("model/list", {})
    process.send({ id: 1, error: { code: -32001, message: "busy" } })

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerRpcError)
    await expect(pending).rejects.toMatchObject({ kind: "overloaded", retryable: true })
  })

  it("rejects pending work on malformed JSON", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)
    const pending = client.request("model/list", {})
    process.sendRaw("{not-json")

    await expect(pending).rejects.toMatchObject({ kind: "protocol" })
  })

  it("rejects pending work when the process exits early", async () => {
    const process = new FakeAppServerProcess()
    const client = createClient(process)
    const pending = client.request("model/list", {})
    process.exit(9, null)

    await expect(pending).rejects.toMatchObject({ kind: "process_exit", retryable: true })
  })

  it("uses bounded termination when graceful shutdown does not exit", async () => {
    const process = new FakeAppServerProcess()
    process.autoExitOnEnd = false
    const client = new CodexAppServerClient({
      processFactory: () => process,
      shutdownTimeoutMs: 1,
    })

    await client.shutdown()

    expect(process.killSignals).toEqual(["SIGTERM"])
  })
})

function createClient(process: FakeAppServerProcess): CodexAppServerClient {
  const client = new CodexAppServerClient({ processFactory: () => process })
  clients.push(client)
  return client
}
