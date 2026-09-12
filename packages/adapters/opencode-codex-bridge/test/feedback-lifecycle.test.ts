import { describe, expect, it, vi } from "vitest"
import type { ModelPort, ModelRequest, ModelStreamEvent } from "../../../kernel/src/index.js"
import { startOpenCodeQwenLoopBridge, type OpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { parseLocalFeedback } from "../src/feedback.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"

const survey = ["─".repeat(35), "**How is the agent doing this session? (optional)**", "─".repeat(35),
  "**1** Bad  **2** Fine  **3** Good  0 Dismiss", "_Type a number + Enter to submit, or just send a message to skip_", "─".repeat(35)].join("\n")
const profile = { apiKey: "fake", baseUrl: "http://unused.invalid", model: "fake" }
const tools = [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } }]
const user = (content: string) => ({ role: "user", content })
const post = (bridge: OpenCodeQwenLoopBridge, messages: unknown[], signal?: AbortSignal) => fetch(`${bridge.baseUrl}/chat/completions`, {
  method: "POST", headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "code-agent", messages, tools }), ...(signal ? { signal } : {}),
})
function model(requests: ModelRequest[] = []): ModelPort {
  return { async *stream(request): AsyncIterable<ModelStreamEvent> {
    requests.push(request)
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cost: 0 } }
    if (request.turn === 1) {
      yield { type: "tool_call", call: { toolCallId: "read-1", name: "read", arguments: { filePath: "README.md" } } }
      yield { type: "finish", reason: "tool_calls" }
    } else {
      yield { type: "text_delta", delta: "Inspected." }
      yield { type: "finish", reason: "stop" }
    }
  } }
}
const observation = (bridge: OpenCodeQwenLoopBridge) => ({ role: "tool", tool_call_id: "read-1",
  content: encodeOpenCodeToolObservation({ token: bridge.observationToken, toolCallId: "read-1", ok: true, content: "README evidence" }) })

describe("feedback is separate from task admission", () => {
  it("recognizes only explicit feedback commands and the complete legacy survey shape", () => {
    expect(parseLocalFeedback(`${survey}2`)).toEqual({ source: "legacy_survey", disposition: "rated", score: 2 })
    expect(parseLocalFeedback(survey)).toMatchObject({ disposition: "prompt_only" })
    expect(parseLocalFeedback("/chaos-feedback 0")).toMatchObject({ disposition: "dismissed" })
    for (const input of ["2", "0", "Please fix the feedback plugin", `${survey}\nPlease fix the tests`, "/chaos-feedback 9"]) {
      expect(parseLocalFeedback(input)).toBeUndefined()
    }
  })

  it("records a rating without a model or Mission, then excludes it from a real task's context", async () => {
    const events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
    const factory = vi.fn(() => model(requests))
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile,
      modelFactory: factory, recordEvent: async event => { events.push(event) } })
    try {
      const response = await post(bridge, [user(`${survey}2`)])
      expect(response.status).toBe(200)
      expect((await response.json() as any).usage.total_tokens).toBe(0)
      expect(factory).not.toHaveBeenCalled()
      expect(events).toEqual([{ event: "feedback_recorded", source: "legacy_survey", disposition: "rated", score: 2, binding: "unbound",
        profile: "qwen", adapter: "chat-api", provider: "dashscope", model: "fake", controlDepth: "model-tool-turn" }])
      const invalid = await post(bridge, [user("/chaos-feedback 9")])
      expect(invalid.status).toBe(400); await invalid.text()
      expect(factory).not.toHaveBeenCalled()
      await (await post(bridge, [user(`${survey}2`), user("Inspect README")])).json()
      expect(JSON.stringify(requests)).not.toContain("How is the agent")
      expect(events.filter(e => e.event === "mission_started")).toHaveLength(1)
      await (await post(bridge, [user("Inspect README"), observation(bridge)])).json()
      const rating = await post(bridge, [user("/chaos-feedback 3")])
      await rating.json()
      expect(events.at(-1)).toMatchObject({ event: "feedback_recorded", binding: "mission", score: 3 })
      expect(events.filter(e => e.event === "mission_started")).toHaveLength(1)
    } finally { await bridge.close() }
    expect(events.filter(e => e.event === "mission_finished")).toEqual([expect.objectContaining({ outcome: "succeeded" })])
  })

  it("offers an authenticated model-free feedback endpoint and rejects free-form payloads", async () => {
    const factory = vi.fn(() => model()), events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile, modelFactory: factory,
      recordEvent: async e => { events.push(e) } })
    try {
      for (const [payload, authorization, status] of [
        [{ score: 2 }, "invalid", 401], [{ score: "2" }, bridge.apiKey, 400],
        [{ score: 2, text: "private content" }, bridge.apiKey, 400], [{ score: 2 }, bridge.apiKey, 200],
      ] as const) {
        const response = await fetch(`${bridge.baseUrl}/feedback`, { method: "POST",
          headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" }, body: JSON.stringify(payload) })
        expect(response.status).toBe(status); await response.text()
      }
      expect(factory).not.toHaveBeenCalled()
      expect(events).toHaveLength(1)
      expect(JSON.stringify(events)).not.toContain("private content")
    } finally { await bridge.close() }
  })
})

