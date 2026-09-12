import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import type { ModelPort, ModelRequest, ModelStreamEvent, ToolCall } from "../../../kernel/src/index.js"
import { startOpenCodeQwenLoopBridge, QWEN_LOOP_MODEL_ID, type OpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
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
  expect([status, 422]).toContain(response.status)
  return body
}

async function run(mode: "repair" | "probe-pass" | "throw" | "timeout" | "closure", enabled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-delivery-")))
  await mkdir(join(root, "package/test"), { recursive: true })
  const events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
  let changed = false, sequence = 0
  const ready = async () => !(await readdir(root)).includes("repro.ts") && (await readdir(join(root, "package/test"))).includes("regression.ts")
  const probe = vi.fn(async (): Promise<{ passed: boolean; guidance?: string }> => {
    if (mode === "throw") throw new Error("private probe exception")
    if (mode === "timeout") return new Promise(() => {})
    return mode === "probe-pass" ? { passed: true } : { passed: await ready(), guidance: "Move this Unit's repro into package/test as the required regression; limit changes to package/." }
  })
  const verify = vi.fn(async () => ({ passed: mode !== "probe-pass" && await ready() }))
  const checkpoint = { afterActions: 3, probe: { id: "public-delivery", verify: probe }, timeoutMs: 5 }
  const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: root,
    profile: { apiKey: "fake", model: "fake", baseUrl: "https://unused.invalid" },
    createAttemptId: () => `delivery-${++sequence}`, recordEvent: async e => { events.push(e) },
    workspaceArtifactProbe: { capture: async () => state(changed) },
    attemptBudget: { ...budget, ...(mode === "closure" ? { maxTurns: 3 } : {}) }, progressPolicy: policy,
    unitBudget: { maxTurns: 52, maxActions: 36 }, completionVerifier: { id: "full-acceptance", verify },
    ...(enabled ? { deliveryReadiness: checkpoint } : {}),
    modelFactory: () => model(r => {
      if (r.turn === 1) return call("edit", 1, { filePath: "repro.ts", newString: "regression assertions" })
      if (r.turn <= 3) return call("read", r.turn, { filePath: `source-${r.turn}` })
      const feedback = r.messages.some(m => m.role === "control" && m.content.includes("Move this Unit's repro"))
      if (!(mode === "repair" && feedback) && mode !== "probe-pass") return "blocked before delivery"
      return [call("edit", 4, { filePath: "package/test/regression.ts", newString: "regression assertions" }),
        call("bash", 5, { command: "rm repro.ts" }), test, diff][r.turn - 4] ?? "delivery accepted"
    }, requests),
  })
  checkpoint.afterActions = 1000
  let answer = ""
  try {
    let body = await send(bridge, [{ role: "user", content: "fix package and add tests" }])
    for (let n = 0; n < 40; n++) {
      if (body.error) { answer = body.error.code; break }
      const message = body.choices[0].message
      if (!message.tool_calls?.length) { answer = message.content; break }
      const item = message.tool_calls[0], args = JSON.parse(item.function.arguments)
      if (item.function.name === "edit") { await writeFile(join(root, args.filePath), args.newString); changed = true }
      if (args.command === "rm repro.ts") await rm(join(root, "repro.ts"))
      const ok = args.command === "pnpm test" ? await ready() : true
      body = await send(bridge, [{ role: "user", content: "fix package and add tests" }, { role: "tool", tool_call_id: item.id,
        content: encodeOpenCodeToolObservation({ token: bridge.observationToken, toolCallId: item.id, ok, content: `observed-${n}` }),
      }])
    }
    return { answer, events, requests, probe, verify, ready: await ready(), root }
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
}

describe("early delivery feedback within the work phase", () => {
  it.each([false, true])("lets the model repair actual files using checkpoint feedback (%s)", async enabled => {
    const r = await run("repair", enabled)
    expect(r.ready).toBe(enabled)
    expect(r.answer).toContain(enabled ? "delivery accepted" : "VERIFICATION PENDING")
    expect(r.probe).toHaveBeenCalledTimes(enabled ? 1 : 0)
    if (enabled) {
      expect(r.requests[3]!.messages.some(m => m.role === "control" && m.content.includes("Move this Unit's repro"))).toBe(true)
      expect(r.verify).toHaveBeenCalledTimes(1)
      expect(r.events.filter(e => e.event === "attempt_started")).toHaveLength(1)
      expect(r.events.find(e => e.event === "delivery_readiness_checked")).toMatchObject({ workActions: 3, readiness: { passed: false } })
    }
    expect(JSON.stringify(r.events)).not.toContain("Move this Unit's repro")
    expect(JSON.stringify(r.events)).not.toContain(r.root)
  })
  it("does not turn probe acceptance into success or repeat it after recovery", async () => {
    const r = await run("probe-pass")
    expect(r.probe).toHaveBeenCalledTimes(1)
    expect(r.verify).toHaveBeenCalledTimes(2)
    expect(r.answer).toContain("VERIFICATION PENDING")
    expect(r.events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")).toBe(false)
  })
  it.each(["throw", "timeout"] as const)("bounds an unavailable probe (%s) without accepting", async mode => {
    const r = await run(mode)
    expect(r.probe).toHaveBeenCalledTimes(1)
    expect(r.answer).toContain("VERIFICATION PENDING")
    expect(r.events.find(e => e.event === "delivery_readiness_checked")).toMatchObject({ readiness: { passed: false } })
    expect(JSON.stringify(r.events)).not.toContain("private probe exception")
  })
  it("does not schedule delivery work once closure begins", async () => {
    const r = await run("closure")
    expect(r.probe).not.toHaveBeenCalled()
    expect(r.ready).toBe(false)
    expect(r.events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")).toBe(false)
  })
})
