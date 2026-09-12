import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ids, type ModelRequest, type ModelStreamEvent } from "../../../kernel/src/index.js"
import { main } from "../src/daily-cli.js"
import { createProfileChatModel, readModelProfiles, resolveChatProfile, selectModelProfile } from "../src/model-profiles.js"
import { createOpenCodeQwenLoopConfig, startOpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { main as yaml } from "../src/yaml-687-dogfood.js"
import { main as yamlP81 } from "../src/yaml-687-p81-dogfood.js"
import { main as posthog } from "../src/posthog-wizard-1198-dogfood.js"
import { main as eslint } from "../src/typescript-eslint-12813-dogfood.js"
import { main as jsx } from "../src/jsx-a11y-954-dogfood.js"
import { main as markout } from "../src/markout-45-dogfood.js"

const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const chat = { adapter: "chat-api", provider: "test-provider", model: "vendor/code-model", baseUrl: "https://model.example.test/v1",
  apiKeyEnv: "CHAOS_TEST_KEY", dialect: "openai", thinking: "default", contextTokens: 32_000, maxOutputTokens: 4_000 }
async function config(profiles: object): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chaos-profiles-test-")); directories.push(directory)
  const path = join(directory, "profiles.json")
  await writeFile(path, JSON.stringify({ version: 1, profiles }))
  return path
}
async function resolved(overrides: object = {}) {
  const profiles = await readModelProfiles(await config({ test: { ...chat, ...overrides } }))
  const selected = selectModelProfile(profiles, "test")
  if (selected.adapter !== "chat-api") throw new Error("fixture")
  return resolveChatProfile(selected, { CHAOS_TEST_KEY: "fake-private-key" })
}
const request: ModelRequest = { attemptId: ids.attempt("test-attempt"), turn: 1,
  messages: [{ role: "user", content: "Read README" }], tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] }
function sse(delta: object, finish = "stop", usage = true): Response {
  const chunks = [{ choices: [{ index: 0, delta, finish_reason: finish }] },
    ...(usage ? [{ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }] : [])]
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}
async function collect(events: AsyncIterable<ModelStreamEvent>) { const result = []; for await (const event of events) result.push(event); return result }

