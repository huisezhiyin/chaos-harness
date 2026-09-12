import { execFile } from "node:child_process"
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import { createOpenCodeQwenLoopConfig } from "../src/qwen-loop-bridge.js"
import { CHAOS_OBSERVATION_TOKEN_ENV } from "../src/opencode-observation-envelope.js"
import {
  DEFAULT_DASHSCOPE_BASE_URL,
  launchOpenCodeQwen,
  loadQwenProfile,
  parseQwenEnv,
  QWEN_PROVIDER,
} from "../src/qwen.js"

const execFileAsync = promisify(execFile)

describe("OpenCode native Qwen profile", () => {
  it.each(["1.18.25", "1.18.28", "bad-version-private-secret"])("rejects unqualified host %s before opening a bridge", async version => {
    const root = await gitFixture(), startBridge = vi.fn()
    const promise = launchOpenCodeQwen({ root, opencodeCommand: "fake",
      profile: { apiKey: "private-secret", baseUrl: "https://example.test", model: "fake" } }, {
      readVersion: async () => version, startBridge,
    })
    await expect(promise).rejects.toThrow("[host:version]")
    await expect(promise).rejects.not.toThrow("private-secret")
    expect(startBridge).not.toHaveBeenCalled()
  })

  it.each(["1.18.26", "1.18.27"])("keeps a named upstream key out of the host environment and resolved overlay on %s", async version => {
    const root = await gitFixture()
    const profile = { apiKey: "private-named-key", baseUrl: "https://example.test/v1", model: "vendor/model",
      access: { profile: "router", provider: "router", apiKeyEnv: "CUSTOM_API_KEY", dialect: "openai" as const,
        thinking: "default" as const, contextTokens: 32000, maxOutputTokens: 4096 } }
    const verifyHostProfile = vi.fn(async (input: { env: NodeJS.ProcessEnv }) => {
      expect(input.env.CUSTOM_API_KEY).toBeUndefined()
      expect(input.env.OPENCODE_CONFIG_CONTENT).not.toContain("private-named-key")
      expect(input.env.OPENCODE_CONFIG_CONTENT).not.toContain("https://example.test")
    })
    await expect(launchOpenCodeQwen({ root, profile, opencodeCommand: "fake", workspaceBoundary: "root-only" }, {
      readVersion: async () => version,
      prepareHostProfile: async () => ({ env: { CUSTOM_API_KEY: "private-named-key" }, dispose: async () => {} }),
      startBridge: async options => {
        expect(options.workspaceBoundary).toBe("root-only")
        return { baseUrl: "http://127.0.0.1:1/v1", apiKey: "relay-key", observationToken: "relay-observation", close: async () => {} }
      },
      verifyHostProfile, runTui: async input => {
        expect(input.env.CUSTOM_API_KEY).toBeUndefined()
        return 0
      },
    })).resolves.toBe(0)
    expect(verifyHostProfile).toHaveBeenCalledTimes(1)
  })

  it("does not open the TUI when host isolation fails and releases the bridge/profile", async () => {
    const root = await gitFixture()
    const close = vi.fn(async () => {}), dispose = vi.fn(async () => {}), runTui = vi.fn(async () => 0)
    await expect(launchOpenCodeQwen({ root, opencodeCommand: "fake-opencode",
      profile: { apiKey: "fake", baseUrl: DEFAULT_DASHSCOPE_BASE_URL, model: "fake" } }, {
      readVersion: async () => "1.18.26",
      prepareHostProfile: async () => ({ env: {}, dispose }),
      startBridge: async () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake", observationToken: "fake-observation-token-with-32-characters", close }),
      verifyHostProfile: async () => { throw new Error("Unexpected plugin") }, runTui,
    })).rejects.toThrow("[host:isolation]")
    expect(runTui).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("loads only known keys and gives process environment precedence", async () => {
    const path = await privateEnv([
      "DASHSCOPE_API_KEY=file-key",
      "DASHSCOPE_BASE_URL=https://file.example.test/v1/",
      "DASHSCOPE_MODEL=file-model",
      "UNRELATED_SECRET=must-not-load",
    ].join("\n"))
    const profile = await loadQwenProfile({
      envFilePath: path,
      env: {
        DASHSCOPE_API_KEY: "process-key",
        DASHSCOPE_MODEL: "process-model",
      },
    })
    expect(profile).toEqual({
      apiKey: "process-key",
      baseUrl: "https://file.example.test/v1",
      model: "process-model",
    })
    expect(parseQwenEnv("UNKNOWN_KEY=value\nDASHSCOPE_MODEL=qwen3.8-max\n"))
      .toEqual({ DASHSCOPE_MODEL: "qwen3.8-max" })
  })

  it("fails closed on an empty key and overly broad file permissions", async () => {
    const empty = await privateEnv(`DASHSCOPE_BASE_URL=${DEFAULT_DASHSCOPE_BASE_URL}\nDASHSCOPE_API_KEY=\n`)
    await expect(loadQwenProfile({ envFilePath: empty, env: {} }))
      .rejects.toThrow("DASHSCOPE_API_KEY is missing")

    const broad = await privateEnv("DASHSCOPE_API_KEY=secret\n")
    await chmod(broad, 0o644)
    await expect(loadQwenProfile({ envFilePath: broad, env: {} }))
      .rejects.toThrow("mode 0600")
  })

  it("keeps DashScope credentials and endpoint out of the OpenCode config", () => {
    const config = createOpenCodeQwenLoopConfig(
      "http://127.0.0.1:43123/v1",
      "ephemeral-bridge-token",
      "/harness/opencode-observation-plugin.ts",
    )
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain("real-secret")
    expect(serialized).not.toContain("dashscope.aliyuncs.com")
    expect(config).toMatchObject({
      model: `${QWEN_PROVIDER}/code-agent`,
      small_model: `${QWEN_PROVIDER}/metadata`,
      enabled_providers: [QWEN_PROVIDER],
      plugin: ["/harness/opencode-observation-plugin.ts"],
      provider: {
        [QWEN_PROVIDER]: {
          options: {
            baseURL: "http://127.0.0.1:43123/v1",
            apiKey: "ephemeral-bridge-token",
          },
          models: {
            "code-agent": { tool_call: true },
            metadata: { tool_call: false },
          },
        },
      },
    })
  })

  it.each(["p7", "p8"])("launches the pinned OpenCode through the local Chaos Loop bridge with %s composition", async (mode) => {
    const root = await gitFixture()
    const readVersion = vi.fn(async () => "1.18.26")
    const close = vi.fn(async () => {})
    const completionVerifier = {
      id: "task-specific-test",
      verify: vi.fn(async () => ({ passed: true })),
    }
    const attemptBudget = { maxTurns: 24, maxActions: 32, ...(mode === "p8" ? { evidenceClosure: { maxTurns: 4, maxActions: 6, allowedToolNames: ["read", "bash"] } } : {}) }
    const mutationProgressSteer = { afterActions: 16 }
    const progressOptions = mode === "p7" ? { mutationProgressSteer } : { progressPolicy: { explorationSoftLimit: 12, postSteerGraceActions: 6 }, unitBudget: { maxTurns: 30, maxActions: 40 }, noArtifactContinuation: { maxAdditionalActions: 4 } }
    const startBridge = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral-bridge-token",
      observationToken: "ephemeral-observation-token-with-32-chars",
      close,
    }))
    const runTui = vi.fn(async (input: {
      command: string
      args: readonly string[]
      env: NodeJS.ProcessEnv
    }) => {
      expect(input.command).toBe("opencode-exact")
      expect(input.args).toEqual([root, "--model", "chaos-qwen/code-agent"])
      expect(input.env.DASHSCOPE_API_KEY).toBeUndefined()
      expect(input.env.DASHSCOPE_BASE_URL).toBeUndefined()
      expect(input.env.DASHSCOPE_MODEL).toBeUndefined()
      expect(input.env.OPENCODE_CONFIG_CONTENT).not.toContain("real-secret")
      expect(input.env.OPENCODE_CONFIG_CONTENT).not.toContain(DEFAULT_DASHSCOPE_BASE_URL)
      expect(input.env.OPENCODE_CONFIG_CONTENT).not.toContain("ephemeral-observation-token-with-32-chars")
      expect(input.env[CHAOS_OBSERVATION_TOKEN_ENV]).toBe("ephemeral-observation-token-with-32-chars")
      expect(JSON.parse(input.env.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
        model: "chaos-qwen/code-agent",
        plugin: [expect.stringContaining("opencode-observation-plugin.ts")],
      })
      return 0
    })

    await expect(launchOpenCodeQwen({
      root,
      profile: {
        apiKey: "real-secret",
        baseUrl: DEFAULT_DASHSCOPE_BASE_URL,
        model: "qwen3.8-max",
      },
      opencodeCommand: "opencode-exact",
      completionVerifier,
      completionVerificationOrder: "artifact-first",
      workspacePathRecovery: { maxAdditionalActions: 2 },
      deliveryReadiness: { afterActions: 20, probe: completionVerifier },
      attemptBudget,
      modelLengthRecovery: "once-per-unit",
      ...progressOptions,
    }, { readVersion, startBridge, runTui, verifyHostProfile: vi.fn(async () => {}) })).resolves.toBe(0)
    expect(readVersion).toHaveBeenCalledWith("opencode-exact")
    expect(startBridge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: root,
      profile: expect.objectContaining({ apiKey: "real-secret", model: "qwen3.8-max" }),
      completionVerifier,
      completionVerificationOrder: "artifact-first",
      workspacePathRecovery: { maxAdditionalActions: 2 },
      deliveryReadiness: { afterActions: 20, probe: completionVerifier },
      attemptBudget,
      modelLengthRecovery: "once-per-unit",
      ...progressOptions,
    }))
    expect(runTui).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

async function privateEnv(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chaos-qwen-env-"))
  const path = join(directory, ".env")
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 })
  return path
}

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chaos-qwen-root-"))
  await execFileAsync("git", ["init", "-q", root])
  await execFileAsync("git", ["-C", root, "config", "user.email", "chaos@example.invalid"])
  await execFileAsync("git", ["-C", root, "config", "user.name", "Chaos Test"])
  await execFileAsync("git", ["-C", root, "commit", "--allow-empty", "-qm", "baseline"])
  return await realpath(root)
}
