import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ids, type ModelRequest } from "../../../kernel/src/index.js"
import { main, parseChaosDailyCliArgs } from "../src/daily-cli.js"
import { createProfileChatModel } from "../src/model-profiles.js"
import { loadTokenSwitchProfile, TOKEN_SWITCH_DOGFOOD_MODEL } from "../src/token-switch-profile.js"
import { createOpenCodeQwenLoopConfig } from "../src/qwen-loop-bridge.js"
import { main as yamlP81 } from "../src/yaml-687-p81-dogfood.js"
import { QwenHostLaunchError } from "../src/qwen.js"

const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function config() {
  return { provider: { "mode-test": { npm: "@ai-sdk/openai-compatible",
    options: { apiKey: "private-local-key", baseURL: "http://127.0.0.1:15722/opencode/mode-test/v1", setCacheKey: true },
    models: { "mode-test": { name: TOKEN_SWITCH_DOGFOOD_MODEL, limit: { context: 200000, output: 32000 } } },
  } } }
}
async function fixture(value = config()) {
  const root = await mkdtemp(join(tmpdir(), "chaos-token-switch-test-")); directories.push(root)
  const path = join(root, "opencode.json")
  await writeFile(path, JSON.stringify(value), { mode: 0o644 })
  return path
}
const request: ModelRequest = { attemptId: ids.attempt("private-attempt"), turn: 1, messages: [{ role: "user", content: "hello" }], tools: [] }
async function collect(stream: AsyncIterable<unknown>) { for await (const _event of stream) { /* drain fake model */ } }

