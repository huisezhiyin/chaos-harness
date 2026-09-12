import {
  ModelProtocolError,
  type JsonObject,
  type ModelFinishReason,
  type ModelPort,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
} from "../../../kernel/src/index.js"
import { mapChatRequest, type ChatWireOptions } from "./openai-chat-mapper.js"
import { readSseData } from "./sse.js"

export interface DeepSeekChatModelPortOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  maxTokens?: number
  providerLabel?: string
  enableThinking?: boolean
  wire?: ChatWireOptions
  fetch?: typeof fetch
  /** Original client identity when this transport is an intermediary. */
  forwardedUserAgent?: string
}

export class DeepSeekHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string, providerLabel = "DeepSeek") {
    super(`${providerLabel} HTTP ${status}: ${message}`)
    this.name = "DeepSeekHttpError"
    this.status = status
  }
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

export interface ChatStreamDiagnostics {
  httpStatus: number
  contentType: "sse" | "json" | "other" | "missing"
  dataEvents: number
  finishObserved: boolean
  usageObserved: boolean
  textObserved: boolean
  reasoningObserved: boolean
  toolCallsObserved: number
  /** Optional for historical callers; new transport diagnostics always include it. */
  doneObserved?: boolean
}

export type ChatStreamErrorCode = "missing_done" | "missing_finish" | "missing_usage" | "upstream_error"

export class ChatStreamError extends ModelProtocolError {
  readonly diagnostics: Readonly<ChatStreamDiagnostics>
  constructor(readonly code: ChatStreamErrorCode, diagnostics: ChatStreamDiagnostics,
    readonly upstreamCode?: "insufficient_quota") {
    const messages: Record<ChatStreamErrorCode, string> = {
      missing_done: "DeepSeek SSE stream ended without [DONE]",
      missing_finish: "DeepSeek SSE stream ended without finish reason",
      missing_usage: "DeepSeek SSE stream ended without usage",
      upstream_error: "Chat SSE stream reported an upstream error",
    }
    super(messages[code])
    this.diagnostics = Object.freeze({ ...diagnostics })
  }
}

export class IncompleteChatStreamError extends ChatStreamError {
  constructor(diagnostics: ChatStreamDiagnostics, upstreamCode?: "insufficient_quota") {
    super("missing_done", diagnostics, upstreamCode)
  }
}

export class DeepSeekChatModelPort implements ModelPort {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #model: string
  readonly #maxTokens: number | undefined
  readonly #providerLabel: string
  readonly #enableThinking: boolean
  readonly #fetch: typeof fetch
  readonly #wire: ChatWireOptions | undefined
  readonly #forwardedUserAgent: string | undefined

