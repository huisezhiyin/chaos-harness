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

async function send(bridge: OpenCodeQwenLoopBridge, messages: unknown[]): Promise<any> {
  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: QWEN_LOOP_MODEL_ID, messages,
      tools: ["read", "edit", "bash"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    }),
  })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
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

describe("P8 authenticated trajectory and recovery integration", () => {
  it("grants a bounded extension through the control channel and implements in the same Attempt", async () => {
    const events: QwenLoopJournalEvent[] = []; const requests: ModelRequest[] = []
    let changed = false
    const verify = vi.fn(async () => ({ passed: true }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => r.turn <= 5 ? call("read", r.turn, { filePath: `private-diagnostic-${r.turn}` }) :
        [edit, test, diff, "fixed after diagnosis"][r.turn - 6]!, requests),
    ], events, () => changed), progressPolicy: { ...policy, investigationExtensionActions: 3 }, completionVerifier: { id: "test-verifier", verify } })
    try {
      expect(await drive(bridge, (name, n) => {
        if (name === "edit") changed = true
        return { ok: true, content: `private-new-fact-${n}` }
      })).toBe("fixed after diagnosis")
      expect(events.filter((e) => e.event === "attempt_started")).toHaveLength(1)
      expect(events.filter((e) => e.event === "attempt_control_decided" && e.controlDecision === "extend")).toEqual([
        expect.objectContaining({ workActions: 5, progressLevel: "weak", extensionReason: "novel_observations", investigationExtensionCount: 1, noArtifactDeadlineAction: 8 }),
      ])
      expect(requests[5]!.messages).toContainEqual(expect.objectContaining({ role: "control", content: expect.stringContaining("one bounded investigation extension") }))
      expect(requests[5]!.tools.map((t) => t.name)).toContain("edit")
      expect(events.some((e) => e.event === "recovery_started" || e.event === "attempt_stuck_detected")).toBe(false)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
      expect(JSON.stringify(events)).not.toMatch(/private-diagnostic|private-new-fact|private-parser/)
    } finally { await bridge.close() }
  })

  it("bounds endlessly new observations to one extension per Attempt and one recovery", async () => {
    const events: QwenLoopJournalEvent[] = []
    const explore = () => model((r) => call("read", r.turn, { filePath: `file-${r.turn}` }))
    const verify = vi.fn(async () => ({ passed: true }))
    const mutablePolicy = { ...policy, investigationExtensionActions: 3 }
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([explore(), explore()], events, () => false),
      progressPolicy: mutablePolicy, completionVerifier: { id: "test-verifier", verify } })
    try {
      mutablePolicy.investigationExtensionActions = 1000
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `new-${n}` }))).toContain("VERIFICATION PENDING")
      expect(events.filter((e) => e.event === "attempt_control_decided" && e.controlDecision === "extend")).toHaveLength(2)
      expect(events.filter((e) => e.event === "attempt_stuck_detected")).toEqual([
        expect.objectContaining({ workActions: 8, investigationExtensionCount: 1 }),
        expect.objectContaining({ workActions: 8, investigationExtensionCount: 1 }),
      ])
      expect(events.filter((e) => e.event === "attempt_started")).toHaveLength(2)
      expect(events.filter((e) => e.event === "recovery_started")).toHaveLength(1)
      expect(events.some((e) => e.event === "completion_proposed" || e.event === "mission_finished")).toBe(false)
      expect(verify).not.toHaveBeenCalled()
    } finally { await bridge.close() }
  })

  it("does not extend for authenticated failures even when their outputs differ", async () => {
    const events: QwenLoopJournalEvent[] = []
    const explore = () => model((r) => call("read", r.turn, { filePath: `file-${r.turn}` }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([explore(), explore()], events, () => false),
      progressPolicy: { ...policy, investigationExtensionActions: 3 } })
    try {
      await drive(bridge, (_, n) => ({ ok: false, content: `different-error-${n}` }))
      expect(events.some((e) => e.event === "attempt_control_decided" && e.controlDecision === "extend")).toBe(false)
      expect(events.filter((e) => e.event === "attempt_stuck_detected")).toEqual([
        expect.objectContaining({ workActions: 5 }), expect.objectContaining({ workActions: 5 }),
      ])
    } finally { await bridge.close() }
  })

  it("validates extension against the hard action guard before creating a model", async () => {
    const config = options([], [], () => false)
    await expect(startOpenCodeQwenLoopBridge({ ...config, progressPolicy: { ...policy, investigationExtensionActions: 7 } })).rejects.toThrow("bounded task")
  })

  it("keeps the hard turn budget and read-only closure after granting an extension", async () => {
    const events: QwenLoopJournalEvent[] = []; const requests: ModelRequest[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => r.turn <= 6 ? call("read", r.turn, { filePath: `file-${r.turn}` }) : "blocked", requests),
      model(() => "blocked"),
    ], events, () => false), attemptBudget: { ...budget, maxTurns: 6 },
      progressPolicy: { ...policy, investigationExtensionActions: 3 } })
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `new-${n}` }))).toContain("VERIFICATION PENDING")
      expect(events.some((e) => e.event === "attempt_control_decided" && e.controlDecision === "extend")).toBe(true)
      expect(events.find((e) => e.event === "evidence_closure_started")).toMatchObject({ closureTrigger: "turns" })
      expect(requests[6]!.tools.map((t) => t.name)).not.toContain("edit")
      expect(events.some((e) => e.event === "mission_finished")).toBe(false)
    } finally { await bridge.close() }
  })

  it("does not extend when artifact observation is unavailable", async () => {
    const events: QwenLoopJournalEvent[] = []
    let probes = 0
    const explore = () => model((r) => call("read", r.turn, { filePath: `file-${r.turn}` }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([explore(), explore()], events, () => false),
      progressPolicy: { ...policy, investigationExtensionActions: 3 }, workspaceArtifactProbe: { capture: async () => {
        if (++probes === 1) return state(false)
        return { available: false }
      } } })
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `new-${n}` }))).toContain("VERIFICATION PENDING")
      expect(events.some((e) => e.event === "attempt_control_decided" && e.controlDecision === "extend")).toBe(false)
      expect(events.filter((e) => e.event === "attempt_stuck_detected")).toHaveLength(2)
    } finally { await bridge.close() }
  })

  it("steers novel exploration, interrupts before final, then implements with a distinct recovery pack", async () => {
    const events: QwenLoopJournalEvent[] = []
    const first: ModelRequest[] = []; const recovery: ModelRequest[] = []
    let changed = false
    const verify = vi.fn(async () => ({ passed: true }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => call("read", r.turn, { filePath: `private-file-${r.turn}` }), first),
      model((r) => [edit, test, diff, "fixed"][r.turn - 1]!, recovery),
    ], events, () => changed), completionVerifier: { id: "test-verifier", verify } })
    try {
      expect(await drive(bridge, (name, n) => {
        if (name === "edit") changed = true
        return { ok: true, content: `private-observation-${n}` }
      })).toBe("fixed")
      expect(first).toHaveLength(5)
      expect(first[3]!.messages.some((m) => m.role === "control")).toBe(true)
      expect(events.filter((e) => e.event === "attempt_stuck_detected")).toHaveLength(1)
      expect(events.find((e) => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: "implement-first", failureCode: "no_artifact_after_steer" })
      expect(events.filter((e) => e.event === "interrupted_verification_requested")).toHaveLength(1)
      expect(events.filter((e) => e.event === "completion_proposed")).toHaveLength(1)
      expect(recovery[0]!.messages[0]!.content).toContain("implement-first")
      expect(JSON.stringify(recovery[0]!.messages)).not.toContain("private-observation")
      expect(JSON.stringify(events)).not.toMatch(/private-file|private-parser|private-observation/)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
    } finally { await bridge.close() }
  })

  it("halts two repeated-cycle strategies without a false model completion or third Attempt", async () => {
    const events: QwenLoopJournalEvent[] = []
    const repeated = () => model((r) => call("read", r.turn, { filePath: "same.ts" }))
    const verify = vi.fn(async () => ({ passed: true }))
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([repeated(), repeated()], events, () => false), completionVerifier: { id: "test-verifier", verify } })
    try {
      expect(await drive(bridge, () => ({ ok: true, content: "same private content" }))).toContain("VERIFICATION PENDING")
      expect(events.filter((e) => e.event === "attempt_started")).toHaveLength(2)
      expect(events.filter((e) => e.event === "attempt_stuck_detected")).toHaveLength(2)
      expect(events.find((e) => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: "break-cycle" })
      expect(events.some((e) => e.event === "completion_proposed" || e.event === "mission_finished")).toBe(false)
      expect(verify).not.toHaveBeenCalled()
    } finally { await bridge.close() }
  })

  it("normalizes repeated diagnostic errors and routes repair-error", async () => {
    const events: QwenLoopJournalEvent[] = []
    const failing = () => model((r) => call("bash", r.turn, { command: `check-${r.turn}` }))
    const bridge = await startOpenCodeQwenLoopBridge(options([failing(), failing()], events, () => false))
    try {
      await drive(bridge, (_, n) => ({ ok: false, content: `request-id=${n} failure at 2026-09-04T09:00:0${n}Z: stable error` }))
      expect(events.find((e) => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: "repair-error", failureCode: "repeated_error" })
      expect(events.filter((e) => e.event === "action_observed")).toHaveLength(6)
    } finally { await bridge.close() }
  })

  it("keeps early-final evidence closure in the same Attempt with mutation tools removed", async () => {
    const events: QwenLoopJournalEvent[] = []; const requests: ModelRequest[] = []
    let changed = false
    const bridge = await startOpenCodeQwenLoopBridge(options([
      model((r) => [edit, "premature", test, diff, "verified"][r.turn - 1]!, requests),
    ], events, () => changed))
    try {
      expect(await drive(bridge, (name) => { if (name === "edit") changed = true; return { ok: true, content: "ok" } })).toBe("verified")
      expect(events.filter((e) => e.event === "attempt_started")).toHaveLength(1)
      expect(events.find((e) => e.event === "evidence_closure_started")).toMatchObject({ closureTrigger: "completion" })
      expect(requests[2]!.tools.map((t) => t.name)).not.toContain("edit")
      expect(requests[2]!.messages.at(-1)!.content).toContain("early completion")
      expect(events.some((e) => e.event === "recovery_started")).toBe(false)
    } finally { await bridge.close() }
  })

  it("preserves a verifier-rejected artifact and sends only targeted repair guidance", async () => {
    const events: QwenLoopJournalEvent[] = []; const recovery: ModelRequest[] = []
    let changed = false
    const verify = vi.fn().mockResolvedValueOnce({ passed: false, guidance: "private-verifier-failure: fix the boundary" }).mockResolvedValueOnce({ passed: true })
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => [edit, test, diff, "candidate"][r.turn - 1]!),
      model((r) => [edit, test, diff, "repaired"][r.turn - 1]!, recovery),
    ], events, () => changed), completionVerifier: { id: "test-verifier", verify } })
    try {
      expect(await drive(bridge, (name) => { if (name === "edit") changed = true; return { ok: true, content: "ok" } })).toBe("repaired")
      expect(verify).toHaveBeenCalledTimes(2)
      expect(events.find((e) => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: "targeted-repair" })
      expect(recovery[0]!.messages[0]!.content).toContain("private-verifier-failure")
      expect(JSON.stringify(events)).not.toContain("private-verifier-failure")
      expect(changed).toBe(true)
    } finally { await bridge.close() }
  })

  it("allows only non-mutation evidence in an evidence-only recovery", async () => {
    const events: QwenLoopJournalEvent[] = []; const recovery: ModelRequest[] = []
    let changed = false; let observedEdits = 0
    const bridge = await startOpenCodeQwenLoopBridge(options([
      model((r) => r.turn === 1 ? edit : "premature"),
      model((r) => [call("bash", 1, { command: "touch forbidden" }), test, diff, "evidence complete"][r.turn - 1]!, recovery),
    ], events, () => changed))
    try {
      expect(await drive(bridge, (name) => { if (name === "edit") { changed = true; observedEdits++ } return { ok: true, content: "ok" } })).toBe("evidence complete")
      expect(events.find((e) => e.event === "attempt_recovery_routed")).toMatchObject({ strategyId: "evidence-only" })
      expect(observedEdits).toBe(1)
      expect(recovery[0]!.tools.map((t) => t.name)).not.toContain("edit")
      expect(recovery[1]!.messages).toContainEqual(expect.objectContaining({ role: "tool", ok: false, content: expect.stringContaining("mutation is blocked") }))
    } finally { await bridge.close() }
  })

  it("denies remaining batch actions after the controller has requested stop", async () => {
    const events: QwenLoopJournalEvent[] = []
    const batched = model(() => [1, 2, 3, 4].map((n) => call("read", n, { filePath: "same" })).concat(edit))
    const bridge = await startOpenCodeQwenLoopBridge(options([batched, model(() => "blocked")], events, () => false))
    try {
      const observed: string[] = []
      await drive(bridge, (name) => { observed.push(name); return { ok: true, content: "same" } })
      expect(observed).toEqual(["read", "read", "read", "read"])
      expect(events.some((e) => e.event === "mission_finished")).toBe(false)
    } finally { await bridge.close() }
  })

  it("keeps controller cause through normal Host cleanup and accounts blocked batch edits", async () => {
    const events: QwenLoopJournalEvent[] = []
    const batched = () => model(() => [1, 2, 3, 4].map(n => call("read", n, { filePath: "private-source" })).concat(edit))
    const bridge = await startOpenCodeQwenLoopBridge(options([batched(), batched()], events, () => false))
    try {
      expect(await drive(bridge, () => ({ ok: true, content: "private-observation" }))).toContain("VERIFICATION PENDING")
      const finished = events.filter(e => e.event === "attempt_finished")
      expect(finished).toHaveLength(2)
      for (const event of finished) expect(event).toMatchObject({
        actions: 5, primaryStop: { kind: "controller_progress", stopReason: "stop_after_turn", failureCode: "repeated_cycle" },
        actionAccounting: { proposed: 5, hostForwarded: 4, hostObserved: 4, controllerBlocked: 1, workspaceRejected: 0, budgetBlocked: 0 },
      })
      expect(events.filter(e => e.event === "action_accounted" && e.disposition === "controller_blocked")).toEqual([
        expect.objectContaining({ action: "edit", ordinal: 5, turn: 1, failureCode: "repeated_cycle" }),
        expect.objectContaining({ action: "edit", ordinal: 5, turn: 1, failureCode: "repeated_cycle" }),
      ])
      expect(events.filter(e => e.event === "action_proposed")).toHaveLength(8)
      expect(JSON.stringify(events)).not.toMatch(/private-source|private-parser|private-observation|oldString|newString/)
      await bridge.close()
      await bridge.close()
      expect(events.filter(e => e.event === "mission_finished")).toEqual([
        expect.objectContaining({ outcome: "cancelled", reason: "host_exit", cleanupReason: "host_exit",
          primaryStop: { kind: "controller_progress", stopReason: "stop_after_turn", failureCode: "repeated_cycle" } }),
      ])
    } finally { await bridge.close() }
  })

  it("validates conflicting policies and absent work/closure budgets before creating the model", async () => {
    const config = options([], [], () => false)
    await expect(startOpenCodeQwenLoopBridge({ ...config, mutationProgressSteer: { afterActions: 2 } })).rejects.toThrow("must not be composed")
    await expect(startOpenCodeQwenLoopBridge({ ...config, attemptBudget: { maxActions: 10 } })).rejects.toThrow("bounded task")
  })

  it("does not impose mutation steering on read-only work", async () => {
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge(options([
      model((r) => r.turn <= 6 ? call("read", r.turn, { filePath: `file-${r.turn}` }) : "inspected"),
    ], events, () => false))
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `different-${n}` }), "inspect files")).toBe("inspected")
      expect(events.some((e) => e.event === "attempt_control_decided")).toBe(false)
      expect(events.at(-1)).toMatchObject({ event: "mission_finished" })
    } finally { await bridge.close() }
  })

  it("uses full observations for signatures even when model output projection is truncated", async () => {
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => r.turn <= 4 ? call("read", r.turn, { filePath: "same" }) : "inspected"),
    ], events, () => false), maxToolObservationChars: 16 })
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `${"x".repeat(100)}different-${n}` }), "inspect files")).toBe("inspected")
      expect(events.some((e) => e.event === "attempt_stuck_detected")).toBe(false)
    } finally { await bridge.close() }
  })

  it("handles unavailable artifact probes conservatively without persisting probe errors", async () => {
    const events: QwenLoopJournalEvent[] = []
    let probes = 0
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => call("read", r.turn, { filePath: `file-${r.turn}` })), model(() => "blocked"),
    ], events, () => false), workspaceArtifactProbe: { capture: async () => {
      if (++probes === 1) return state(false)
      throw new Error("private-probe-error")
    } } })
    try {
      expect(await drive(bridge, (_, n) => ({ ok: true, content: `new-${n}` }))).toContain("VERIFICATION PENDING")
      expect(events.filter((e) => e.event === "attempt_progress_observed")).toHaveLength(5)
      expect(events.find((e) => e.event === "attempt_control_decided")).toMatchObject({ artifactProgress: "unavailable", controlDecision: "steer" })
      expect(JSON.stringify(events)).not.toContain("private-probe-error")
    } finally { await bridge.close() }
  })

  it("freezes the task-bound policy and budgets at launch", async () => {
    const events: QwenLoopJournalEvent[] = []
    const mutablePolicy = { ...policy }; const mutableBudget = structuredClone(budget)
    const bridge = await startOpenCodeQwenLoopBridge({ ...options([
      model((r) => call("read", r.turn, { filePath: `file-${r.turn}` })), model(() => "blocked"),
    ], events, () => false), progressPolicy: mutablePolicy, attemptBudget: mutableBudget })
    try {
      mutablePolicy.explorationSoftLimit = 1000
      mutableBudget.maxActions = 1000
      mutableBudget.evidenceClosure.allowedToolNames.push("edit")
      await drive(bridge, (_, n) => ({ ok: true, content: `new-${n}` }))
      expect(events.find((e) => e.event === "attempt_stuck_detected")).toMatchObject({ workActions: 5 })
    } finally { await bridge.close() }
  })
})

describe("privacy-preserving progress fingerprints", () => {
  it("ignores tool IDs and key order, but preserves behavior-changing shell arguments", () => {
    const proposal = { attemptId: ids.attempt("a"), turn: 1, call: call("bash", 1, { command: "echo 'a b'", timeout: 1 }) }
    const observation = { toolCallId: "one", toolName: "bash", ok: true, content: "ok" }
    const first = progressSignatures(proposal, observation)
    expect(progressSignatures({ ...proposal, turn: 5, call: { ...proposal.call, toolCallId: "other", arguments: { timeout: 1, command: "echo 'a b'" } } }, { ...observation, toolCallId: "other" })).toEqual(first)
    expect(progressSignatures({ ...proposal, call: { ...proposal.call, arguments: { command: "echo 'ab'", timeout: 1 } } }, observation).pairDigest).not.toBe(first.pairDigest)
    expect(JSON.stringify(first)).not.toContain("echo")
  })
})
