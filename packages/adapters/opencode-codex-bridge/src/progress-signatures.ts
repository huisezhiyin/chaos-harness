import { createHash } from "node:crypto"
import type { JsonValue, ToolObservation, ToolProposal } from "../../../kernel/src/index.js"

export function progressDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

/** Canonicalize key order, not shell syntax: whitespace/quoting can change behavior. */
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key]!)]))
  }
  return value
}

export function progressSignatures(proposal: ToolProposal, observation: ToolObservation): {
  pairDigest: string; observationDigest: string; errorDigest?: string
} {
  // Only known diagnostic labels and ISO timestamps are normalized; do not erase
  // arbitrary numbers/UUIDs which may be actual task data or distinct failures.
  const content = observation.content.replace(/\r\n/g, "\n")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b(?:request[-_ ]id|trace[-_ ]id)\s*[:=]\s*[A-Za-z0-9_-]+/gi, "request-id=<id>")
  const observationDigest = progressDigest([observation.toolName, observation.ok, content, observation.errorCode ?? null])
  return {
    pairDigest: progressDigest([proposal.call.name, canonical(proposal.call.arguments), observationDigest]),
    observationDigest,
    ...(observation.ok ? {} : { errorDigest: progressDigest([observation.toolName, observation.errorCode ?? null, content]) }),
  }
}
