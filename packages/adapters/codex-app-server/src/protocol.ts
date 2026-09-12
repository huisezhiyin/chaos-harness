import type { JsonValue } from "../../../kernel/src/index.js"

export type CodexRequestId = string | number

export interface CodexClientRequest {
  id: CodexRequestId
  method: string
  params?: JsonValue
}

export interface CodexClientNotification {
  method: string
  params?: JsonValue
}

export interface CodexServerResponse {
  id: CodexRequestId
  result: JsonValue
}

export interface CodexRpcErrorBody {
  code: number
  message: string
  data?: JsonValue
}

export interface CodexServerErrorResponse {
  id: CodexRequestId
  error: CodexRpcErrorBody
}

export interface CodexServerRequest {
  id: CodexRequestId
  method: string
  params?: JsonValue
}

export interface CodexServerNotification {
  method: string
  params?: JsonValue
}

export type CodexWireMessage =
  | { kind: "response"; message: CodexServerResponse }
  | { kind: "error"; message: CodexServerErrorResponse }
  | { kind: "request"; message: CodexServerRequest }
  | { kind: "notification"; message: CodexServerNotification }

export interface CodexInitializeResponse {
  codexHome: string
  platformFamily: string
  platformOs: string
  userAgent: string
}

export function decodeCodexWireMessage(value: unknown): CodexWireMessage | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const id = readRequestId(value.id)
  const method = typeof value.method === "string" ? value.method : undefined

  if (id !== undefined && "result" in value && isJsonValue(value.result)) {
    return { kind: "response", message: { id, result: value.result } }
  }
  if (id !== undefined && isRpcErrorBody(value.error)) {
    return { kind: "error", message: { id, error: value.error } }
  }
  if (id !== undefined && method !== undefined) {
    const params = optionalJsonValue(value.params)
    return {
      kind: "request",
      message: params === undefined ? { id, method } : { id, method, params },
    }
  }
  if (id === undefined && method !== undefined) {
    const params = optionalJsonValue(value.params)
    return {
      kind: "notification",
      message: params === undefined ? { method } : { method, params },
    }
  }
  return undefined
}

export function decodeInitializeResponse(value: unknown): CodexInitializeResponse | undefined {
  if (
    !isRecord(value) ||
    typeof value.codexHome !== "string" ||
    typeof value.platformFamily !== "string" ||
    typeof value.platformOs !== "string" ||
    typeof value.userAgent !== "string"
  ) {
    return undefined
  }
  return {
    codexHome: value.codexHome,
    platformFamily: value.platformFamily,
    platformOs: value.platformOs,
    userAgent: value.userAgent,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function optionalJsonValue(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : isJsonValue(value) ? value : undefined
}

function readRequestId(value: unknown): CodexRequestId | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value))
    ? value
    : undefined
}

function isRpcErrorBody(value: unknown): value is CodexRpcErrorBody {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isInteger(value.code) &&
    typeof value.message === "string" &&
    (value.data === undefined || isJsonValue(value.data))
  )
}
