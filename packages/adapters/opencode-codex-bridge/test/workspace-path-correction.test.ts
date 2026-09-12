import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import type { ModelPort, ModelRequest, ModelStreamEvent, ToolCall } from "../../../kernel/src/index.js"
import { startOpenCodeQwenLoopBridge, QWEN_LOOP_MODEL_ID,
  type OpenCodeQwenLoopBridge, type OpenCodeQwenLoopBridgeOptions, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
const state = (changed: boolean) => ({ available: true as const, digest: `sha256:${(changed ? "b" : "a").repeat(64)}`, changedPathCount: changed ? 1 : 0 })
const budget = { maxTurns: 20, maxActions: 12, evidenceClosure: { maxTurns: 6, maxActions: 6, allowedToolNames: ["read", "bash"] } }
const policy = { explorationSoftLimit: 3, postSteerGraceActions: 2 }
const call = (name: string, n: number, args: ToolCall["arguments"] = {}): ToolCall => ({ name, toolCallId: `${name}-${n}`, arguments: args })
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
      tools: ["read", "write", "bash"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    }),
  })
  const body = await response.json()
  expect([status, 422]).toContain(response.status)
  return body
}

async function scenario(kind: "fixed" | "no-fix" | "twice" | "unit-turns" | "unit-actions" | "attempt-turns" | "host-denied" | "unavailable", enabled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-path-correction-")))
  const events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
  const artifact = async () => { try { return (await readFile(join(root, "fix.ts"), "utf8")) === "correct" } catch { return false } }
  const verify = vi.fn(async () => ({ passed: await artifact() }))
  const models = () => model(r => {
    if (r.turn <= 4) return call("read", r.turn, { filePath: `source-${r.turn}` })
    if (r.turn === 5) return call("write", 5, { filePath: kind === "host-denied" ? "fix.ts" : root + "-typo/fix.ts", content: "correct" })
    if (r.turn === 6) return call("read", 6, { filePath: "." })
    if (r.turn === 7) return kind === "no-fix" ? call("read", 7, { filePath: "another-source" })
      : call("write", 7, { filePath: kind === "twice" ? "../private-secret" : "fix.ts", content: "correct" })
    return [test, diff][r.turn - 8] ?? "fixed and verified"
  }, requests)
  let sequence = 0, captures = 0
  const pathOptions = { maxAdditionalActions: 2 }
  const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: root,
    profile: { apiKey: "fake-key", baseUrl: "https://unused.invalid/v1", model: "fake-model" },
    modelFactory: models, createAttemptId: () => `path-${++sequence}`, recordEvent: async e => { events.push(e) },
    workspaceBoundary: "root-only", workspaceArtifactProbe: { capture: async () => kind === "unavailable" && captures++ > 0 ? { available: false } : state(await artifact()) },
    attemptBudget: { ...budget, ...(kind === "attempt-turns" ? { maxTurns: 6 } : {}) }, progressPolicy: policy,
    unitBudget: { maxTurns: kind === "unit-turns" ? 6 : 48, maxActions: kind === "unit-actions" ? 6 : 36 },
    ...(enabled ? { workspacePathRecovery: pathOptions } : {}), completionVerifier: { id: "actual-file", verify },
  })
  // Caller mutation must not enlarge the admitted opportunity.
  pathOptions.maxAdditionalActions = 1000
  let answer = "", writes = 0
  try {
    let body = await send(bridge, [{ role: "user", content: "fix source" }])
    for (let n = 0; n < 40; n++) {
      if (body.error) { answer = body.error.code; break }
      const message = body.choices[0].message
      if (!message.tool_calls?.length) { answer = message.content; break }
      const item = message.tool_calls[0], args = JSON.parse(item.function.arguments)
      if (item.function.name === "write") {
        expect(args.filePath).toBe("fix.ts")
        if (kind !== "host-denied") { await writeFile(join(root, args.filePath), args.content); writes++ }
      }
      const ok = item.function.name === "write" && kind === "host-denied" ? false : item.function.name !== "bash" || await artifact()
      body = await send(bridge, [{ role: "user", content: "fix source" }, { role: "tool", tool_call_id: item.id,
        content: encodeOpenCodeToolObservation({ token: bridge.observationToken, toolCallId: item.id, ok, content: kind === "host-denied" && !ok ? "The user rejected permission to use this specific tool call." : `observed-${n}` }),
      }])
    }
    const changed = await artifact()
    return { events, requests, answer, writes, changed, verify, root }
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
}

