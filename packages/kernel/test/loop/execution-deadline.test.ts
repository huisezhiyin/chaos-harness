import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExecutionDeadline, NativeAttemptEngine, UnitBudget, ids, type AttemptRequest, type ModelPort, type ToolPort } from "../../src/index.js"

const clocks: ExecutionDeadline[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { clocks.splice(0).forEach(d => d.dispose()); vi.useRealTimers() })
const deadline = () => { const d = new ExecutionDeadline({ deadlineAtMs: 1000, closureWindowMs: 300 }); clocks.push(d); return d }
const request = (): AttemptRequest => ({
  attempt: { attemptId: ids.attempt("deadline"), unitId: ids.unit("u"), unitRevision: 1, projectionId: ids.projection("p") },
  messages: [{ role: "user", content: "fix and validate" }],
  tools: ["read", "write"].map(name => ({ name, description: name, inputSchema: {} })),
  budget: { maxTurns: 20, maxActions: 30, evidenceClosure: { maxTurns: 4, maxActions: 4, allowedToolNames: ["read"] } },
})
const call = (name: string, n = 1) => ({ type: "tool_call" as const, call: { name, toolCallId: `c-${n}`, arguments: {} } })
const finish = { type: "finish" as const, reason: "tool_calls" as const }
const final = [{ type: "text_delta" as const, delta: "verified" }, { type: "finish" as const, reason: "stop" as const }]
const permissions = { evaluate: async () => ({ outcome: "allow" as const }) }
const execute = vi.fn<ToolPort["execute"]>(async p => ({ toolCallId: p.call.toolCallId, toolName: p.call.name, ok: true, content: "observed" }))
const engine = (model: ModelPort, tools: ToolPort = { execute }) => new NativeAttemptEngine({ model, tools, permissions })

describe("shared execution deadline", () => {
  it("rejects invalid/unbounded windows", () => {
    for (const opts of [{ deadlineAtMs: 0, closureWindowMs: 1 }, { deadlineAtMs: 100, closureWindowMs: 100 }, { deadlineAtMs: 100, closureWindowMs: 0 }, { deadlineAtMs: 2 ** 32, closureWindowMs: 1 }]) {
      expect(() => new ExecutionDeadline(opts)).toThrow("deadline")
    }
  })
  it("closes after a long response without releasing its newly forbidden mutation", async () => {
    const d = deadline(), seen: string[] = [], tool = vi.fn<ToolPort["execute"]>()
    const result = await engine({ async *stream(r) {
      seen.push(r.messages.map(m => m.content).join("\n"))
      if (r.turn === 1) { vi.setSystemTime(750); yield call("write"); yield finish }
      else { expect(r.tools.map(t => t.name)).toEqual(["read"]); yield* final }
    } }, { execute: tool }).run(request(), { deadline: d, evidenceClosure: { permissions } })
    expect(result.status).toBe("completion_proposed")
    expect(tool).not.toHaveBeenCalled()
    expect(result.events).toContainEqual(expect.objectContaining({ type: "evidence_closure_started", trigger: "deadline" }))
    expect(seen[1]).toContain("time remaining: 1 seconds")
    expect(seen[1]).toContain("Do not add optional checks")
  })
  it("checks the boundary between two calls from the same batch", async () => {
    const tool = vi.fn<ToolPort["execute"]>(async p => { vi.setSystemTime(750); return { toolCallId: p.call.toolCallId, toolName: p.call.name, ok: true, content: "read" } })
    const result = await engine({ async *stream(r) {
      if (r.turn === 1) { yield call("read"); yield call("write", 2); yield finish } else yield* final
    } }, { execute: tool }).run(request(), { deadline: deadline(), evidenceClosure: { permissions } })
    expect(tool).toHaveBeenCalledTimes(1)
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_observed", observation: expect.objectContaining({ errorCode: "permission_denied", ok: false }) }))
  })
  it.each(["model", "tool"])("cancels an in-flight %s without inventing observations or completion", async where => {
    const d = deadline(), waiting = vi.fn()
    const blocked = (signal: AbortSignal) => new Promise<never>((_, reject) => { waiting(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }) })
    const resultPromise = engine({ async *stream(_r, signal) {
      if (where === "model") await blocked(signal)
      yield call("read"); yield finish
    } }, { execute: async (_p, signal) => blocked(signal) }).run(request(), { deadline: d })
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    const result = await resultPromise
    expect(result).toMatchObject({ status: "stopped", stopReason: "deadline_exceeded" })
    expect(result.events.some(e => e.type === "tool_observed" || e.type === "completion_proposed")).toBe(false)
  })
  it("does not dispatch after expiry or renew time for a later Attempt", async () => {
    const d = deadline(), spy = vi.fn()
    vi.setSystemTime(750)
    const model: ModelPort = { async *stream(r) { spy(); expect(r.tools.map(t => t.name)).toEqual(["read"]); yield* final } }
    await engine(model).run(request(), { deadline: d })
    vi.setSystemTime(1001)
    const result = await engine(model).run(request(), { deadline: d })
    expect(result).toMatchObject({ stopReason: "deadline_exceeded" }); expect(spy).toHaveBeenCalledOnce()
    expect(d.deadlineAtMs).toBe(1000)
  })
  it("retains the Unit total budget during time-triggered closure", async () => {
    const d = deadline(); vi.setSystemTime(750)
    const unitBudget = new UnitBudget({ maxTurns: 1, maxActions: 1 })
    const result = await engine({ async *stream() { yield call("read"); yield finish } }).run(request(), { deadline: d, unitBudget })
    expect(result).toMatchObject({ stopReason: "max_turns" })
    expect(unitBudget.snapshot()).toMatchObject({ turns: 1, actions: 1, remainingTurns: 0 })
  })
})
