import { expect, it, vi } from "vitest"
import { NativeAttemptEngine, UnitBudget, ids, type AttemptRequest, type ModelStreamEvent } from "../../src/index.js"
import { ScriptedModelPort, ScriptedToolPort, allowAll } from "./fakes.js"
const read = (id: string): ModelStreamEvent[] => [{ type: "tool_call", call: { toolCallId: id, name: "read", arguments: {} } }, { type: "finish", reason: "tool_calls" }]
const final: ModelStreamEvent[] = [{ type: "text_delta", delta: "done" }, { type: "finish", reason: "stop" }]
const request = (budget: AttemptRequest["budget"] = {}): AttemptRequest => ({
  attempt: { attemptId: ids.attempt("attempt"), unitId: ids.unit("unit"), unitRevision: 1, projectionId: ids.projection("p") },
  messages: [{ role: "user", content: "inspect" }], tools: [{ name: "read", description: "read", inputSchema: {} }], budget,
})
function setup(scripts: ModelStreamEvent[][], deny = false) {
  const model = new ScriptedModelPort(scripts)
  const tools = new ScriptedToolPort(p => ({ toolCallId: p.call.toolCallId, toolName: p.call.name, content: "observed", ok: true }))
  const engine = new NativeAttemptEngine({ model, tools, permissions: deny ? { evaluate: async () => ({ outcome: "deny", reason: "denied" }) } : allowAll() })
  return { engine, model, tools }
}
it("shares total turns across Attempts without refunds or extra finalization calls", async () => {
  const shared = new UnitBudget({ maxTurns: 3, maxActions: 4 })
  const first = setup([read("a"), final]), second = setup([read("b"), final])
  expect((await first.engine.run(request(), { unitBudget: shared })).status).toBe("completion_proposed")
  const stopped = await second.engine.run(request(), { unitBudget: shared })
  expect(stopped).toMatchObject({ stopReason: "max_turns", usage: { turns: 1, actions: 1 } })
  expect(stopped.events).toContainEqual(expect.objectContaining({ type: "budget_exceeded", scope: "unit", consumed: 3 }))
  const third = setup([final]);await third.engine.run(request(), { unitBudget: shared })
  expect(third.model.requests).toHaveLength(0)
  expect(shared.snapshot()).toMatchObject({ turns: 3, actions: 2, remainingTurns: 0 })
})
it.each([false, true])("charges actions before permissions and blocks the remainder of a batch (deny=%s)", async deny => {
  const shared = new UnitBudget({ maxTurns: 3, maxActions: 1 })
  const { engine, tools } = setup([[read("a")[0]!, read("b")[0]!, { type: "finish", reason: "tool_calls" }]], deny)
  const result = await engine.run(request(), { unitBudget: shared })
  expect(result).toMatchObject({ stopReason: "max_actions", usage: { turns: 1, actions: 1 } })
  expect(tools.proposals).toHaveLength(deny ? 0 : 1)
  expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_observed", observation: expect.objectContaining({ toolCallId: "b", errorCode: "action_guard_reached" }) }))
  expect(shared.snapshot()).toMatchObject({ actions: 1, remainingActions: 0 })
})
it("charges evidence closure and stops before its budget-exempt finalization could run", async () => {
  const shared = new UnitBudget({ maxTurns: 2, maxActions: 4 })
  const { engine, model } = setup([read("work"), read("closure"), final])
  const result = await engine.run(request({ maxTurns: 8, maxActions: 1, evidenceClosure: { maxTurns: 4, maxActions: 3, allowedToolNames: ["read"] } }), { unitBudget: shared })
  expect(result.events.some(e => e.type === "evidence_closure_started")).toBe(true)
  expect(result).toMatchObject({ stopReason: "max_turns" });expect(model.requests).toHaveLength(2)
  expect(shared.snapshot()).toMatchObject({ turns: 2, actions: 2 })
})
it("counts length turns and cannot claim a recovery with no Unit turn remaining", async () => {
  const shared = new UnitBudget({ maxTurns: 2, maxActions: 4 })
  const { engine, model } = setup([read("a"), [{ type: "finish", reason: "length" }], final])
  const claim = vi.fn(async () => true)
  await engine.run(request({ maxTurns: 10, maxActions: 8 }), { unitBudget: shared, requestLengthRecovery: claim })
  expect(claim).not.toHaveBeenCalled();expect(model.requests).toHaveLength(2)
  expect(shared.snapshot()).toMatchObject({ turns: 2, actions: 1 })
})
it("validates and copies limits; cancellation before dispatch spends nothing", async () => {
  expect(() => new UnitBudget({ maxTurns: 0, maxActions: 1 })).toThrow()
  const limits = { maxTurns: 1, maxActions: 1 }, shared = new UnitBudget(limits);limits.maxTurns = 100
  const signal = AbortSignal.abort(), { engine, model } = setup([final])
  await engine.run(request(), { unitBudget: shared, signal })
  expect(model.requests).toHaveLength(0);expect(shared.snapshot()).toMatchObject({ maxTurns: 1, turns: 0 })
})
it("charges a successful length continuation against the same total", async () => {
  const shared = new UnitBudget({ maxTurns: 3, maxActions: 2 })
  const { engine, model } = setup([read("a"), [{ type: "finish", reason: "length" }], final])
  const claim = vi.fn(async () => true)
  expect((await engine.run(request({ maxTurns: 10, maxActions: 4 }), { unitBudget: shared, requestLengthRecovery: claim })).status).toBe("completion_proposed")
  expect(claim).toHaveBeenCalledTimes(1);expect(model.requests).toHaveLength(3)
  expect(shared.snapshot()).toMatchObject({ turns: 3, actions: 1, remainingTurns: 0 })
})