  constructor(options: DeepSeekChatModelPortOptions) {
    this.#apiKey = nonEmpty(options.apiKey, "DeepSeek API key")
    this.#baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "")
    this.#model = nonEmpty(options.model ?? "deepseek-v4-flash", "DeepSeek model")
    this.#maxTokens = options.maxTokens
    this.#providerLabel = nonEmpty(options.providerLabel ?? "DeepSeek", "Provider label")
    this.#enableThinking = options.enableThinking === true
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#wire = options.wire === undefined ? undefined : Object.freeze({ ...options.wire })
    const userAgent = options.forwardedUserAgent
    if (userAgent !== undefined && (!userAgent.length || userAgent.length > 512 || /[^\x20-\x7e]/.test(userAgent))) {
      throw new Error("Invalid forwarded client metadata")
    }
    this.#forwardedUserAgent = userAgent
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const body = mapChatRequest(request, this.#model, this.#maxTokens, this.#enableThinking, this.#wire)
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
        ...(this.#forwardedUserAgent === undefined ? {} : {
          "user-agent": this.#forwardedUserAgent,
          via: "1.1 chaos-harness",
        }),
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    })

    if (!response.ok) {
      const rawMessage = (await response.text()).slice(0, 1_000)
      const sanitized = rawMessage.replaceAll(this.#apiKey, "[REDACTED]")
      throw new DeepSeekHttpError(response.status, sanitized || response.statusText, this.#providerLabel)
    }
    if (response.body === null) {
      throw new ModelProtocolError("DeepSeek streaming response has no body")
    }

    const toolCalls = new Map<number, ToolCallAccumulator>()
    let usage: ModelUsage | undefined
    let finishReason: ModelFinishReason | undefined
    let sawDone = false
    let dataEvents = 0
    let textObserved = false
    let reasoningObserved = false
    let diagnosticText = ""
    let diagnosticTextOverflow = false
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    const diagnostics = (): ChatStreamDiagnostics => ({
      httpStatus: response.status,
      contentType: !mediaType ? "missing" : mediaType === "text/event-stream" ? "sse"
        : mediaType === "application/json" ? "json" : "other",
      dataEvents, finishObserved: finishReason !== undefined, usageObserved: usage !== undefined,
      textObserved, reasoningObserved, toolCallsObserved: toolCalls.size, doneObserved: sawDone,
    })

    for await (const data of readSseData(response.body, signal)) {
      if (data === "[DONE]") {
        sawDone = true
        break
      }
      dataEvents++

      const chunk = parseJsonRecord(data, "DeepSeek SSE chunk")
      // A top-level transport error must win over any completion fields, even
      // after a finish chunk. Never forward its untrusted message or release tools.
      if (chunk.error !== undefined && chunk.error !== null) {
        const error = chunk.error
        const upstreamCode = typeof error === "object" && !Array.isArray(error) &&
          error.code === "insufficient_quota" && error.type === "insufficient_quota"
          ? "insufficient_quota" : undefined
        throw new ChatStreamError("upstream_error", diagnostics(), upstreamCode)
      }
      if (chunk.usage !== null && chunk.usage !== undefined) {
        usage = parseUsage(chunk.usage)
      }

      const choices = optionalArray(chunk.choices, "choices")
      for (const rawChoice of choices) {
        const choice = record(rawChoice, "choice")
        const index = integer(choice.index, "choice.index")
        if (index !== 0) {
          throw new ModelProtocolError(`unsupported DeepSeek choice index: ${index}`)
        }
        const delta = record(choice.delta, "choice.delta")
        if (delta.reasoning_details !== undefined && delta.reasoning_details !== null &&
            (!Array.isArray(delta.reasoning_details) || delta.reasoning_details.length > 0)) {
          throw new ModelProtocolError("Structured reasoning continuation is not supported by this chat adapter")
        }
        const reasoning = optionalString(delta.reasoning_content, "choice.delta.reasoning_content")
          ?? optionalString(delta.reasoning, "choice.delta.reasoning")
        if (reasoning !== undefined && reasoning.length > 0) {
          reasoningObserved = true
          yield { type: "reasoning_delta", delta: reasoning }
        }
        const content = optionalString(delta.content, "choice.delta.content")
        if (content !== undefined && content.length > 0) {
          textObserved = true
          if (!diagnosticTextOverflow) {
            if (diagnosticText.length + content.length <= 8192) diagnosticText += content
            else { diagnosticText = ""; diagnosticTextOverflow = true }
          }
          yield { type: "text_delta", delta: content }
        }
        collectToolCallDeltas(delta.tool_calls, toolCalls)

        const wireFinish = optionalString(choice.finish_reason, "choice.finish_reason")
        if (wireFinish !== undefined) {
          finishReason = normalizeFinishReason(wireFinish)
        }
      }
    }

    if (!sawDone) {
      let upstreamCode: "insufficient_quota" | undefined
      if (!diagnosticTextOverflow && !reasoningObserved && toolCalls.size === 0 && finishReason !== undefined && usage === undefined) {
        try {
          const envelope = JSON.parse(diagnosticText)
          if (envelope?.error?.code === "insufficient_quota" && envelope.error.type === "insufficient_quota") upstreamCode = "insufficient_quota"
        } catch { /* An incomplete stream need not contain a structured upstream error. */ }
      }
      throw new IncompleteChatStreamError(diagnostics(), upstreamCode)
    }
    if (finishReason === undefined) {
      throw new ChatStreamError("missing_finish", diagnostics())
    }
    if (usage === undefined) {
      throw new ChatStreamError("missing_usage", diagnostics())
    }

    for (const [index, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      if (call.id.length === 0 || call.name.length === 0) {
        throw new ModelProtocolError(`incomplete DeepSeek tool call at index ${index}`)
      }
      const parsedArguments = parseJsonRecord(call.arguments, `tool call ${call.id} arguments`)
      yield {
        type: "tool_call",
        call: {
          toolCallId: call.id,
          name: call.name,
          arguments: parsedArguments,
        },
      }
    }
    yield { type: "usage", usage }
    yield { type: "finish", reason: finishReason }
  }
}

// The wire implementation is OpenAI Chat Completions compatible. Keep the
// historical DeepSeek export while allowing other compatible providers to use
// an accurate adapter name.
export { DeepSeekChatModelPort as OpenAICompatibleChatModelPort }

function collectToolCallDeltas(
  value: unknown,
  calls: Map<number, ToolCallAccumulator>,
): void {
  if (value === null || value === undefined) {
    return
  }
  if (!Array.isArray(value)) {
    throw new ModelProtocolError("choice.delta.tool_calls must be an array")
  }
  for (const rawDelta of value) {
    const delta = record(rawDelta, "tool call delta")
    const index = integer(delta.index, "tool call delta.index")
    const current = calls.get(index) ?? { id: "", name: "", arguments: "" }
    const id = optionalString(delta.id, "tool call delta.id")
    if (id !== undefined) {
      current.id += id
    }
    if (delta.function !== null && delta.function !== undefined) {
      const fn = record(delta.function, "tool call delta.function")
      const name = optionalString(fn.name, "tool call delta.function.name")
      const args = optionalString(fn.arguments, "tool call delta.function.arguments")
      if (name !== undefined) {
        current.name += name
      }
      if (args !== undefined) {
        current.arguments += args
      }
    }
    calls.set(index, current)
  }
}

function parseUsage(value: unknown): ModelUsage {
  const usage = record(value, "usage")
  let reasoningTokens: number | undefined
  let cacheReadTokens: number | undefined
  let cacheWriteTokens: number | undefined
  if (usage.completion_tokens_details !== undefined && usage.completion_tokens_details !== null) {
    const details = record(usage.completion_tokens_details, "usage.completion_tokens_details")
    if (details.reasoning_tokens !== undefined && details.reasoning_tokens !== null) {
      reasoningTokens = integer(details.reasoning_tokens, "usage.completion_tokens_details.reasoning_tokens")
    }
  }
  if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    const details = record(usage.prompt_tokens_details, "usage.prompt_tokens_details")
    if (details.cached_tokens !== undefined && details.cached_tokens !== null) {
      cacheReadTokens = integer(details.cached_tokens, "usage.prompt_tokens_details.cached_tokens")
    }
    if (details.cache_creation_input_tokens !== undefined && details.cache_creation_input_tokens !== null) {
      cacheWriteTokens = integer(
        details.cache_creation_input_tokens,
        "usage.prompt_tokens_details.cache_creation_input_tokens",
      )
    }
  }
  return {
    inputTokens: integer(usage.prompt_tokens, "usage.prompt_tokens"),
    outputTokens: integer(usage.completion_tokens, "usage.completion_tokens"),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    cost: 0,
  }
}

function normalizeFinishReason(value: string): ModelFinishReason {
  switch (value) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return value
    case "insufficient_system_resource":
    default:
      return "error"
  }
}

function parseJsonRecord(value: string, label: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new ModelProtocolError(`${label} is not valid JSON`)
  }
  return record(parsed, label) as JsonObject
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelProtocolError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new ModelProtocolError(`${label} must be an array`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "string") {
    throw new ModelProtocolError(`${label} must be a string`)
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ModelProtocolError(`${label} must be a non-negative integer`)
  }
  return value
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
  return value
}