describe("one bounded workspace path correction per Unit", () => {
  it.each([false, true])("replays a rejected write at the progress deadline using an actual file (enabled=%s)", async enabled => {
    const result = await scenario("fixed", enabled)
    expect(result.changed).toBe(enabled)
    expect(result.writes).toBe(enabled ? 1 : 0)
    expect(result.answer).toContain(enabled ? "fixed and verified" : "VERIFICATION PENDING")
    const corrected = result.events.filter(e => e.event === "attempt_control_decided" && e.controlDecision === "correct_path")
    expect(corrected).toHaveLength(enabled ? 1 : 0)
    if (enabled) {
      expect(corrected[0]).toMatchObject({ pathCorrectionCount: 1, workActions: 5, noArtifactDeadlineAction: 6 })
      expect(result.verify).toHaveBeenCalledTimes(1)
      expect(result.events.filter(e => e.event === "attempt_finished").at(-1)).toMatchObject({ unitBudget: { actions: 9, turns: 10 } })
      expect(result.requests.some(r => r.messages.some(m => m.role === "control" && m.content.includes("path-correction opportunity")))).toBe(true)
    }
    expect(JSON.stringify(result.events)).not.toContain(result.root)
    expect(JSON.stringify(result.events)).not.toContain("private-secret")
  })
  it("expires at the fixed deadline and cannot renew in the recovery Attempt", async () => {
    const r = await scenario("no-fix")
    expect(r.answer).toContain("VERIFICATION PENDING")
    expect(r.changed).toBe(false)
    const controls = r.events.flatMap(e => e.event === "attempt_control_decided" ? [e] : [])
    expect(controls.filter(e => e.controlDecision === "correct_path")).toHaveLength(1)
    expect(controls.filter(e => e.controlDecision === "recover").map(e => e.workActions)).toEqual([6, 5])
    expect(r.verify).not.toHaveBeenCalled()
  })
  it("still stops on a second preflight rejection without forwarding it", async () => {
    const r = await scenario("twice")
    expect(r.answer).toBe("attempt_stop_after_turn")
    expect(r.writes).toBe(0)
    expect(r.events.filter(e => e.event === "action_observed" && e.observationSource === "workspace_preflight")).toHaveLength(2)
    expect(r.events.some(e => e.event === "action_observed" && e.workspaceRejectionLimitReached)).toBe(true)
    expect(r.events.filter(e => e.event === "attempt_started")).toHaveLength(1)
  })
  it.each(["unit-turns", "unit-actions", "attempt-turns"] as const)("does not extend %s or closure permissions", async kind => {
    const r = await scenario(kind)
    expect(r.changed).toBe(false)
    expect(r.events.some(e => e.event === "attempt_control_decided" && e.controlDecision === "correct_path")).toBe(false)
    expect(r.verify).not.toHaveBeenCalled()
    const terminal = r.events.filter(e => e.event === "attempt_finished").at(-1)!
    if (terminal.event !== "attempt_finished") throw new Error("Expected Attempt terminal")
    if (kind === "unit-turns") expect(terminal.unitBudget?.turns).toBe(6)
    if (kind === "unit-actions") expect(terminal.unitBudget?.actions).toBe(6)
  })
  it.each(["host-denied", "unavailable"] as const)("does not reserve correction for %s", async kind => {
    const r = await scenario(kind)
    expect(r.changed).toBe(false)
    expect(r.events.some(e => e.event === "attempt_control_decided" && e.controlDecision === "correct_path")).toBe(false)
    expect(r.verify).not.toHaveBeenCalled()
  })
  it("rejects incomplete opt-in configuration before any model starts", async () => {
    const factory = vi.fn()
    await expect(startOpenCodeQwenLoopBridge({ workspaceRoot: "/fake", profile: { apiKey: "fake", model: "fake", baseUrl: "https://unused.invalid" },
      modelFactory: factory, workspacePathRecovery: { maxAdditionalActions: 2 } })).rejects.toThrow("Path correction requires")
    expect(factory).not.toHaveBeenCalled()
  })
})
