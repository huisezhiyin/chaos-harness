import { openSync, writeSync, closeSync, constants } from "node:fs"
import { CHAOS_TERMINAL_OBSERVATIONS_ENV, HOST_PERMISSION_REJECTED, HOST_TOOL_ERROR,
  MAX_TERMINAL_OBSERVATIONS, MAX_TERMINAL_OBSERVATION_BYTES } from "./opencode-terminal-observations.js"
import {
  CHAOS_OBSERVATION_TOKEN_ENV,
  encodeOpenCodeToolObservation,
} from "./opencode-observation-envelope.js"

interface OpenCodeToolPart {
  type: "tool"
  callID: string
  state: {
    status: string
    error?: string
    output?: string
  }
}

interface OpenCodeMessage {
  parts: Array<OpenCodeToolPart | { type: string }>
}

let cachedObservationToken: string | undefined
let cachedTerminalPath: string | undefined
let terminalCount = 0

export const ChaosObservationBridgePlugin = async () => {
  const token = cachedObservationToken ?? process.env[CHAOS_OBSERVATION_TOKEN_ENV]?.trim()
  if (token === undefined || token.length < 32) {
    throw new Error("Chaos observation bridge token is missing or invalid")
  }
  cachedObservationToken = token
  delete process.env[CHAOS_OBSERVATION_TOKEN_ENV]
  const terminalPath = cachedTerminalPath ?? process.env[CHAOS_TERMINAL_OBSERVATIONS_ENV]
  cachedTerminalPath = terminalPath
  delete process.env[CHAOS_TERMINAL_OBSERVATIONS_ENV]

  return {
    // Unlike messages.transform this also runs when the native Host stops on denial.
    // Persist only authenticated fixed tags. Never resume the Host or answer permissions.
    event: async ({ event }: { event: { type: string; properties?: { part?: OpenCodeToolPart | { type: string } } } }) => {
      if (!terminalPath || event.type !== "message.part.updated" || !event.properties?.part ||
          terminalCount >= MAX_TERMINAL_OBSERVATIONS) return
      const observation = readTerminalObservation(event.properties.part)
      if (!observation || observation.ok) return
      const content = observation.content === "The user rejected permission to use this specific tool call."
        ? HOST_PERMISSION_REJECTED : HOST_TOOL_ERROR
      const line = JSON.stringify(encodeOpenCodeToolObservation({ token, toolCallId: observation.part.callID,
        ok: false, content })) + "\n"
      if (Buffer.byteLength(line) > MAX_TERMINAL_OBSERVATION_BYTES) return
      terminalCount++
      // Synchronous append completes before this event callback returns, including at exit.
      // Diagnostic I/O failure must not change native permission or tool behavior.
      try {
        const fd = openSync(terminalPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
        try { writeSync(fd, line) } finally { closeSync(fd) }
      } catch { /* unavailable evidence */ }
    },
    "experimental.chat.messages.transform": async (
      _input: object,
      output: { messages: OpenCodeMessage[] },
    ): Promise<void> => {
      for (const message of output.messages) {
        for (const part of message.parts) {
          const observation = readTerminalObservation(part)
          if (observation === undefined) continue
          const encoded = encodeOpenCodeToolObservation({
            token,
            toolCallId: observation.part.callID,
            ok: observation.ok,
            content: observation.content,
          })
          if (observation.ok) observation.part.state.output = encoded
          else observation.part.state.error = encoded
        }
      }
    },
  }
}

function readTerminalObservation(
  part: OpenCodeToolPart | { type: string },
): { part: OpenCodeToolPart; ok: boolean; content: string } | undefined {
  if (part.type !== "tool" || !("callID" in part) || typeof part.callID !== "string" || !("state" in part)) {
    return undefined
  }
  if (part.state.status === "completed" && typeof part.state.output === "string") {
    return { part, ok: true, content: part.state.output }
  }
  if (part.state.status === "error" && typeof part.state.error === "string") {
    return { part, ok: false, content: part.state.error }
  }
  return undefined
}
