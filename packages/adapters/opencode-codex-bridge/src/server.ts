import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
  runCodexDogfoodAttempt,
  type CodexDogfoodRunOptions,
  type CodexDogfoodRunSummary,
} from "../../codex-app-server/src/dogfood.js"

export const OPENCODE_BRIDGE_PROVIDER = "chaos-codex"
export const OPENCODE_CODE_AGENT_MODEL = "code-agent"
export const OPENCODE_METADATA_MODEL = "metadata"
export const OPENCODE_BRIDGE_MODEL = `${OPENCODE_BRIDGE_PROVIDER}/${OPENCODE_CODE_AGENT_MODEL}`
export const OPENCODE_BRIDGE_SMALL_MODEL = `${OPENCODE_BRIDGE_PROVIDER}/${OPENCODE_METADATA_MODEL}`
export const OPENCODE_BRIDGE_HOST = "127.0.0.1"

const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_MAX_PROJECTION_CHARS = 48_000

export type OpenCodeCodexAttemptRunner = (
  options: CodexDogfoodRunOptions,
) => Promise<CodexDogfoodRunSummary>

export interface OpenCodeCodexBridgeOptions {
  workspaceRoot: string
  codexModel: string
  recordPath: string
  codexCommand?: string
  timeoutMs?: number
  allowDirty?: boolean
  maxBodyBytes?: number
  maxProjectionChars?: number
  attemptRunner?: OpenCodeCodexAttemptRunner
}

export interface OpenCodeCodexBridge {
  baseUrl: string
  apiKey: string
  close(): Promise<void>
}

export interface OpenCodeBridgeConfig {
  model: string
  small_model: string
  enabled_providers: readonly [typeof OPENCODE_BRIDGE_PROVIDER]
  autoupdate: false
  share: "disabled"
  provider: Record<string, unknown>
  [key: string]: unknown
}

interface ChatMessage {
  role: "user" | "assistant"
  text: string
}

interface ChatCompletionRequest {
  model: string
  stream: boolean
  messages: ChatMessage[]
}

class BridgeHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "BridgeHttpError"
  }
}

export async function startOpenCodeCodexBridge(
  options: OpenCodeCodexBridgeOptions,
): Promise<OpenCodeCodexBridge> {
  validateBridgeOptions(options)
  const apiKey = randomBytes(32).toString("base64url")
  const attemptRunner = options.attemptRunner ?? runCodexDogfoodAttempt
  const activeAttempts = new Set<AbortController>()
  let codeAgentBusy = false

  const server = createServer(async (request, response) => {
    try {
      requireAuthorization(request, apiKey)
      const url = new URL(request.url ?? "/", `http://${OPENCODE_BRIDGE_HOST}`)
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [
            modelDescriptor(OPENCODE_CODE_AGENT_MODEL),
            modelDescriptor(OPENCODE_METADATA_MODEL),
          ],
        })
        return
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        throw new BridgeHttpError(404, "Route not found", "route_not_found")
      }

      const body = await readJsonBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
      const chat = parseChatCompletionRequest(body)
      if (chat.model === OPENCODE_METADATA_MODEL) {
        sendCompletion(response, chat, metadataTitle(chat.messages), zeroUsage())
        return
      }
      if (chat.model !== OPENCODE_CODE_AGENT_MODEL) {
        throw new BridgeHttpError(400, "Unknown bridge model", "unknown_model")
      }
      if (codeAgentBusy) {
        throw new BridgeHttpError(409, "A code-agent Attempt is already running", "attempt_busy")
      }

      const controller = new AbortController()
      const abortAttempt = () => controller.abort(new Error("OpenCode request disconnected"))
      request.once("aborted", abortAttempt)
      response.once("close", () => {
        if (!response.writableEnded) abortAttempt()
      })
      activeAttempts.add(controller)
      codeAgentBusy = true
      try {
        const goal = projectOpenCodeMessages(
          chat.messages,
          options.maxProjectionChars ?? DEFAULT_MAX_PROJECTION_CHARS,
        )
        const run = await attemptRunner({
          workspaceRoot: options.workspaceRoot,
          goal,
          model: options.codexModel,
          recordPath: options.recordPath,
          ...(options.codexCommand === undefined ? {} : { command: options.codexCommand }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.allowDirty === undefined ? {} : { allowDirty: options.allowDirty }),
          signal: controller.signal,
        })
        if (controller.signal.aborted || response.destroyed) return
        if (run.boundaryViolation) {
          throw new BridgeHttpError(502, "Harness rejected an artifact boundary violation", "boundary_violation")
        }
        if (run.result.status !== "completion_proposed") {
          throw new BridgeHttpError(
            run.result.status === "aborted" ? 499 : 502,
            `Harness Attempt ended as ${run.result.status}`,
            `attempt_${run.result.status}`,
          )
        }
        sendCompletion(response, chat, run.result.completion, {
          prompt_tokens: run.result.usage.inputTokens,
          completion_tokens: run.result.usage.outputTokens,
          total_tokens: run.result.usage.inputTokens + run.result.usage.outputTokens,
        })
      } finally {
        request.off("aborted", abortAttempt)
        activeAttempts.delete(controller)
        codeAgentBusy = false
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      if (error instanceof BridgeHttpError) {
        sendError(response, error.statusCode, error.message, error.code)
        return
      }
      sendError(response, 500, "Chaos Harness bridge failed", "bridge_failure")
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, OPENCODE_BRIDGE_HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://${OPENCODE_BRIDGE_HOST}:${address.port}/v1`,
    apiKey,
    async close() {
      for (const controller of activeAttempts) {
        controller.abort(new Error("Chaos Harness bridge closed"))
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      })
    },
  }
}

