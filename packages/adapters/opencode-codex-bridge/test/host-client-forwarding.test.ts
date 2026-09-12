import { request as httpRequest } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createProfileChatModel } from "../src/model-profiles.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
import { startOpenCodeQwenLoopBridge, type OpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import type { QwenProfile } from "../src/qwen.js"

const bridges: OpenCodeQwenLoopBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())) })
// Deliberately unrelated to any upstream accepted-client pattern: forwarding is verbatim.
const hostAgent = "host-fixture/2.7 (test client)"
const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
const goal = { role: "user", content: "Inspect README" }
const readCall = { index: 0, id: "read-1", type: "function", function: { name: "read", arguments: '{"filePath":"README.md"}' } }
const final = { content: "README inspected" }

async function fixture(deltas: object[], preserve = true) {
  const events: QwenLoopJournalEvent[] = [], selected: QwenProfile[] = []
  let index = 0
  const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const delta = deltas[index++]
    if (!delta) throw new Error("Unexpected extra upstream call")
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta,
      finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/unused",
    profile: { model: "fixture-model", apiKey: "upstream-secret", baseUrl: "http://127.0.0.1:1/v1",
      preserveHostUserAgent: preserve },
    modelFactory: profile => { selected.push(profile); return createProfileChatModel(profile, upstream as typeof fetch) },
    recordEvent: async event => { events.push(event) },
  })
  bridges.push(bridge)
  return { bridge, upstream, selected, events }
}

function observation(bridge: OpenCodeQwenLoopBridge) {
  return [goal, { role: "assistant", content: "", tool_calls: [readCall] },
    { role: "tool", tool_call_id: readCall.id, content: encodeOpenCodeToolObservation({ token: bridge.observationToken,
      toolCallId: readCall.id, ok: true, content: "# Project" }) }]
}

async function post(bridge: OpenCodeQwenLoopBridge, messages: object[] = [goal], agent: string | string[] | null = hostAgent,
  authorized = true) {
  // node:http does not synthesize User-Agent, so absence and duplicate headers are testable.
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest(`${bridge.baseUrl}/chat/completions`, { method: "POST", headers: [
      "host", new URL(bridge.baseUrl).host,
      "authorization", `Bearer ${authorized ? bridge.apiKey : "wrong-secret"}`, "content-type", "application/json",
      ...(agent === null ? [] : (Array.isArray(agent) ? agent : [agent]).flatMap(value => ["user-agent", value])),
      "cookie", "private-cookie", "x-private", "private-header",
    ] }, res => {
      let text = ""
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk }); res.on("error", reject)
      res.on("end", () => resolve({ status: res.statusCode!, text }))
    })
    req.on("error", reject)
    req.end(JSON.stringify({ model: "code-agent", messages, tools }))
  })
}

describe("authenticated Host client forwarding", () => {
  it("preserves the actual caller across tool turns, identifies the intermediary and isolates secrets", async () => {
    const { bridge, upstream, selected, events } = await fixture([{ tool_calls: [readCall] }, final])
    expect((await post(bridge)).status).toBe(200)
    expect((await post(bridge, observation(bridge))).status).toBe(200)
    expect(selected).toHaveLength(1)
    expect(Object.isFrozen(selected[0])).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(2)
    for (const [, init] of upstream.mock.calls) {
      const headers = new Headers(init?.headers)
      expect(headers.get("user-agent")).toBe(hostAgent)
      expect(headers.get("via")).toBe("1.1 chaos-harness")
      expect(headers.get("authorization")).toBe("Bearer upstream-secret")
      expect(headers.has("cookie")).toBe(false)
      expect(headers.has("x-private")).toBe(false)
      expect(JSON.stringify(init)).not.toContain(bridge.apiKey)
      expect(String(init?.body)).not.toContain(hostAgent)
    }
    expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
    expect(JSON.stringify(events)).not.toMatch(/host-fixture|upstream-secret|private-cookie|private-header/)
  })

  it("keeps the Unit binding through recovery and pending-checkpoint continuation", async () => {
    const { bridge, upstream, selected, events } = await fixture([final, final, { tool_calls: [readCall] }, final])
    expect((await post(bridge)).status).toBe(200)
    expect(events.some(event => event.event === "recovery_started")).toBe(true)
    expect(selected).toHaveLength(2)
    expect(selected[1]).toBe(selected[0])
    expect((await post(bridge, [goal], "changed-client/1")).status).toBe(409)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect((await post(bridge)).status).toBe(200)
    expect(selected[2]).toBe(selected[0])
    expect((await post(bridge, observation(bridge))).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(4)
    for (const [, init] of upstream.mock.calls) expect(new Headers(init?.headers).get("user-agent")).toBe(hostAgent)
  })

  it("rejects identity changes before accepting a pending tool observation", async () => {
    const { bridge, upstream } = await fixture([{ tool_calls: [readCall] }, final])
    await post(bridge)
    const changed = await post(bridge, observation(bridge), "changed-client/1")
    expect(changed.status).toBe(409)
    expect(changed.text).toContain("host_identity_changed")
    expect(upstream).toHaveBeenCalledTimes(1)
    expect((await post(bridge, observation(bridge))).status).toBe(200)
  })

  it("authenticates before reading or binding client metadata", async () => {
    const { bridge, upstream, selected } = await fixture([])
    expect((await post(bridge, [goal], "x".repeat(513), false)).status).toBe(401)
    expect(selected).toHaveLength(0)
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([" ", "x".repeat(513), ["first-client", "second-client"]])("rejects invalid or ambiguous metadata without dispatch", async agent => {
    const { bridge, upstream, selected } = await fixture([])
    const response = await post(bridge, [goal], agent)
    expect(response.status).toBe(400)
    expect(response.text).toContain("invalid_host_identity")
    expect(selected).toHaveLength(0)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("never synthesizes a client identity if the Host did not supply one", async () => {
    const { bridge, upstream } = await fixture([{ tool_calls: [readCall] }])
    expect((await post(bridge, [goal], null)).status).toBe(200)
    expect(new Headers(upstream.mock.calls[0]![1]?.headers).has("user-agent")).toBe(false)
    expect(new Headers(upstream.mock.calls[0]![1]?.headers).has("via")).toBe(false)
  })

  it("leaves other provider paths unchanged", async () => {
    const { bridge, upstream } = await fixture([{ tool_calls: [readCall] }, final], false)
    await post(bridge)
    expect((await post(bridge, observation(bridge), "another-host/1")).status).toBe(200)
    for (const [, init] of upstream.mock.calls) {
      expect(new Headers(init?.headers).has("user-agent")).toBe(false)
      expect(new Headers(init?.headers).has("via")).toBe(false)
    }
  })
})
