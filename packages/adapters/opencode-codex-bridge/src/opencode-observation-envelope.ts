import { createHmac, timingSafeEqual } from "node:crypto"

export const CHAOS_OBSERVATION_TOKEN_ENV = "CHAOS_HARNESS_OBSERVATION_TOKEN"
export const CHAOS_TOOL_OBSERVATION_ENVELOPE_PREFIX = "__CHAOS_TOOL_OBSERVATION_V1__:"

export class OpenCodeObservationEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenCodeObservationEnvelopeError"
  }
}

export function encodeOpenCodeToolObservation(options: {
  token: string
  toolCallId: string
  ok: boolean
  content: string
}): string {
  let existing: { ok: boolean; content: string } | undefined
  try {
    existing = decodeOpenCodeToolObservation(options.content, options.token, options.toolCallId)
  } catch (error) {
    if (!(error instanceof OpenCodeObservationEnvelopeError)) throw error
  }
  const content = existing?.content ?? options.content
  const ok = existing?.ok ?? options.ok
  const header = Buffer.from(JSON.stringify({
    toolCallId: options.toolCallId,
    ok,
    mac: observationMac(options.token, options.toolCallId, ok, content),
  })).toString("base64url")
  return `${CHAOS_TOOL_OBSERVATION_ENVELOPE_PREFIX}${header}\n${content}`
}

export function decodeOpenCodeToolObservation(
  value: string,
  token: string,
  expectedToolCallId: string,
): { ok: boolean; content: string } | undefined {
  if (!value.startsWith(CHAOS_TOOL_OBSERVATION_ENVELOPE_PREFIX)) return undefined
  const newline = value.indexOf("\n", CHAOS_TOOL_OBSERVATION_ENVELOPE_PREFIX.length)
  if (newline === -1) throw new OpenCodeObservationEnvelopeError("Tool observation envelope is incomplete")

  const encodedHeader = value.slice(CHAOS_TOOL_OBSERVATION_ENVELOPE_PREFIX.length, newline)
  const content = value.slice(newline + 1)
  let header: unknown
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))
  } catch {
    throw new OpenCodeObservationEnvelopeError("Tool observation envelope header is invalid")
  }
  if (
    !isRecord(header)
    || header.toolCallId !== expectedToolCallId
    || typeof header.ok !== "boolean"
    || typeof header.mac !== "string"
  ) {
    throw new OpenCodeObservationEnvelopeError("Tool observation envelope does not match the pending Action")
  }
  const expected = observationMac(token, expectedToolCallId, header.ok, content)
  if (!safeEqual(header.mac, expected)) {
    throw new OpenCodeObservationEnvelopeError("Tool observation envelope authentication failed")
  }
  return { ok: header.ok, content }
}

function observationMac(token: string, toolCallId: string, ok: boolean, content: string): string {
  return createHmac("sha256", token)
    .update(toolCallId)
    .update("\0")
    .update(ok ? "ok" : "error")
    .update("\0")
    .update(content)
    .digest("base64url")
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