describe("host cancellation accounting", () => {
  it("closes a pending verification checkpoint on host exit without another Attempt", async () => {
    const events: QwenLoopJournalEvent[] = []
    const finalOnly: ModelPort = { async *stream() {
      yield { type: "text_delta", delta: "No evidence" }
      yield { type: "finish", reason: "stop" }
    } }
    const factory = vi.fn(() => finalOnly)
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile, modelFactory: factory,
      recordEvent: async e => { events.push(e) } })
    await (await post(bridge, [user("Inspect README")])).json()
    expect(events.at(-1)).toMatchObject({ event: "unit_finished", outcome: "verification_pending" })
    await bridge.close()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(events.filter(e => e.event === "attempt_finished")).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "cancelled", reason: "host_exit" })
  })

  it("closes a tool-waiting Attempt once with actual usage and no recovery", async () => {
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile, modelFactory: () => model(),
      recordEvent: async e => { events.push(e) } })
    await (await post(bridge, [user("Inspect README")])).json()
    await Promise.all([bridge.close(), bridge.close()])
    expect(events.filter(e => e.event === "attempt_finished")).toEqual([expect.objectContaining({ terminalState: "aborted", usageAvailable: true, inputTokens: 5, outputTokens: 2 })])
    expect(events.filter(e => e.event === "mission_finished")).toEqual([expect.objectContaining({ outcome: "cancelled", reason: "host_exit" })])
    expect(events.some(e => e.event === "recovery_started" || e.event === "completion_proposed")).toBe(false)
  })

  it("records request disconnection and releases the model without a phantom completion", async () => {
    const events: QwenLoopJournalEvent[] = []; let started = false
    const stalled: ModelPort = { async *stream(_request, signal) {
      started = true
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
      throw signal.reason
    } }
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile, modelFactory: () => stalled,
      recordEvent: async e => { events.push(e) } })
    const controller = new AbortController()
    const response = post(bridge, [user("Inspect README")], controller.signal).catch(() => undefined)
    await vi.waitFor(() => expect(started).toBe(true)); controller.abort(); await response
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "cancelled", reason: "request_disconnected" }))
    await bridge.close()
    expect(events.filter(e => e.event === "attempt_finished")).toHaveLength(1)
    expect(events.some(e => e.event === "completion_proposed")).toBe(false)
  })

  it("does not fabricate usage when a model ignores abort", async () => {
    const events: QwenLoopJournalEvent[] = []; let started = false
    let release: () => void = () => {}
    const stubborn: ModelPort = { async *stream() {
      started = true
      await new Promise<void>(resolve => { release = resolve })
      yield { type: "finish", reason: "stop" }
    } }
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile, modelFactory: () => stubborn,
      recordEvent: async e => { events.push(e) } })
    const response = post(bridge, [user("Inspect README")]).then(r => r.text()).catch(() => undefined)
    await vi.waitFor(() => expect(started).toBe(true))
    await bridge.close(); await response; release()
    const terminal = events.filter(e => e.event === "attempt_finished")
    expect(terminal).toEqual([expect.objectContaining({ terminalState: "aborted", usageAvailable: false })])
    expect(terminal[0]).not.toHaveProperty("inputTokens")
    expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "cancelled" })
  })

  it("cancels an in-flight verifier without accepting or recovering the cancelled Mission", async () => {
    const events: QwenLoopJournalEvent[] = []; let verifierSignal: AbortSignal | undefined
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile, modelFactory: () => model(),
      recordEvent: async e => { events.push(e) }, completionVerifier: { id: "fake",
        verify: async context => { verifierSignal = context.signal; return await new Promise(() => {}) } } })
    await (await post(bridge, [user("Inspect README")])).json()
    const result = post(bridge, [user("Inspect README"), observation(bridge)]).then(r => r.text()).catch(() => undefined)
    await vi.waitFor(() => expect(verifierSignal).toBeDefined())
    await bridge.close(); await result
    expect(verifierSignal?.aborted).toBe(true)
    expect(events.filter(e => e.event === "attempt_finished")).toHaveLength(1)
    expect(events.filter(e => e.event === "mission_finished")).toEqual([expect.objectContaining({ outcome: "cancelled" })])
    expect(events.some(e => e.event === "recovery_started" || e.event === "verification_completed")).toBe(false)
  })
})