export function createOpenCodeBridgeConfig(
  baseUrl: string,
  apiKey: string,
  existingConfigContent?: string,
): OpenCodeBridgeConfig {
  const existing = parseExistingConfig(existingConfigContent)
  const providers = isRecord(existing.provider) ? existing.provider : {}
  return {
    ...existing,
    model: OPENCODE_BRIDGE_MODEL,
    small_model: OPENCODE_BRIDGE_SMALL_MODEL,
    enabled_providers: [OPENCODE_BRIDGE_PROVIDER],
    autoupdate: false,
    share: "disabled",
    provider: {
      ...providers,
      [OPENCODE_BRIDGE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Chaos Harness / Codex",
        options: { baseURL: baseUrl, apiKey },
        models: {
          [OPENCODE_CODE_AGENT_MODEL]: {
            name: "ChatGPT Code Agent via Chaos Harness",
            tool_call: false,
            limit: { context: 200_000, output: 32_000 },
          },
          [OPENCODE_METADATA_MODEL]: {
            name: "Chaos Harness Local Metadata",
            tool_call: false,
            limit: { context: 16_000, output: 128 },
          },
        },
      },
    },
  }
}

export function projectOpenCodeMessages(
  messages: readonly ChatMessage[],
  maxChars = DEFAULT_MAX_PROJECTION_CHARS,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1_000) {
    throw new TypeError("Projection limit must be an integer of at least 1000 characters")
  }
  if (!messages.some((message) => message.role === "user" && message.text.trim().length > 0)) {
    throw new BridgeHttpError(400, "A non-empty user message is required", "missing_user_message")
  }
  const selected: string[] = []
  let remaining = maxChars
  for (const message of [...messages].reverse()) {
    const text = message.text.trim()
    if (text.length === 0) continue
    const label = message.role === "user" ? "USER" : "ASSISTANT"
    const prefix = `${label}:\n`
    const allowance = Math.max(0, remaining - prefix.length - 2)
    if (allowance === 0) break
    const clipped = text.length > allowance ? text.slice(text.length - allowance) : text
    const block = `${prefix}${clipped}`
    selected.push(block)
    remaining -= block.length + 2
    if (remaining <= 0) break
  }
  return [
    "This coding request came from the OpenCode Host UX.",
    "Treat the latest USER block as the current goal; earlier blocks are conversation context only.",
    ...selected.reverse(),
  ].join("\n\n")
}

function validateBridgeOptions(options: OpenCodeCodexBridgeOptions): void {
  if (options.workspaceRoot.trim().length === 0) throw new TypeError("Bridge workspace root must not be empty")
  if (options.codexModel.trim().length === 0) throw new TypeError("Bridge Codex model must not be empty")
  if (options.recordPath.trim().length === 0) throw new TypeError("Bridge record path must not be empty")
  if (options.maxBodyBytes !== undefined && (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)) {
    throw new TypeError("Bridge max body bytes must be a positive integer")
  }
}

function requireAuthorization(request: IncomingMessage, apiKey: string): void {
  const value = request.headers.authorization
  const expected = `Bearer ${apiKey}`
  if (typeof value !== "string") {
    throw new BridgeHttpError(401, "Bridge authorization is required", "unauthorized")
  }
  const actualBytes = Buffer.from(value)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new BridgeHttpError(401, "Bridge authorization is invalid", "unauthorized")
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) {
      throw new BridgeHttpError(413, "Bridge request body is too large", "body_too_large")
    }
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new BridgeHttpError(400, "Bridge request body must be valid JSON", "invalid_json")
  }
}

function parseChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (!isRecord(value) || typeof value.model !== "string" || !Array.isArray(value.messages)) {
    throw new BridgeHttpError(400, "Invalid chat completion request", "invalid_request")
  }
  const messages: ChatMessage[] = []
  for (const item of value.messages) {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant")) continue
    const text = readMessageText(item.content)
    if (text.length > 0) messages.push({ role: item.role, text })
  }
  return { model: value.model, stream: value.stream === true, messages }
}

function readMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) => {
    if (!isRecord(part)) return []
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      return [part.text]
    }
    return []
  }).join("\n")
}

function metadataTitle(messages: readonly ChatMessage[]): string {
  const source = [...messages].reverse().find((message) => message.role === "user")?.text ?? "Chaos Harness session"
  const compact = source.replace(/\s+/g, " ").trim()
  return (compact.length === 0 ? "Chaos Harness session" : compact).slice(0, 60)
}

function sendCompletion(
  response: ServerResponse,
  request: ChatCompletionRequest,
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  if (!request.stream) {
    sendJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage,
    })
    return
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  writeSse(response, {
    id,
    object: "chat.completion.chunk",
    created,
    model: request.model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  writeSse(response, {
    id,
    object: "chat.completion.chunk",
    created,
    model: request.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  })
  response.end("data: [DONE]\n\n")
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function sendError(response: ServerResponse, statusCode: number, message: string, code: string): void {
  sendJson(response, statusCode, {
    error: { message, type: "chaos_harness_error", code },
  })
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value))
}

function modelDescriptor(id: string): Record<string, unknown> {
  return { id, object: "model", created: 0, owned_by: OPENCODE_BRIDGE_PROVIDER }
}

function zeroUsage(): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
}

function parseExistingConfig(content: string | undefined): Record<string, unknown> {
  if (content === undefined || content.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) throw new Error("not an object")
    return parsed
  } catch {
    throw new TypeError("Existing OPENCODE_CONFIG_CONTENT must be a JSON object")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
