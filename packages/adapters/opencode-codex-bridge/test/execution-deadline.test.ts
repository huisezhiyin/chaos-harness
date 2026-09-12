import { ExecutionDeadline } from "../../../kernel/src/index.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModelPort, ModelRequest, ModelStreamEvent, ToolCall } from "../../../kernel/src/index.js"
import { startOpenCodeQwenLoopBridge, QWEN_LOOP_MODEL_ID,
  type OpenCodeQwenLoopBridge, type OpenCodeQwenLoopBridgeOptions, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
const state = (changed: boolean) => ({ available: true as const, digest: `sha256:${(changed ? "b" : "a").repeat(64)}`, changedPathCount: changed ? 1 : 0 })
const budget = { maxTurns: 20, maxActions: 12, evidenceClosure: { maxTurns: 6, maxActions: 6, allowedToolNames: ["read", "bash", "todowrite"] } }
const policy = { explorationSoftLimit: 3, postSteerGraceActions: 2 }
const call = (name: string, n: number, args: ToolCall["arguments"] = {}): ToolCall => ({ name, toolCallId: `${name}-${n}`, arguments: args })
const edit = call("edit", 1, { filePath: "private-parser.ts", oldString: "a", newString: "b" })
const test = call("bash", 2, { command: "pnpm test" })
const diff = call("bash", 3, { command: "git diff --check" })

function model(steps: (request: ModelRequest) => ToolCall | ToolCall[] | string, requests: ModelRequest[] = []): ModelPort {
  return { async *stream(request): AsyncIterable<ModelStreamEvent> {
    requests.push(structuredClone(request))
    const step = steps(request)
    if (typeof step === "string") {
      yield { type: "text_delta", delta: step }
      yield { type: "finish", reason: "stop" }
    } else {
      for (const item of Array.isArray(step) ? step : [step]) yield { type: "tool_call", call: item }
      yield { type: "finish", reason: "tool_calls" }
    }
  } }
}

async function send(bridge: OpenCodeQwenLoopBridge, messages: unknown[], status = 200): Promise<any> {
  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: QWEN_LOOP_MODEL_ID, messages,
      tools: ["read", "edit", "bash", "todowrite"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    }),
  })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(status)
  return body
}

async function drive(bridge: OpenCodeQwenLoopBridge, observe: (name: string, index: number) => { ok: boolean; content: string }, goal = "fix parser"): Promise<string> {
  let body = await send(bridge, [{ role: "user", content: goal }])
  for (let n = 0; n < 40; n++) {
    const message = body.choices[0].message
    if (!message.tool_calls?.length) return message.content
    const item = message.tool_calls[0]
    const result = observe(item.function.name, n)
    body = await send(bridge, [{ role: "user", content: goal }, {
      role: "tool", tool_call_id: item.id,
      content: encodeOpenCodeToolObservation({ token: bridge.observationToken, toolCallId: item.id, ...result }),
    }])
  }
  throw new Error("Scripted trajectory exceeded the expected bound")
}

function options(models: ModelPort[], events: QwenLoopJournalEvent[], artifact: () => boolean): OpenCodeQwenLoopBridgeOptions {
  let sequence = 0
  return {
    workspaceRoot: "/fake-workspace",
    profile: { apiKey: "fake-key", baseUrl: "https://unused.invalid/v1", model: "fake-model" },
    modelFactory: () => { const next = models.shift(); if (!next) throw new Error("unexpected third model"); return next },
    createAttemptId: () => `trajectory-${++sequence}`,
    recordEvent: async (event) => { events.push(event) },
    workspaceArtifactProbe: { capture: async () => state(artifact()) },
    attemptBudget: budget, progressPolicy: policy,
  }
}