describe("explicit Token Switch dogfood connection", () => {
  it("shows safe host-stage errors on company access rather than masking them", async () => {
    const path = await fixture(), stderr = vi.fn(), recordQwenEvent = vi.fn(async () => {})
    const prepare = vi.fn(async (args: { model: string }) => ({ root: "/repo", model: args.model, recordPath: "/unused", dirty: false, statusSummary: "" }))
    const qwenLauncher = vi.fn(async () => { throw new QwenHostLaunchError("version", "1.18.25") })
    expect(await main(["--qwen", "dogfood", "--token-switch-config", path], { prepare, qwenLauncher, stderr, stdout: () => {}, recordQwenEvent })).toBe(1)
    expect(stderr.mock.calls.flat().join("")).toContain("Detected: 1.18.25")
    expect(stderr.mock.calls.flat().join("")).toContain("[host:version]")
    expect(JSON.stringify(recordQwenEvent.mock.calls)).not.toContain("private-local-key")
  })

  it("selects each exact connection from multiple providers and only pins that connection", async () => {
    const value = config()
    const regular = structuredClone(value.provider["mode-test"])
    regular.models["mode-test"].name = "高级"
    const advanced = { ...regular, options: { ...regular.options, baseURL: "http://127.0.0.1:15722/opencode/mode-advanced/v1" }, models: { "mode-advanced": regular.models["mode-test"] } }
    Object.assign(value.provider, { "mode-advanced": advanced })
    const path = await fixture(value)
    const profile = await loadTokenSwitchProfile(path, "company", "高级")
    expect(profile.model).toBe("mode-advanced")
    expect((await loadTokenSwitchProfile(path, "dogfood", TOKEN_SWITCH_DOGFOOD_MODEL)).model).toBe("mode-test")
    await expect(loadTokenSwitchProfile(path)).rejects.toThrow("Select only")
    value.provider["mode-test"].options.apiKey = "unselected-key-change"
    await writeFile(path, JSON.stringify(value))
    await expect(profile.assertConnection!()).resolves.toBeUndefined()
    advanced.options.apiKey = "selected-key-change"
    await writeFile(path, JSON.stringify(value))
    await expect(profile.assertConnection!()).rejects.toThrow("connection changed")
    Object.assign(value.provider, { duplicate: advanced })
    await writeFile(path, JSON.stringify(value))
    await expect(loadTokenSwitchProfile(path, "company", "高级")).rejects.toThrow("ambiguous")
  })

  it.each(["Qwen3.8-Max", "高级", "Auto"])("uses the actual company selection %s without claiming DogFood", async name => {
    const value = config()
    value.provider["mode-test"].models["mode-test"].name = name
    const path = await fixture(value)
    const profile = await loadTokenSwitchProfile(path, "company")
    expect(profile).toMatchObject({ preserveHostUserAgent: true, access: { profile: "qwen-company", displayName: name } })
    await expect(loadTokenSwitchProfile(path)).rejects.toThrow("DogFooding")
    const qwenLauncher = vi.fn(), qwenProfileLoader = vi.fn(), stdout = vi.fn()
    if (name === "高级") {
      expect(await main(["--qwen", "company", "--token-switch-config", path, "--check-profile"], { qwenLauncher, qwenProfileLoader, stdout })).toBe(0)
      expect(stdout.mock.calls.flat().join("")).toContain(name)
    }
    expect(qwenLauncher).not.toHaveBeenCalled()
    expect(qwenProfileLoader).not.toHaveBeenCalled()
    value.provider["mode-test"].models["mode-test"].name = "different selection"
    await writeFile(path, JSON.stringify(value))
    const fetch = vi.fn()
    await expect(collect(createProfileChatModel(profile, fetch).stream(request, new AbortController().signal))).rejects.toThrow("connection changed")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("refuses to spend the other company pool and supports the explicit DogFood alias", async () => {
    const path = await fixture(), qwenLauncher = vi.fn(), stderr = vi.fn()
    expect(await main(["--qwen", "company", "--token-switch-config", path, "--check-profile"], { qwenLauncher, stderr })).toBe(2)
    expect(stderr.mock.calls.flat().join("")).toContain("missing or ambiguous")
    expect(await main(["--qwen", "dogfood", "--token-switch-config", path, "--check-profile"], { qwenLauncher, stdout: () => {} })).toBe(0)
    expect(qwenLauncher).not.toHaveBeenCalled()
  })

  it("routes personal Qwen to the existing private configuration without Token Switch", async () => {
    const qwenProfileLoader = vi.fn(async () => ({ apiKey: "personal-secret", model: "qwen3.8-max", baseUrl: "https://example.invalid/v1" }))
    const stdout = vi.fn(), qwenLauncher = vi.fn()
    expect(await main(["--qwen", "personal", "--check-profile"], { qwenProfileLoader, qwenLauncher, stdout })).toBe(0)
    expect(qwenProfileLoader).toHaveBeenCalledOnce()
    expect(qwenLauncher).not.toHaveBeenCalled()
    expect(stdout.mock.calls.flat().join("")).toContain('"source":"personal"')
    expect(stdout.mock.calls.flat().join("")).not.toContain("personal-secret")
  })

  it("supports independent company configuration paths and rejects ambiguous overrides", () => {
    expect(parseChaosDailyCliArgs(["--qwen", "company"], "/repo", { CHAOS_QWEN_COMPANY_CONFIG: "/private/company.json" }, "/home/test")).toMatchObject({ profile: "qwen-company", tokenSwitchConfig: "/private/company.json" })
    expect(parseChaosDailyCliArgs(["--qwen", "dogfood"], "/repo", { CHAOS_QWEN_DOGFOOD_CONFIG: "/private/dogfood.json" }, "/home/test")).toMatchObject({ profile: "dogfood", tokenSwitchConfig: "/private/dogfood.json" })
    for (const args of [["--qwen", "unknown"], ["--qwen", "company", "--model", "other"], ["--qwen", "company", "--profile", "qwen"], ["--qwen", "personal", "--token-switch-config", "file"], ["--qwen", "dogfood", "--token-switch"], ["--qwen", "company", "--qwen", "dogfood"]]) {
      expect(() => parseChaosDailyCliArgs(args, "/repo", {}, "/home/test")).toThrow()
    }
  })

  it("loads the local proxy without exporting credentials or importing host plugins", async () => {
    const path = await fixture(), before = await readFile(path, "utf8")
    const profile = await loadTokenSwitchProfile(path)
    expect(profile).toMatchObject({ model: "mode-test", access: { provider: "token-switch", displayName: TOKEN_SWITCH_DOGFOOD_MODEL,
      contextTokens: 200000, maxOutputTokens: 32000, setCacheKey: true } })
    const overlay = JSON.stringify(createOpenCodeQwenLoopConfig("http://127.0.0.1:1/v1", "relay-key", undefined, profile))
    expect(overlay).toContain(TOKEN_SWITCH_DOGFOOD_MODEL)
    expect(overlay).not.toContain("private-local-key")
    expect(overlay).not.toContain("15722")
    expect(await readFile(path, "utf8")).toBe(before)
    expect(Object.isFrozen(profile)).toBe(true)
  })

  it.each(["auto", "remote", "wrong-path", "headers", "limits", "multiple", "other-selection", "missing-key"])("rejects unsupported connection %s without leaking values", async kind => {
    const value = config(), provider = value.provider["mode-test"]
    if (kind === "auto") provider.models["mode-test"].name = "Auto"
    if (kind === "remote") provider.options.baseURL = "https://remote.invalid/opencode/mode-test/v1"
    if (kind === "wrong-path") provider.options.baseURL = "http://127.0.0.1:15722/opencode/other/v1"
    if (kind === "headers") Object.assign(provider.options, { headers: { authorization: "private-local-key" } })
    if (kind === "limits") provider.models["mode-test"].limit.output = 200001
    if (kind === "multiple") Object.assign(value.provider, { other: provider })
    if (kind === "other-selection") Object.assign(value, { model: "other/model" })
    if (kind === "missing-key") provider.options.apiKey = ""
    await expect(loadTokenSwitchProfile(await fixture(value))).rejects.toThrow(/Token Switch|Select only/)
  })

  it("rejects writable-shared files and symlinks without modifying source permissions", async () => {
    const path = await fixture()
    await chmod(path, 0o666)
    await expect(loadTokenSwitchProfile(path)).rejects.toThrow("shared write access")
    await chmod(path, 0o644)
    const link = `${path}.link`; await symlink(path, link)
    await expect(loadTokenSwitchProfile(link)).rejects.toThrow("symlinks")
  })

  it("passes the selected credential only upstream and maintains an opaque per-Attempt cache key", async () => {
    const profile = await loadTokenSwitchProfile(await fixture())
    const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'))
    const model = createProfileChatModel(profile, mock as typeof fetch)
    await collect(model.stream(request, new AbortController().signal))
    await collect(model.stream({ ...request, turn: 2 }, new AbortController().signal))
    const first = mock.mock.calls[0]!, second = mock.mock.calls[1]!
    expect(new Headers(first[1]?.headers).get("authorization")).toBe("Bearer private-local-key")
    const body = JSON.parse(String(first[1]?.body))
    expect(body.prompt_cache_key).toMatch(/^chaos-[0-9a-f]{64}$/)
    expect(body.prompt_cache_key).toBe(JSON.parse(String(second[1]?.body)).prompt_cache_key)
    expect(body).toMatchObject({ model: "mode-test", max_tokens: 32000 })
    expect(JSON.stringify(body)).not.toMatch(/private-local-key|private-attempt/)
    expect(body).not.toHaveProperty("enable_thinking")
  })

  it.each(["credential", "model"])("checks %s drift before dispatch and never uses the new selection", async kind => {
    const value = config(), path = await fixture(value), profile = await loadTokenSwitchProfile(path)
    if (kind === "credential") value.provider["mode-test"].options.apiKey = "changed-key"
    else value.provider["mode-test"].models["mode-test"].name = "Auto"
    await writeFile(path, JSON.stringify(value))
    const mock = vi.fn()
    await expect(collect(createProfileChatModel(profile, mock as typeof fetch).stream(request, new AbortController().signal))).rejects.toThrow("Token Switch")
    expect(mock).not.toHaveBeenCalled()
  })

  it("supports local checks and isolates the legacy Qwen and Codex launch paths", async () => {
    const path = await fixture(), qwenProfileLoader = vi.fn(), qwenLauncher = vi.fn(async () => 0), advancedLauncher = vi.fn()
    const stdout = vi.fn(), stderr = vi.fn(), recordQwenEvent = vi.fn(async () => {})
    const prepare = vi.fn(async (args: { model: string }) => ({ root: "/repo", model: args.model, recordPath: "/unused", dirty: false, statusSummary: "" }))
    const deps = { prepare, qwenProfileLoader, qwenLauncher, advancedLauncher, stdout, stderr, recordQwenEvent }
    expect(await main(["--token-switch-config", path, "--check-profile"], deps)).toBe(0)
    expect(prepare).not.toHaveBeenCalled(); expect(qwenLauncher).not.toHaveBeenCalled()
    expect(await main(["--token-switch-config", path], deps)).toBe(0)
    expect(qwenLauncher).toHaveBeenCalledTimes(1)
    expect(qwenProfileLoader).not.toHaveBeenCalled(); expect(advancedLauncher).not.toHaveBeenCalled()
    expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls, ...recordQwenEvent.mock.calls])).not.toContain("private-local-key")
    expect(recordQwenEvent).toHaveBeenCalledWith("/unused", expect.objectContaining({ profile: "dogfood", provider: "token-switch" }))
  })

  it("rejects conflicting CLI settings and protects the fixed YAML experiment", async () => {
    const args = parseChaosDailyCliArgs(["--token-switch", "--check-profile"], "/repo", {}, "/home/test")
    expect(args).toMatchObject({ profile: "dogfood", tokenSwitchConfig: "/home/test/.config/opencode/opencode.json", checkProfile: true })
    for (const extra of [["--model", "other"], ["--profiles", "file.json"], ["--profile", "qwen"], ["--env-file", "file"], ["--list-profiles"]]) {
      expect(() => parseChaosDailyCliArgs(["--token-switch", ...extra], "/repo", {}, "/home/test")).toThrow("do not combine")
    }
    const workspaceValidator = vi.fn(), dailyCli = vi.fn()
    expect(await yamlP81(["--token-switch"], { workspaceValidator, dailyCli, stderr: () => {} })).toBe(2)
    expect(workspaceValidator).not.toHaveBeenCalled(); expect(dailyCli).not.toHaveBeenCalled()
  })
})
