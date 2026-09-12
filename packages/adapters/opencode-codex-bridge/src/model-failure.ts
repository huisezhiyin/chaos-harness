import { ModelProtocolError } from "../../../kernel/src/index.js"
import { DeepSeekHttpError, ChatStreamError, type ChatStreamDiagnostics } from "../../deepseek/src/index.js"
import { ModelProfileError } from "./model-profiles.js"
import { ModelSessionStoppedError } from "./private-stream-capture.js"

export interface ModelFailureSummary {
  kind: "http" | "network" | "protocol" | "connection" | "local" | "upstream"
  code: string
  httpStatus?: number
  source?: string
  stream?: Readonly<ChatStreamDiagnostics>
}

/** Deliberate allowlists: raw messages may contain response bodies or credentials. */
export function summarizeModelFailure(error: unknown): ModelFailureSummary {
  let failure: ModelFailureSummary
  if (error instanceof DeepSeekHttpError) {
    failure = { kind: "http", code: "http_error",
      ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}),
    }
  } else if (error instanceof ModelSessionStoppedError) {
    failure = { kind: "connection", code: "session_stopped" }
  } else if (error instanceof ModelProfileError) {
    failure = { kind: "connection", code: "connection_check_failed" }
  } else if (error instanceof ChatStreamError && error.upstreamCode === "insufficient_quota") {
    failure = { kind: "upstream", code: "insufficient_quota", stream: error.diagnostics }
  } else if (error instanceof ChatStreamError) {
    failure = { kind: error.code === "upstream_error" ? "upstream" : "protocol",
      code: error.code, stream: error.diagnostics }
  } else if (error instanceof ModelProtocolError) {
    const code = error.message.includes("without usage") ? "missing_usage"
      : error.message.includes("without [DONE]") ? "missing_done"
      : error.message.includes("without finish reason") ? "missing_finish"
      : error.message.includes("Structured reasoning continuation") ? "unsupported_reasoning"
      : "invalid_model_response"
    failure = { kind: "protocol", code }
  } else {
    const cause = error instanceof Error && error.cause && typeof error.cause === "object"
      ? error.cause as { code?: unknown; message?: unknown } : undefined
    const code = cause?.code ?? (error && typeof error === "object" && "code" in error ? error.code : undefined)
    const networkCodes = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]
    if (typeof code === "string" && networkCodes.includes(code)) failure = { kind: "network", code }
    else if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) failure = { kind: "network", code: "request_interrupted" }
    else if (error instanceof TypeError && error.message === "fetch failed") failure = { kind: "network", code: "fetch_failed" }
    else failure = { kind: "local", code: error instanceof TypeError ? "local_type_error" : "local_error" }
  }
  // Only locations inside our model path, never the message line or arbitrary stack paths.
  const frames = error instanceof Error ? (error.stack ?? "").split("\n").filter(line => /^\s+at\s/.test(line)) : []
  const allowedSource = /\/(model-profiles|token-switch-profile|deepseek-chat-model-port|openai-chat-mapper|qwen-loop-bridge)\.(?:ts|js):(\d+):(\d+)\)?$/
  for (const frame of frames) {
    const match = allowedSource.exec(frame)
    if (match) return { ...failure, source: `${match[1]}:${match[2]}:${match[3]}` }
  }
  return failure
}

export function modelFailureDescription(failure: ModelFailureSummary | undefined): string {
  if (!failure) return ""
  if (failure.kind === "connection" && failure.code === "session_stopped") return " [connection:session_stopped — 当前会话已因先前模型错误停止；请先处理原始错误，再重新启动会话]"
  if (failure.kind === "upstream" && failure.code === "insufficient_quota") return " [upstream:insufficient_quota — 上游分配额度已超限]"
  return ` [${failure.kind}:${failure.code}${failure.httpStatus === undefined ? "" : ` HTTP ${failure.httpStatus}`}${failure.source ? ` at ${failure.source}` : ""}]`
}
