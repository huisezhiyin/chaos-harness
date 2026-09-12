import { mkdtemp, readFile, writeFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ModelPort, ModelRequest } from "../../../kernel/src/index.js"
import { startOpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { CHAOS_OBSERVATION_TOKEN_ENV, encodeOpenCodeToolObservation, decodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
import { CHAOS_TERMINAL_OBSERVATIONS_ENV, prepareTerminalObservations, HOST_PERMISSION_REJECTED,
  HOST_TOOL_ERROR, MAX_TERMINAL_OBSERVATIONS, MAX_TERMINAL_OBSERVATION_BYTES } from "../src/opencode-terminal-observations.js"

const token = "fake-observation-token-at-least-32-characters"
const envelope = (content = HOST_PERMISSION_REJECTED, toolCallId = "read-1", secret = token, ok = false) =>
  encodeOpenCodeToolObservation({ token: secret, toolCallId, content, ok })

describe("native terminal observations", () => {
  it("records signed fixed error tags from Host events without exposing raw error or environment capabilities", async () => {
    const spool = await prepareTerminalObservations()
    vi.stubEnv(CHAOS_OBSERVATION_TOKEN_ENV, token)
    vi.stubEnv(CHAOS_TERMINAL_OBSERVATIONS_ENV, spool.path)
    vi.resetModules()
    try {
      const { ChaosObservationBridgePlugin } = await import("../src/opencode-observation-plugin.js")
      const hook = await ChaosObservationBridgePlugin()
      expect(process.env[CHAOS_TERMINAL_OBSERVATIONS_ENV]).toBeUndefined()
      expect(process.env[CHAOS_OBSERVATION_TOKEN_ENV]).toBeUndefined()
      const emit = (status: string, error: string) => hook.event({ event: { type: "message.part.updated", properties: {
        part: { type: "tool", callID: "read-1", state: { status, error } },
      } } })
      await emit("running", "private-running-error")
      await emit("error", "The user rejected permission to use this specific tool call.")
      await emit("error", "private-error-and-path-and-command")
      const values = await spool.read()
      expect(values).toHaveLength(2)
      expect(decodeOpenCodeToolObservation(values[0]!, token, "read-1")).toEqual({ ok: false, content: HOST_PERMISSION_REJECTED })
      expect(decodeOpenCodeToolObservation(values[1]!, token, "read-1")).toEqual({ ok: false, content: HOST_TOOL_ERROR })
      expect(await readFile(spool.path, "utf8")).not.toMatch(/private-|The user rejected/)
      for (let i = 0; i < 300; i++) await emit("error", "error")
      expect(await spool.read()).toHaveLength(MAX_TERMINAL_OBSERVATIONS)
    } finally { vi.unstubAllEnvs(); await spool.dispose() }
  })

  it("bounds and parses the private spool without trusting malformed records", async () => {
    const spool = await prepareTerminalObservations()
    try {
      await writeFile(spool.path, 'not-json\n{}\n' + JSON.stringify(envelope()) + '\n')
      expect(await spool.read()).toEqual([envelope()])
      await writeFile(spool.path, "x".repeat(MAX_TERMINAL_OBSERVATIONS * MAX_TERMINAL_OBSERVATION_BYTES + 1))
      expect(await spool.read()).toEqual([])
    } finally { await spool.dispose() }
  })

  it.each(["valid", "wrong-call", "wrong-token", "unsigned", "success", "unknown-tag", "already-observed"])(
    "only records a pending authenticated error at exit, never resumes a model (%s)", async kind => {
      const events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
      const model: ModelPort = { async *stream(request) {
        requests.push(request)
        if (request.turn === 1) {
          yield { type: "tool_call", call: { toolCallId: "read-1", name: "read", arguments: { filePath: "README.md" } } }
          yield { type: "finish", reason: "tool_calls" }
        } else {
          yield { type: "text_delta", delta: "Read complete" }
          yield { type: "finish", reason: "stop" }
        }
      } }
      const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-terminal-test-")))
      await writeFile(join(root, "README.md"), "fixture")
      const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: root, workspaceBoundary: "root-only",
        profile: { apiKey: "fake", model: "fake", baseUrl: "https://unused.invalid" },
        observationToken: token, modelFactory: () => model, recordEvent: async e => { events.push(e) },
      })
      const send = (messages: unknown[]) => fetch(bridge.baseUrl + "/chat/completions", { method: "POST",
        headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "code-agent", messages, tools: [{ type: "function", function: {
          name: "read", description: "read", parameters: { type: "object", properties: {} },
        } }] }),
      })
      try {
        const user = { role: "user", content: "Read README and summarize; do not modify files." }
        const first = await send([user]); expect(first.status).toBe(200)
        expect((await first.json() as any).choices[0].message.tool_calls[0].id).toBe("read-1")
        expect(requests[0]?.messages[0]?.content).toContain("temporary consumers")
        if (kind === "already-observed") {
          const next = await send([user, { role: "tool", tool_call_id: "read-1", content: envelope("Read okay", "read-1", token, true) }])
          expect(next.status).toBe(200); await next.json()
        }
        const encoded = kind === "wrong-call" ? envelope(HOST_TOOL_ERROR, "old-call")
          : kind === "wrong-token" ? envelope(HOST_TOOL_ERROR, "read-1", "wrong-key")
          : kind === "unsigned" ? HOST_PERMISSION_REJECTED : kind === "success" ? envelope(HOST_TOOL_ERROR, "read-1", token, true)
          : kind === "unknown-tag" ? envelope("private-raw-error") : envelope()
        const callsBeforeClose = requests.length
        await bridge.close([encoded, encoded])
        await bridge.close([encoded])
        expect(requests).toHaveLength(callsBeforeClose)
        expect(events.filter(e => e.event === "host_terminal_observation_received")).toHaveLength(kind === "valid" ? 1 : 0)
        if (kind === "valid") {
          expect(events.find(e => e.event === "host_terminal_observation_received")).toMatchObject({ action: "read", ok: false, hostTerminalError: HOST_PERMISSION_REJECTED })
          expect(events.filter(e => e.event === "action_observed")).toHaveLength(0)
          expect(events.find(e => e.event === "mission_finished")).toMatchObject({ outcome: "cancelled", reason: "host_exit" })
        }
        expect(JSON.stringify(events)).not.toContain(token)
        expect(JSON.stringify(events)).not.toContain("private-raw-error")
      } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
    })
})
