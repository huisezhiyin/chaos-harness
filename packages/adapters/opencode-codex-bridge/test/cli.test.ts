import { execFile } from "node:child_process"
import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import {
  assertCompatibleOpenCodeVersion,
  launchOpenCodeHostUx,
  main,
  parseOpenCodeHostUxCliArgs,
  resolveDefaultOpenCodeCommand,
  runOpenCodeHostUxSelfCheck,
} from "../src/cli.js"
import { OPENCODE_BRIDGE_MODEL } from "../src/server.js"

const execFileAsync = promisify(execFile)

describe("OpenCode Host UX CLI", () => {
  it("renders the native-TUI contract without starting any runtime", async () => {
    const selfCheck = vi.fn()
    const launch = vi.fn()
    const stdout: string[] = []

    await expect(main(["--help"], { selfCheck, launch, stdout: (text) => stdout.push(text) })).resolves.toBe(0)
    expect(selfCheck).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(stdout.join("")).toContain("opens the native OpenCode TUI")
    expect(stdout.join("")).toContain("until you submit text in the TUI")
  })

  it("keeps the interactive live gate closed by default", async () => {
    const launch = vi.fn()
    const stderr: string[] = []
    await expect(main([], { launch, stderr: (text) => stderr.push(text) })).resolves.toBe(2)
    expect(launch).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("live gate is closed")
  })

  it("runs only the model-free self-check path", async () => {
    const selfCheck = vi.fn(async () => selfCheckResult())
    const launch = vi.fn()
    const stdout: string[] = []
    await expect(main(["--self-check", "--root", "."], {
      selfCheck,
      launch,
      stdout: (text) => stdout.push(text),
    })).resolves.toBe(0)
    expect(selfCheck).toHaveBeenCalledTimes(1)
    expect(launch).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.join(""))).toMatchObject({ liveReady: false, workspace: "git_root" })
  })

  it("requires an exact model and an outside-workspace record for live mode", async () => {
    const launch = vi.fn()
    const stderr: string[] = []
    await expect(main(["--live"], { launch, stderr: (text) => stderr.push(text) })).resolves.toBe(2)
    expect(stderr.join("")).toContain("exact --model")
    stderr.length = 0
    await expect(main(["--live", "--model", "gpt-exact"], {
      launch,
      stderr: (text) => stderr.push(text),
    })).resolves.toBe(2)
    expect(stderr.join("")).toContain("outside-workspace --record")
    expect(launch).not.toHaveBeenCalled()
  })

  it("passes one reviewed live configuration to the launcher", async () => {
    const launch = vi.fn(async () => 0)
    await expect(main([
      "--live",
      "--root",
      "/repo",
      "--model",
      "gpt-exact",
      "--record",
      "/private/dogfood.jsonl",
      "--allow-dirty",
      "--timeout-ms",
      "1000",
    ], { launch })).resolves.toBe(0)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      root: "/repo",
      codexModel: "gpt-exact",
      recordPath: "/private/dogfood.jsonl",
      allowDirty: true,
      timeoutMs: 1000,
    }))
  })

  it("launches OpenCode with a process-only bridge overlay and closes it on exit", async () => {
    const fixture = await gitFixture()
    const recordDirectory = await realpath(await mkdtemp(join(tmpdir(), "chaos-record-")))
    const close = vi.fn(async () => {})
    const startBridge = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral-key",
      close,
    }))
    const verifyVersions = vi.fn(async () => ({ openCodeVersion: "1.18.26", codexVersion: "0.133.0" }))
    const runTui = vi.fn(async (input: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }) => {
      expect(input.command).toBe("opencode-exact")
      expect(input.args).toEqual(["--pure", fixture, "--model", OPENCODE_BRIDGE_MODEL])
      const config = JSON.parse(input.env.OPENCODE_CONFIG_CONTENT ?? "{}")
      expect(config).toMatchObject({
        theme: "system",
        model: OPENCODE_BRIDGE_MODEL,
        small_model: "chaos-codex/metadata",
        provider: {
          "chaos-codex": {
            options: { baseURL: "http://127.0.0.1:43123/v1", apiKey: "ephemeral-key" },
          },
        },
      })
      return 0
    })

    await expect(launchOpenCodeHostUx({
      root: fixture,
      codexModel: "gpt-exact",
      recordPath: join(recordDirectory, "dogfood.jsonl"),
      opencodeCommand: "opencode-exact",
      codexCommand: "codex-exact",
      timeoutMs: 1000,
      allowDirty: false,
      existingConfigContent: JSON.stringify({ theme: "system" }),
    }, { startBridge, verifyVersions, runTui })).resolves.toBe(0)

    expect(verifyVersions).toHaveBeenCalledWith("opencode-exact", "codex-exact")
    expect(startBridge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: fixture,
      codexModel: "gpt-exact",
      recordPath: join(recordDirectory, "dogfood.jsonl"),
      allowDirty: false,
    }))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes the bridge even when the OpenCode TUI fails", async () => {
    const fixture = await gitFixture()
    const recordDirectory = await realpath(await mkdtemp(join(tmpdir(), "chaos-record-")))
    const close = vi.fn(async () => {})
    await expect(launchOpenCodeHostUx({
      root: fixture,
      codexModel: "gpt-exact",
      recordPath: join(recordDirectory, "dogfood.jsonl"),
      opencodeCommand: "opencode-exact",
      codexCommand: "codex-exact",
      timeoutMs: 1000,
      allowDirty: false,
    }, {
      verifyVersions: async () => ({ openCodeVersion: "1.18.26", codexVersion: "0.133.0" }),
      startBridge: async () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "key", close }),
      runTui: async () => { throw new Error("tui failed") },
    })).rejects.toThrow("tui failed")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("runs a listener-only self-check without invoking an Attempt", async () => {
    const fixture = await gitFixture()
    const close = vi.fn(async () => {})
    const startBridge = vi.fn(async (options) => {
      expect(options.attemptRunner).toBeTypeOf("function")
      return { baseUrl: "http://127.0.0.1:2/v1", apiKey: "key", close }
    })
    const result = await runOpenCodeHostUxSelfCheck({
      root: fixture,
      opencodeCommand: "opencode-exact",
      codexCommand: "codex-exact",
      readOpenCodeVersion: async () => "1.18.26",
      readCodexVersion: async () => "0.133.0",
      startBridge,
    })
    expect(result).toEqual(selfCheckResult())
    expect(startBridge).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("parses executable names without turning PATH lookups into local paths", () => {
    expect(parseOpenCodeHostUxCliArgs([
      "--opencode-bin", "opencode-custom",
      "--codex-bin", "bin/codex",
    ], "/repo")).toMatchObject({
      opencodeCommand: "opencode-custom",
      codexCommand: "/repo/bin/codex",
    })
  })

  it("prefers the user-managed OpenCode install over a stale PATH binary", () => {
    const expected = "/home/test/.opencode/bin/opencode"
    expect(resolveDefaultOpenCodeCommand({}, "/home/test", (path) => path === expected)).toBe(expected)
    expect(resolveDefaultOpenCodeCommand({ OPENCODE_BIN: "opencode-reviewed" }, "/home/test", () => true))
      .toBe("opencode-reviewed")
    expect(resolveDefaultOpenCodeCommand({}, "/home/test", () => false)).toBe("opencode")
  })

  it("fails closed on OpenCode version drift", () => {
    expect(() => assertCompatibleOpenCodeVersion("1.18.25")).toThrow("expected 1.18.26")
  })
})

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chaos-opencode-root-"))
  await mkdir(join(root, "src"))
  await execFileAsync("git", ["init", "-q", root])
  return await realpath(root)
}

function selfCheckResult() {
  return {
    status: "ready" as const,
    liveReady: false as const,
    openCodeVersion: "1.18.26",
    codexVersion: "0.133.0",
    bridge: {
      host: "127.0.0.1" as const,
      config: "process_overlay" as const,
      codeModel: "chaos-codex/code-agent" as const,
      metadataModel: "chaos-codex/metadata" as const,
    },
    workspace: "git_root" as const,
  }
}
