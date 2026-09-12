import type { JsonValue } from "../../../kernel/src/index.js"

export type CodexAppServerFailureKind =
  | "configuration"
  | "startup"
  | "transport"
  | "protocol"
  | "overloaded"
  | "timeout"
  | "aborted"
  | "process_exit"
  | "shutdown"

export class CodexAppServerError extends Error {
  readonly kind: CodexAppServerFailureKind
  readonly retryable: boolean

  constructor(kind: CodexAppServerFailureKind, message: string, retryable = false) {
    super(message)
    this.name = "CodexAppServerError"
    this.kind = kind
    this.retryable = retryable
  }
}

export class CodexAppServerRpcError extends CodexAppServerError {
  readonly code: number
  readonly data: JsonValue | undefined

  constructor(code: number, message: string, data?: JsonValue) {
    super(code === -32001 ? "overloaded" : "protocol", message, code === -32001)
    this.name = "CodexAppServerRpcError"
    this.code = code
    this.data = data
  }
}

export function abortedError(): CodexAppServerError {
  return new CodexAppServerError("aborted", "Codex app-server request was aborted")
}
