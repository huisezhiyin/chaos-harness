import { describe, expect, it, vi } from "vitest"
import { AttemptController, NativeAttemptEngine, ids, type AttemptRequest, type ModelStreamEvent } from "../../src/index.js"
import { ScriptedModelPort, ScriptedToolPort, allowAll } from "./fakes.js"

const usage: ModelStreamEvent = { type: "usage", usage: { inputTokens: 5, outputTokens: 32000, reasoningTokens: 32000, cost: 0.1 } }
const incomplete = (reason: "length" | "content_filter" | "error" = "length"): ModelStreamEvent[] => [
  { type: "reasoning_delta", delta: "discarded reasoning" }, { type: "text_delta", delta: "discarded output" }, usage, { type: "finish", reason },
]
const final: ModelStreamEvent[] = [{ type: "text_delta", delta: "inspected" }, { type: "usage", usage: { inputTokens: 3, outputTokens: 2, cost: 0 } }, { type: "finish", reason: "stop" }]
const read = (id: string): ModelStreamEvent[] => [
  { type: "tool_call", call: { toolCallId: id, name: "read", arguments: { filePath: "README.md" } } },
  { type: "finish", reason: "tool_calls" },
]
const request = (budget: AttemptRequest["budget"] = { maxTurns: 8, maxActions: 4 }): AttemptRequest => ({
  attempt: { attemptId: ids.attempt("length-attempt"), unitId: ids.unit("length-unit"), unitRevision: 1, projectionId: ids.projection("length-projection") },
  messages: [{ role: "user", content: "inspect README" }], tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }], budget,
})
function setup(scripts: ModelStreamEvent[][]) {
  const model = new ScriptedModelPort(scripts)
  const tools = new ScriptedToolPort(p => ({ toolCallId: p.call.toolCallId, toolName: p.call.name, ok: true, content: "completed observation" }))
  return { model, tools, engine: new NativeAttemptEngine({ model, tools, permissions: allowAll() }) }
}

describe("bounded length recovery", () => {
  it("keeps completed observations, discards incomplete content, and accounts for all turns", async () => {
    const { model, tools, engine } = setup([read("before"), incomplete(), read("after"), final])
    const claim = vi.fn(async () => true)
    const result = await engine.run(request(), { requestLengthRecovery: claim })
    expect(result.status).toBe("completion_proposed")
    expect(result.usage).toMatchObject({ turns: 4, actions: 2, inputTokens: 8, outputTokens: 32002, reasoningTokens: 32000 })
    expect(model.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "completed observation", toolCallId: "before" }))
    expect(JSON.stringify(model.requests[2]?.messages)).not.toContain("discarded reasoning")
    expect(JSON.stringify(model.requests[2]?.messages)).not.toContain("discarded output")
    expect(model.requests[2]?.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("One bounded recovery") })
    expect(tools.proposals).toHaveLength(2)
    expect(claim).toHaveBeenCalledTimes(1)
    expect(result.events.filter(e => e.type === "model_length_recovery_started")).toHaveLength(1)
  })
  it("stops on a second length finish even if the policy would grant again", async () => {
    const { engine, model } = setup([incomplete(), incomplete(), final])
    const claim = vi.fn(async () => true)
    const result = await engine.run(request(), { requestLengthRecovery: claim })
    expect(result).toMatchObject({ stopReason: "model_incomplete", usage: { turns: 2, outputTokens: 64000 } })
    expect(model.requests).toHaveLength(2)
    expect(claim).toHaveBeenCalledTimes(1)
  })
  it.each(["disabled", "denied", "content_filter", "error", "missing_finish", "partial_tool"])("does not recover %s", async kind => {
    let script = incomplete(kind === "content_filter" || kind === "error" ? kind : "length")
    if (kind === "missing_finish") script = script.slice(0, -1)
    if (kind === "partial_tool") script.unshift(read("incomplete")[0]!)
    const { engine, model, tools } = setup([script, final])
    const claim = vi.fn(async () => kind !== "denied")
    const result = await engine.run(request(), kind === "disabled" ? {} : { requestLengthRecovery: claim })
    expect(result.status).toBe("stopped")
    expect(model.requests).toHaveLength(1)
    expect(tools.proposals).toHaveLength(0)
    expect(claim).toHaveBeenCalledTimes(kind === "denied" ? 1 : 0)
  })
  it.each([
    { maxTurns: 2, maxActions: 4 },
    { maxTurns: 8, maxActions: 0 },
    { maxTurns: 8, maxActions: 4, maxCost: 0.1 },
    { maxTurns: 8, maxActions: 4, maxCost: 0.05 },
    { maxTurns: 0, maxActions: 4, evidenceClosure: { maxTurns: 3, maxActions: 2, allowedToolNames: ["read"] } },
  ])("does not expand a spent work/cost/closure budget %j", async budget => {
    const { engine, model } = setup([incomplete(), final])
    const claim = vi.fn(async () => true)
    await engine.run(request(budget), { requestLengthRecovery: claim })
    expect(model.requests).toHaveLength(1)
    expect(claim).not.toHaveBeenCalled()
  })
  it.each(["stop", "cancel", "abort"])("honors %s while recovery policy is pending", async kind => {
    const { engine, model } = setup([incomplete(), final])
    const control = new AttemptController(), abort = new AbortController()
    const result = await engine.run(request(), { control, signal: abort.signal, requestLengthRecovery: async () => {
      if (kind === "stop") control.stopAfterTurn()
      if (kind === "cancel") control.cancel()
      if (kind === "abort") abort.abort()
      return true
    } })
    expect(result.status).not.toBe("completion_proposed")
    expect(model.requests).toHaveLength(1)
  })
})
