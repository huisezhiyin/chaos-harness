import { describe, expect, it, vi } from "vitest"
import { ModelProtocolError, type ModelStreamEvent } from "../../../kernel/src/index.js"
import { ChatStreamError, DeepSeekHttpError, IncompleteChatStreamError } from "../../deepseek/src/index.js"
import { ModelProfileError } from "../src/model-profiles.js"
import { summarizeModelFailure } from "../src/model-failure.js"
import { ModelSessionStoppedError } from "../src/private-stream-capture.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
import { startOpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"

const secret = "private-key-private-prompt"
const streamDiagnostics = { httpStatus: 200, contentType: "sse" as const, dataEvents: 2,
  finishObserved: false, usageObserved: true, textObserved: true, reasoningObserved: false,
  toolCallsObserved: 0, doneObserved: true }
describe("safe model failure diagnostics", () => {
  it.each([[false, "missing_done"], [true, "missing_done"], [false, "missing_finish"], [true, "missing_finish"]] as const)("preserves a stream failure after consuming a tool observation (stream=%s, code=%s)", async (stream, code) => {
    const events: QwenLoopJournalEvent[] = []
    let calls = 0
    const factory = vi.fn(() => ({ async *stream(): AsyncIterable<ModelStreamEvent> {
      calls++
      if (calls === 2) {
        if (stream) yield { type: "reasoning_delta", delta: "partial" }
        throw new ChatStreamError(code, { ...streamDiagnostics, doneObserved: code !== "missing_done" })
      }
      yield { type: "tool_call", call: { toolCallId: `read-${calls}`, name: "read", arguments: { filePath: "README.md" } } }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cost: 0 } }
      yield { type: "finish", reason: "tool_calls" }
    } }))
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace",
      profile: { model: "fake", baseUrl: "https://unused.invalid", apiKey: "unused" }, modelFactory: factory,
      recordEvent: async event => { events.push(event) } })
    const goal = { role: "user", content: "Inspect README" }
    const post = (messages: object[], token = bridge.apiKey) => fetch(`${bridge.baseUrl}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "code-agent", messages, stream,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }),
    })
    try {
      await (await post([goal])).text()
      const observed = [goal, { role: "tool", tool_call_id: "read-1", content: encodeOpenCodeToolObservation({
        token: bridge.observationToken, toolCallId: "read-1", ok: true, content: "README evidence",
      }) }]
      const failed = await post(observed)
      expect(failed.status).toBe(stream ? 200 : 422)
      expect(await failed.text()).toContain(`protocol:${code}`)
      const count = events.length
      for (let retry = 0; retry < 2; retry++) {
        const repeated = await post(observed)
        expect(repeated.status).toBe(422)
        const body = await repeated.text()
        expect(body).toContain(`protocol:${code}`)
        expect(body).not.toContain("observation_without_attempt")
        expect(body).not.toContain("README evidence")
      }
      expect((await post(observed, "wrong")).status).toBe(401)
      expect(events).toHaveLength(count)
      expect(events.filter(e => e.event === "action_observed")).toHaveLength(1)
      expect(events.filter(e => e.event === "attempt_finished")).toHaveLength(1)
      expect(events.filter(e => e.event === "mission_finished")).toHaveLength(1)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(calls).toBe(2)
      await (await post([{ role: "user", content: "Inspect another file" }])).text()
      const newCount = events.length
      expect((await post(observed)).status).toBe(422)
      expect(events).toHaveLength(newCount)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(calls).toBe(3)
    } finally { await bridge.close() }
  })

  it.each([
    [new DeepSeekHttpError(401, secret), "http", "http_error", 401],
    [new DeepSeekHttpError(500, secret), "http", "http_error", 500],
    [new TypeError("fetch failed", { cause: { code: "ECONNREFUSED", message: secret } }), "network", "ECONNREFUSED", undefined],
    [new ModelProtocolError(`DeepSeek SSE stream ended without usage ${secret}`), "protocol", "missing_usage", undefined],
    [new ChatStreamError("missing_finish", streamDiagnostics), "protocol", "missing_finish", undefined],
    [new ChatStreamError("missing_usage", { ...streamDiagnostics, usageObserved: false, finishObserved: true }), "protocol", "missing_usage", undefined],
    [new ChatStreamError("upstream_error", { ...streamDiagnostics, doneObserved: false }), "upstream", "upstream_error", undefined],
    [new ChatStreamError("upstream_error", { ...streamDiagnostics, doneObserved: false }, "insufficient_quota"), "upstream", "insufficient_quota", undefined],
    [new IncompleteChatStreamError({ httpStatus: 200, contentType: "json", dataEvents: 0,
      finishObserved: false, usageObserved: false, textObserved: false, reasoningObserved: false,
      toolCallsObserved: 0 }), "protocol", "missing_done", undefined],
    [new IncompleteChatStreamError({ httpStatus: 200, contentType: "sse", dataEvents: 1,
      finishObserved: true, usageObserved: false, textObserved: true, reasoningObserved: false,
      toolCallsObserved: 0 }, "insufficient_quota"), "upstream", "insufficient_quota", undefined],
    [new ModelProfileError(secret), "connection", "connection_check_failed", undefined],
    [new ModelSessionStoppedError(), "connection", "session_stopped", undefined],
    [new TypeError(secret), "local", "local_type_error", undefined],
  ])("exposes only classified metadata for %s", async (error, kind, code, status) => {
    const events: QwenLoopJournalEvent[] = []
    const factory = vi.fn(() => ({ async *stream(): AsyncIterable<ModelStreamEvent> { throw error } }))
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace",
      profile: { model: "fake", baseUrl: "https://unused.invalid", apiKey: "unused" }, modelFactory: factory,
      recordEvent: async event => { events.push(event) } })
    try {
      const response = await fetch(`${bridge.baseUrl}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "code-agent", messages: [{ role: "user", content: "Inspect README" }],
          tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }),
      })
      const body = await response.text()
      expect(response.status).toBe(422)
      expect(body).toContain(`${kind}:${code}`)
      if (code === "insufficient_quota") expect(body).toContain("上游分配额度已超限")
      if (code === "session_stopped") expect(body).toContain("当前会话已因先前模型错误停止")
      if (status) expect(body).toContain(`HTTP ${status}`)
      expect(body).not.toContain(secret)
      expect(factory).toHaveBeenCalledTimes(1)
      const repeated = await fetch(`${bridge.baseUrl}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "code-agent", messages: [{ role: "user", content: "Inspect README" }],
          tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }),
      })
      expect(repeated.status).toBe(422)
      expect(await repeated.text()).toBe(body)
      expect(factory).toHaveBeenCalledTimes(1)
      const terminal = events.find(event => event.event === "attempt_finished")
      expect(terminal).toMatchObject({ usageAvailable: false, turns: 1, actions: 0, modelFailure: { kind, code } })
      if (error instanceof ChatStreamError) {
        expect(terminal).toMatchObject({ modelFailure: { stream: error.diagnostics } })
      }
      expect(terminal).not.toHaveProperty("inputTokens")
      expect(terminal).not.toHaveProperty("outputTokens")
      expect(events.some(event => event.event === "recovery_started" || event.event === "action_proposed")).toBe(false)
      expect(JSON.stringify(events)).not.toContain(secret)
    } finally { await bridge.close() }
  })

  it("keeps only allowlisted source locations and rejects arbitrary message/status/code data", () => {
    const error = new Error(secret)
    error.stack = `${secret}\n    at request (/private/arbitrary-secret.ts:1:2)\n    at stream (/repo/model-profiles.ts:12:3)`
    expect(summarizeModelFailure(error)).toEqual({ kind: "local", code: "local_error", source: "model-profiles:12:3" })
    expect(summarizeModelFailure(new DeepSeekHttpError(9999, secret))).not.toHaveProperty("httpStatus")
    expect(JSON.stringify(summarizeModelFailure(new TypeError(secret, { cause: { code: secret } })))).not.toContain(secret)
  })
})
