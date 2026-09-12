import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { ModelPort, ModelRequest, ModelStreamEvent, ToolCall } from "../../../kernel/src/index.js"
import { startOpenCodeQwenLoopBridge, QWEN_LOOP_MODEL_ID,
  type OpenCodeQwenLoopBridge, type OpenCodeQwenLoopBridgeOptions, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
import { progressSignatures } from "../src/progress-signatures.js"
import { ids } from "../../../kernel/src/index.js"

const state = (changed: boolean) => ({ available: true as const, digest: `sha256:${(changed ? "b" : "a").repeat(64)}`, changedPathCount: changed ? 1 : 0 })
const budget = { maxTurns: 20, maxActions: 12, evidenceClosure: { maxTurns: 4, maxActions: 6, allowedToolNames: ["read", "bash"] } }
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
      tools: ["read", "edit", "bash"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } })),
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

describe("bounded same-context continuation", () => {
  it.each([false, true])("uses an observation-only clue; clean restart cannot invent it (enabled=%s)", async enabled => {
    const clue = randomUUID(), events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
    let changed = false, edits = 0
    // This function can only extract the answer from the model's actual message input.
    const chooseEdit = (r: ModelRequest) => {
      const source = r.messages.find(m => m.role === "tool" && m.content.startsWith("private-clue:"))
      return source ? call("edit", 6, { filePath: "fix.ts", newString: source.content.slice("private-clue:".length) }) : "blocked: required source observation missing"
    }
    const verify = vi.fn(async () => ({ passed: changed }))
    const config = options([
      model(r => r.turn <= 5 ? call("read", r.turn, { filePath: `source-${r.turn}` }) : r.turn === 6 ? chooseEdit(r) : [test, diff, "fixed"][r.turn - 7]!, requests),
      model(chooseEdit),
    ], events, () => changed)
    const bridge = await startOpenCodeQwenLoopBridge({ ...config, unitBudget: { maxTurns: 24, maxActions: 24 },
      ...(enabled ? { noArtifactContinuation: { maxAdditionalActions: 3 } } : {}), completionVerifier: { id: "clue-check", verify } })
    try {
      const answer = await drive(bridge, (name, n) => {
        if (name === "edit") {
          const decisionInput = requests.at(-1)!
          const proposed = chooseEdit(decisionInput)
          changed = typeof proposed !== "string" && proposed.arguments.newString === clue
          edits++
        }
        return { ok: true, content: n === 0 ? `private-clue:${clue}` : `observed-${n}` }
      })
      expect(changed).toBe(enabled);expect(edits).toBe(enabled ? 1 : 0)
      expect(answer).toContain(enabled ? "fixed" : "VERIFICATION PENDING")
      expect(events.filter(e => e.event === "attempt_started")).toHaveLength(enabled ? 1 : 2)
      expect(events.filter(e => e.event === "attempt_control_decided" && e.controlDecision === "continue_context")).toHaveLength(enabled ? 1 : 0)
      expect(verify).toHaveBeenCalledTimes(enabled ? 1 : 0)
      expect(JSON.stringify(events)).not.toContain(clue)
      if (enabled) {
        expect(requests[5]!.messages).toContainEqual(expect.objectContaining({ role: "tool", content: `private-clue:${clue}` }))
        expect(requests[5]!.messages.some(m => m.role === "control" && m.content.includes("one bounded continuation"))).toBe(true)
      }
    } finally { await bridge.close() }
  })
  it("continues only once across recovery, preserving the Unit total and a fixed deadline", async () => {
    const events: QwenLoopJournalEvent[] = []
    const explore = () => model(r => call("read", r.turn, { filePath: `source-${r.turn}` }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([explore(), explore()], events, () => false),
      unitBudget: { maxTurns: 30, maxActions: 30 }, noArtifactContinuation: { maxAdditionalActions: 2 } })
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `unique-${n}` }))).toContain("VERIFICATION PENDING")
      expect(events.filter(e => e.event === "attempt_control_decided" && e.controlDecision === "continue_context")).toEqual([
        expect.objectContaining({ workActions: 5, noArtifactDeadlineAction: 7, contextContinuationCount: 1 }),
      ])
      const finished = events.filter(e => e.event === "attempt_finished")
      expect(finished).toHaveLength(2)
      expect(finished[0]).toMatchObject({ actions: 7, unitBudget: { actions: 7 } })
      expect(finished[1]).toMatchObject({ actions: 5, unitBudget: { actions: 12, remainingActions: 18 } })
    } finally { await bridge.close() }
  })
  it.each(["unavailable", "repeated_error"])("does not continue %s", async reason => {
    const events: QwenLoopJournalEvent[] = []
    const explore = () => model(() => call("read", 1, { filePath: "same" }))
    let captures = 0
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([explore(), explore()], events, () => false),
      unitBudget: { maxTurns: 30, maxActions: 30 }, noArtifactContinuation: { maxAdditionalActions: 3 },
      ...(reason === "unavailable" ? { workspaceArtifactProbe: { capture: async () => ++captures === 1 ? state(false) : { available: false as const } } } : {}) })
    try {
      await drive(bridge, (_, n) => ({ ok: reason !== "repeated_error", content: reason === "repeated_error" ? "same failure" : `fresh-${n}` }))
      expect(events.some(e => e.event === "attempt_control_decided" && e.controlDecision === "continue_context")).toBe(false)
    } finally { await bridge.close() }
  })
  it("retains the total across user checkpoint resume and does not dispatch beyond it", async () => {
    const events: QwenLoopJournalEvent[] = [], resumed: ModelRequest[] = []
    const explore = (requests: ModelRequest[] = []) => model(r => call("read", r.turn, { filePath: `file-${r.turn}` }), requests)
    const unitLimits = { maxTurns: 12, maxActions: 30 }, continuation = { maxAdditionalActions: 1 }
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([explore(), explore(), explore(resumed)], events, () => false),
      unitBudget: unitLimits, noArtifactContinuation: continuation })
    unitLimits.maxTurns = 1000; continuation.maxAdditionalActions = 1000
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `unique-${n}` }))).toContain("VERIFICATION PENDING")
      const goal = "continue fixing parser from the checkpoint"
      const response = await send(bridge, [{ role: "user", content: goal }])
      const item = response.choices[0].message.tool_calls[0]
      await send(bridge, [{ role: "user", content: goal }, { role: "tool", tool_call_id: item.id,
        content: encodeOpenCodeToolObservation({ token: bridge.observationToken, toolCallId: item.id, ok: true, content: "new observation" }),
      }], 422)
      expect(resumed).toHaveLength(1)
      expect(resumed[0]!.messages[0]!.content).toContain("total remaining allowance: 1 model turns")
      const finished = events.filter(e => e.event === "attempt_finished")
      expect(finished.at(-1)).toMatchObject({ turns: 1, primaryStop: { kind: "budget", budgetScope: "unit", stopReason: "max_turns" }, unitBudget: { maxTurns: 12, turns: 12, remainingTurns: 0 } })
      expect(events.filter(e => e.event === "attempt_control_decided" && e.controlDecision === "continue_context")).toHaveLength(1)
    } finally { await bridge.close() }
  })
  it("allocates an independent total to a later Mission", async () => {
    const events: QwenLoopJournalEvent[] = []
    const inspect = () => model(r => r.turn === 1 ? call("read", 1) : "inspected")
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([inspect(), inspect()], events, () => false), unitBudget: { maxTurns: 2, maxActions: 1 } })
    try {
      await drive(bridge, () => ({ ok: true, content: "observed" }), "inspect first file")
      await drive(bridge, () => ({ ok: true, content: "observed" }), "inspect second file")
      const finished = events.filter(e => e.event === "attempt_finished")
      expect(finished).toHaveLength(2)
      for (const event of finished) expect(event).toMatchObject({ unitBudget: { turns: 2, actions: 1 }, terminalState: "completion_proposed" })
      expect(finished[0]!.missionId).not.toBe(finished[1]!.missionId)
    } finally { await bridge.close() }
  })
  it("retains independent rejection after a context continuation produces an artifact", async () => {
    const events: QwenLoopJournalEvent[] = []
    let changed = false
    const verify = vi.fn(async () => ({ passed: false, guidance: "private-independent-rejection" }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model(r => r.turn <= 5 ? call("read", r.turn, { filePath: `source-${r.turn}` }) : [edit, test, diff, "fixed"][r.turn - 6]!),
      model(() => "cannot repair"),
    ], events, () => changed), unitBudget: { maxTurns: 30, maxActions: 30 }, noArtifactContinuation: { maxAdditionalActions: 3 },
      completionVerifier: { id: "always-reject", verify } })
    try {
      expect(await drive(bridge, (name, n) => { if (name === "edit") changed = true; return { ok: true, content: `observed-${n}` } })).toContain("VERIFICATION PENDING")
      expect(verify).toHaveBeenCalled()
      expect(events.some(e => e.event === "attempt_control_decided" && e.controlDecision === "continue_context")).toBe(true)
      expect(events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")).toBe(false)
      expect(JSON.stringify(events)).not.toContain("private-independent-rejection")
    } finally { await bridge.close() }
  })
  it("rejects an unbounded continuation before creating a model", async () => {
    const factory = vi.fn()
    await expect(startOpenCodeQwenLoopBridge({ ...options([], [], () => false), modelFactory: factory,
      noArtifactContinuation: { maxAdditionalActions: 3 } })).rejects.toThrow("explicit Unit budget")
    expect(factory).not.toHaveBeenCalled()
  })
})
