import { describe, expect, it, vi } from "vitest"
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

const plan = (status: string) => call("todowrite", 4, { todos: [{ id: "regression", content: "Add regression tests", status, priority: "high" }] })
const addTest = call("edit", 5, { filePath: "test/regression.ts", oldString: "", newString: "regression" })

describe("artifact-first completion verification", () => {
  it.each([false, true])("routes incomplete artifacts to writable repair only when opted in (%s)", async enabled => {
    const events: QwenLoopJournalEvent[] = [], recovery: ModelRequest[] = []
    let changed = false, hasTest = false, edits = 0
    const verify = vi.fn(async () => hasTest ? { passed: true } : { passed: false, guidance: "Add the required regression test." })
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model(r => [edit, plan("pending")][r.turn - 1] ?? "implementation complete"),
      model(r => [addTest, test, diff, plan("completed")][r.turn - 1] ?? "delivery verified", recovery),
    ], events, () => changed), unitBudget: { maxTurns: 48, maxActions: 36 },
      completionVerifier: { id: "regression-check", verify },
      ...(enabled ? { completionVerificationOrder: "artifact-first" as const } : {}),
    })
    try {
      const answer = await drive(bridge, (name, n) => {
        if (name === "edit") { changed = true; hasTest = ++edits === 2 }
        return { ok: true, content: `observation-${n}` }
      })
      expect(edits).toBe(enabled ? 2 : 1)
      expect(answer).toContain(enabled ? "delivery verified" : "VERIFICATION PENDING")
      expect(events.find(e => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: enabled ? "targeted-repair" : "evidence-only" })
      if (enabled) {
        expect(verify).toHaveBeenCalledTimes(2)
        expect(recovery[0]!.messages[0]!.content).toContain("Add the required regression test.")
        expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
        const finished = events.filter(e => e.event === "attempt_finished")
        expect(finished.at(-1)).toMatchObject({ unitBudget: { actions: 6, remainingActions: 30 } })
      }
      expect(JSON.stringify(events)).not.toContain("Add the required regression test.")
    } finally { await bridge.close() }
  })

  it("keeps an accepted artifact read-only and rejects an unclosed plan", async () => {
    const events: QwenLoopJournalEvent[] = []
    let changed = false, edits = 0
    const verify = vi.fn(async () => ({ passed: true }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model(r => [edit, plan("pending")][r.turn - 1] ?? "complete"),
      model(r => [addTest, test, diff][r.turn - 1] ?? "complete"),
    ], events, () => changed), completionVerifier: { id: "accept-artifact", verify }, completionVerificationOrder: "artifact-first" })
    try {
      expect(await drive(bridge, (name, n) => { if (name === "edit") { changed = true; edits++ }; return { ok: true, content: `observation-${n}` } })).toContain("VERIFICATION PENDING")
      expect(edits).toBe(1)
      expect(verify).toHaveBeenCalledTimes(2)
      expect(events.find(e => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: "evidence-only" })
      expect(events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")).toBe(false)
    } finally { await bridge.close() }
  })

  it.each(["unchanged", "unavailable"])("does not probe %s artifacts ahead of evidence", async kind => {
    const events: QwenLoopJournalEvent[] = []
    let mutated = false
    const verify = vi.fn(async () => ({ passed: true }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model(r => r.turn === 1 ? edit : "complete"), model(() => "complete"),
    ], events, () => false), workspaceArtifactProbe: { capture: async () => kind === "unavailable" && mutated ? { available: false } : state(false) },
      completionVerifier: { id: "artifact-check", verify }, completionVerificationOrder: "artifact-first" })
    try {
      expect(await drive(bridge, () => { mutated = true; return { ok: true, content: "edited" } })).toContain("VERIFICATION PENDING")
      expect(verify).not.toHaveBeenCalled()
    } finally { await bridge.close() }
  })

  it.each(["throw", "timeout"])("fails closed when early verification returns %s", async kind => {
    const events: QwenLoopJournalEvent[] = []
    let changed = false
    const verify = vi.fn(async (): Promise<{ passed: boolean }> => {
      if (kind === "throw") throw new Error("private failure")
      return new Promise(() => {})
    })
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model(r => r.turn === 1 ? edit : "complete"), model(() => "complete"),
    ], events, () => changed), completionVerifier: { id: "broken-check", verify }, completionVerifierTimeoutMs: 5, completionVerificationOrder: "artifact-first" })
    try {
      expect(await drive(bridge, () => { changed = true; return { ok: true, content: "edited" } })).toContain("VERIFICATION PENDING")
      expect(verify).toHaveBeenCalledTimes(1)
      expect(events.some(e => e.event === "recovery_started")).toBe(false)
      expect(events.find(e => e.event === "external_verification_completed")).toMatchObject({ failureCode: kind === "throw" ? "verifier_exception" : "verifier_timeout" })
      expect(events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")).toBe(false)
      expect(JSON.stringify(events)).not.toContain("private failure")
    } finally { await bridge.close() }
  })
})