afterEach(() => vi.restoreAllMocks())
describe("deadline across the native bridge and completion gate", () => {
  it("enters closure before turn exhaustion and still requires validation, diff and independent acceptance", async () => {
    const start = Date.now(), deadline = new ExecutionDeadline({ deadlineAtMs: start + 60000, closureWindowMs: 20000 })
    const events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
    let changed = false
    const verify = vi.fn(async () => ({ passed: true }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([model(r => {
      if (r.turn === 1) return edit
      if (r.turn === 2) { vi.spyOn(Date, "now").mockReturnValue(start + 45000); return test }
      if (r.turn === 3) return diff
      return "delivery verified"
    }, requests)], events, () => changed), deadline, completionVerifier: { id: "independent", verify }, completionVerificationOrder: "artifact-first" })
    try {
      await drive(bridge, name => { if (name === "edit") changed = true; return { ok: true, content: "observed" } })
      expect(verify).toHaveBeenCalledOnce()
      expect(events).toContainEqual(expect.objectContaining({ event: "evidence_closure_started", closureTrigger: "deadline" }))
      expect(events).toContainEqual(expect.objectContaining({ event: "mission_finished", outcome: "succeeded" }))
      expect(requests[2]!.tools.map(t => t.name)).not.toContain("edit")
      expect(requests[2]!.messages.some(m => m.content.includes("time remaining: 15 seconds"))).toBe(true)
    } finally { await bridge.close(); deadline.dispose() }
  })
  it("does not accept a verifier result that arrives after the absolute deadline", async () => {
    const start = Date.now(), deadline = new ExecutionDeadline({ deadlineAtMs: start + 60000, closureWindowMs: 20000 })
    const events: QwenLoopJournalEvent[] = []; let changed = false
    const verify = vi.fn(async () => { vi.spyOn(Date, "now").mockReturnValue(start + 60001); return { passed: true } })
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([model(r => [edit, test, diff][r.turn - 1] ?? "complete")], events, () => changed), deadline,
      completionVerifier: { id: "late", verify }, completionVerificationOrder: "artifact-first" })
    try {
      await expect(drive(bridge, name => { if (name === "edit") changed = true; return { ok: true, content: "observed" } })).rejects.toThrow()
      await bridge.close()
      expect(verify).toHaveBeenCalledOnce()
      expect(events).not.toContainEqual(expect.objectContaining({ event: "mission_finished", outcome: "succeeded" }))
      expect(events).toContainEqual(expect.objectContaining({ event: "mission_finished", outcome: "cancelled", reason: "deadline_exceeded" }))
    } finally { await bridge.close(); deadline.dispose() }
  })
  it("hard expiry cancels a stalled model and rejects subsequent dispatch", async () => {
    const deadline = new ExecutionDeadline({ deadlineAtMs: Date.now() + 1000, closureWindowMs: 300 }), events: QwenLoopJournalEvent[] = []
    let calls = 0
    const stalled: ModelPort = { async *stream(_r, signal) { calls++; await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) } }
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([stalled], events, () => false), deadline })
    try {
      const response = await fetch(`${bridge.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: QWEN_LOOP_MODEL_ID, messages: [{ role: "user", content: "read README" }], tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } }] }) })
      await response.text();
      await send(bridge, [{ role: "user", content: "read README" }], 409)
      await bridge.close()
      expect(calls).toBe(1)
      expect(events).toContainEqual(expect.objectContaining({ event: "attempt_finished", stopReason: "deadline_exceeded" }))
      expect(events).toContainEqual(expect.objectContaining({ event: "mission_finished", outcome: "cancelled", reason: "deadline_exceeded" }))
    } finally { await bridge.close(); deadline.dispose() }
  })
  it("hard expiry aborts an in-flight verifier, rather than accepting its eventual result", async () => {
    const deadline = new ExecutionDeadline({ deadlineAtMs: Date.now() + 1000, closureWindowMs: 300 }), events: QwenLoopJournalEvent[] = []
    let changed = false, verifierAborted = false
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([model(r => [edit, test, diff][r.turn - 1] ?? "complete")], events, () => changed), deadline,
      completionVerifier: { id: "stalled-verifier", verify: async context => {
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => { verifierAborted = true; resolve() }, { once: true }))
        return { passed: true }
      } }, completionVerificationOrder: "artifact-first" })
    try {
      await drive(bridge, name => { if (name === "edit") changed = true; return { ok: true, content: "observed" } }).catch(() => undefined)
      await bridge.close()
      expect(verifierAborted).toBe(true)
      expect(events).not.toContainEqual(expect.objectContaining({ event: "mission_finished", outcome: "succeeded" }))
      expect(events).toContainEqual(expect.objectContaining({ event: "mission_finished", reason: "deadline_exceeded" }))
    } finally { await bridge.close(); deadline.dispose() }
  })
  it("recovery inherits the same closing window and cannot regain mutation tools", async () => {
    const start = Date.now(), deadline = new ExecutionDeadline({ deadlineAtMs: start + 60000, closureWindowMs: 20000 })
    const events: QwenLoopJournalEvent[] = [], recovered: ModelRequest[] = []; let changed = false
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model(r => [edit, test, diff][r.turn - 1] ?? "complete"),
      model(() => "blocked; preserve artifact", recovered),
    ], events, () => changed), deadline, unitBudget: { maxTurns: 40, maxActions: 30 },
      completionVerifier: { id: "needs-repair", verify: async () => {
        vi.spyOn(Date, "now").mockReturnValue(start + 45000)
        return { passed: false, guidance: "A required case still fails." }
      } }, completionVerificationOrder: "artifact-first" })
    try {
      await drive(bridge, name => { if (name === "edit") changed = true; return { ok: true, content: "observed" } })
      expect(recovered.length).toBeGreaterThan(0)
      expect(recovered[0]!.tools.map(t => t.name)).not.toContain("edit")
      expect(recovered[0]!.messages.some(m => m.content.includes("time remaining: 15 seconds"))).toBe(true)
      expect(deadline.deadlineAtMs).toBe(start + 60000)
      expect(events).not.toContainEqual(expect.objectContaining({ event: "mission_finished", outcome: "succeeded" }))
    } finally { await bridge.close(); deadline.dispose() }
  })
})