describe("explicit model profile boundary", () => {
  it.each([yaml, yamlP81, posthog, eslint, jsx, markout])("protects fixed experiments from named-profile overrides", async launcher => {
    const workspaceValidator = vi.fn(), dailyCli = vi.fn(), stderr = vi.fn()
    vi.stubEnv("CHAOS_PROFILES_FILE", "/unused/config.json")
    expect(await launcher(["--profile", "qwen", "--model", "qwen3.8-max"], {
      workspaceValidator, dailyCli, stderr,
    })).toBe(2)
    expect(workspaceValidator).not.toHaveBeenCalled()
    expect(dailyCli).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Fixed task launchers"))
  })

  it("does not retry or dispatch a second backend after HTTP failure", async () => {
    const profile = await resolved()
    const mock = vi.fn(async () => new Response("fake-private-key", { status: 429 }))
    await expect(collect(createProfileChatModel(profile, mock as typeof fetch).stream(request, new AbortController().signal)))
      .rejects.toThrow("HTTP 429")
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it("rejects opaque reasoning instead of silently losing tool continuation state", async () => {
    const profile = await resolved({ dialect: "openrouter", thinking: "disabled" })
    const mock = vi.fn(async () => sse({ reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
      tool_calls: [{ index: 0, id: "must-not-dispatch", function: { name: "read", arguments: '{}' } }] }, "tool_calls"))
    await expect(collect(createProfileChatModel(profile, mock as typeof fetch).stream(request, new AbortController().signal)))
      .rejects.toThrow("Structured reasoning continuation")
  })

  it.each([
    { apiKey: "never-print-this" }, { baseUrl: "https://user:never-print-this@example.test" },
    { baseUrl: "http://remote.example.test" }, { baseUrl: "https://example.test?token=never-print-this" },
    { maxOutputTokens: 32_000 }, { contextTokens: -1 }, { apiKeyEnv: "literal-key-with-hyphens" },
    { dialect: "unknown" }, { thinking: "enabled" },
    { dialect: "openrouter", thinking: "enabled" }, { model: "bad model\nnever-print-this" },
  ])("rejects unsafe or unsupported profiles without echoing values: %j", async overrides => {
    try { await readModelProfiles(await config({ test: { ...chat, ...overrides } })); throw new Error("accepted") }
    catch (error) { expect(String(error)).not.toContain("never-print-this"); expect(String(error)).not.toContain("accepted") }
  })

  it("keeps dogfood disabled and missing credentials fail closed, without trying another profile", async () => {
    const profiles = await readModelProfiles(await config({ test: chat, dogfood: { ...chat, enabled: false } }))
    expect(() => selectModelProfile(profiles, "missing")).toThrow("no fallback")
    expect(() => selectModelProfile(profiles, "dogfood")).toThrow("disabled")
    const selected = selectModelProfile(profiles, "test")
    if (selected.adapter !== "chat-api") throw new Error("fixture")
    expect(() => resolveChatProfile(selected, { OTHER_KEY: "unrelated" })).toThrow("credential")
    const profile = await resolved({ baseUrl: "http://127.0.0.1:9999/v1/" })
    expect(profile.baseUrl).toBe("http://127.0.0.1:9999/v1")
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.access)).toBe(true)
  })

  it("lists profiles without reading credentials and checks locally without preflight or launch", async () => {
    const path = await config({ test: chat, gpt: { adapter: "codex-app-server", model: "gpt-exact" } })
    const prepare = vi.fn(), qwenLauncher = vi.fn(), advancedLauncher = vi.fn(), stdout = vi.fn(), stderr = vi.fn()
    const deps = { prepare, qwenLauncher, advancedLauncher, stdout, stderr }
    expect(await main(["--profiles", path, "--list-profiles"], deps)).toBe(0)
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("apiKeyEnv")
    expect(await main(["--profiles", path, "--profile", "test", "--check-profile"], deps)).toBe(2)
    vi.stubEnv("CHAOS_TEST_KEY", "fake-private-key")
    expect(await main(["--profiles", path, "--profile", "test", "--check-profile"], deps)).toBe(0)
    expect(prepare).not.toHaveBeenCalled(); expect(qwenLauncher).not.toHaveBeenCalled(); expect(advancedLauncher).not.toHaveBeenCalled()
    expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain("fake-private-key")
  })

  it.each(["test", "gpt"])("launches only the explicitly selected backend: %s", async name => {
    vi.stubEnv("CHAOS_TEST_KEY", "fake-private-key")
    const path = await config({ test: chat, gpt: { adapter: "codex-app-server", model: "gpt-exact" } })
    const qwenLauncher = vi.fn(async () => 0), advancedLauncher = vi.fn(async () => 0), records: object[] = []
    const prepare = vi.fn(async (args: { model: string }) => ({ root: "/repo", model: args.model, recordPath: "/unused.jsonl", dirty: false, statusSummary: "" }))
    expect(await main(["--profiles", path, "--profile", name], { prepare, qwenLauncher, advancedLauncher,
      recordQwenEvent: async (_path, event) => { records.push(event) }, stdout: () => {} })).toBe(0)
    expect(qwenLauncher).toHaveBeenCalledTimes(name === "test" ? 1 : 0)
    expect(advancedLauncher).toHaveBeenCalledTimes(name === "gpt" ? 1 : 0)
    expect(records[0]).toMatchObject({ profile: name, adapter: name === "test" ? "chat-api" : "codex-app-server" })
    expect(JSON.stringify(records)).not.toContain("fake-private-key")
    expect(JSON.stringify(records)).not.toContain("https://")
  })

  it.each([
    ["openai", "default", {}], ["dashscope", "enabled", { enable_thinking: true }],
    ["dashscope", "disabled", { enable_thinking: false }], ["deepseek", "enabled", { thinking: { type: "enabled" } }],
    ["kimi", "disabled", { thinking: { type: "disabled" } }],
    ["openrouter", "disabled", { reasoning: { enabled: false }, provider: { allow_fallbacks: false, require_parameters: true } }],
  ])("maps %s/%s without leaking another dialect into the request", async (dialect, thinking, expected) => {
    const profile = await resolved({ dialect, thinking })
    const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sse({ content: "done" }))
    const events = await collect(createProfileChatModel(profile, mock as typeof fetch).stream(request, new AbortController().signal))
    const [url, init] = mock.mock.calls[0]!
    expect(url).toBe(`${chat.baseUrl}/chat/completions`)
    expect(init?.redirect).toBe("error")
    const body = JSON.parse(String(init?.body))
    const extensions = Object.fromEntries(Object.entries(body).filter(([key]) => ["enable_thinking", "thinking", "reasoning", "provider"].includes(key)))
    expect(extensions).toEqual(expected)
    expect(body.model).toBe("vendor/code-model"); expect(body.max_tokens).toBe(4_000)
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 20, outputTokens: 4, cost: 0 } })
  })

  it("preserves reasoning and tool identity across chat turns, and refuses missing usage", async () => {
    const profile = await resolved({ dialect: "kimi", thinking: "enabled" })
    const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sse({ reasoning_content: "private reasoning",
      tool_calls: [{ index: 0, id: "exact-call", function: { name: "read", arguments: '{}' } }] }, "tool_calls"))
    const port = createProfileChatModel(profile, mock as typeof fetch)
    const events = await collect(port.stream(request, new AbortController().signal))
    expect(events).toContainEqual({ type: "tool_call", call: { toolCallId: "exact-call", name: "read", arguments: {} } })
    await collect(port.stream({ ...request, turn: 2, messages: [...request.messages,
      { role: "assistant", content: "", reasoning: "private reasoning", toolCalls: [{ toolCallId: "exact-call", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "exact-call", toolName: "read", ok: true, content: "README evidence" },
    ] }, new AbortController().signal))
    const body = JSON.parse(String(mock.mock.calls[1]![1]?.body))
    expect(body.messages[1]).toMatchObject({ reasoning_content: "private reasoning", tool_calls: [{ id: "exact-call" }] })
    expect(body.messages[2]).toMatchObject({ tool_call_id: "exact-call" })
    const noUsage = createProfileChatModel(profile, vi.fn(async () => sse({ content: "done" }, "stop", false)) as typeof fetch)
    await expect(collect(noUsage.stream(request, new AbortController().signal))).rejects.toThrow("without usage")
  })

  it("freezes the selected backend through recovery and attaches it to local feedback", async () => {
    const mutable = { ...await resolved() }, events: QwenLoopJournalEvent[] = []
    const factory = vi.fn(() => ({ async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: "No evidence" }; yield { type: "finish", reason: "stop" }
    } }))
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile: mutable,
      modelFactory: factory, recordEvent: async event => { events.push(event) } })
    try {
      mutable.model = "changed-after-start"; mutable.apiKey = "changed-secret"
      const headers = { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" }
      const response = await fetch(`${bridge.baseUrl}/chat/completions`, { method: "POST", headers,
        body: JSON.stringify({ model: "code-agent", messages: [{ role: "user", content: "Inspect README" }],
          tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }) })
      expect(response.status).toBe(200); await response.text()
      const feedback = await fetch(`${bridge.baseUrl}/feedback`, { method: "POST", headers, body: JSON.stringify({ score: 3 }) })
      expect(feedback.status).toBe(200); await feedback.text()
      expect(factory).toHaveBeenCalledTimes(2)
      for (const call of factory.mock.calls as unknown as [typeof mutable][]) expect(call[0].model).toBe(chat.model)
      expect(events.at(-1)).toMatchObject({ event: "feedback_recorded", profile: "test", adapter: "chat-api", model: chat.model, provider: chat.provider })
      expect(JSON.stringify(events)).not.toMatch(/fake-private-key|changed-secret|https:/)
    } finally { await bridge.close() }
    const overlay = createOpenCodeQwenLoopConfig("http://127.0.0.1:1/v1", "relay-key", undefined, await resolved())
    expect(JSON.stringify(overlay)).toContain(chat.model)
    expect(JSON.stringify(overlay)).not.toContain("fake-private-key")
    expect(JSON.stringify(overlay)).toContain('"context":32000')
  })
})
