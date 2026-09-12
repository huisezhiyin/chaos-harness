import { execFile } from "node:child_process"
import { lstat, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_DAILY_CODEX_MODEL,
  DEFAULT_DAILY_PROFILE,
  DEFAULT_QWEN_ENV_FILE,
  main,
  parseChaosDailyCliArgs,
  prepareChaosDailyLaunch,
  type PreparedChaosDailyLaunch,
} from "../src/daily-cli.js"

const execFileAsync = promisify(execFile)

describe("Chaos one-command launcher", () => {
  it("defaults to the current worktree, ChatGPT profile, and private user state", () => {
    expect(parseChaosDailyCliArgs([], "/repo", {}, "/home/test")).toEqual({
      help: false,
      profile: DEFAULT_DAILY_PROFILE,
      root: "/repo",
      model: "qwen3.8-max",
      modelExplicit: false,
      stateDirectory: "/home/test/.local/state/chaos-harness",
      envFile: DEFAULT_QWEN_ENV_FILE,
    })
  })

  it("keeps root, model, and state overrides available for advanced use", () => {
    expect(parseChaosDailyCliArgs([
      "--root", "../target",
      "--profile", "codex",
      "--model", "gpt-exact",
      "--state-dir", "../state",
      "--env-file", "../qwen.env",
    ], "/workspace/harness", {}, "/home/test")).toEqual({
      help: false,
      profile: "codex",
      root: "/workspace/target",
      model: "gpt-exact",
      modelExplicit: true,
      stateDirectory: "/workspace/state",
      envFile: "/workspace/qwen.env",
    })
  })

  it("prepares a stable outside-workspace journal and secures its directory", async () => {
    const root = await cleanGitFixture()
    const stateParent = await realpath(await mkdtemp(join(tmpdir(), "chaos-daily-state-parent-")))
    const stateDirectory = join(stateParent, "state")
    const first = await prepareChaosDailyLaunch({ root, model: "gpt-exact", stateDirectory })
    const second = await prepareChaosDailyLaunch({ root, model: "gpt-exact", stateDirectory })

    expect(first).toEqual(second)
    expect(first).toMatchObject({ root, model: "gpt-exact", dirty: false, statusSummary: "(clean)" })
    expect(first.recordPath.startsWith(`${stateDirectory}/`)).toBe(true)
    expect(first.recordPath).toMatch(/-[0-9a-f]{12}\.jsonl$/)
    expect((await lstat(stateDirectory)).mode & 0o077).toBe(0)

    const otherRoot = await cleanGitFixture()
    const other = await prepareChaosDailyLaunch({ root: otherRoot, model: "gpt-exact", stateDirectory })
    expect(other.recordPath).not.toBe(first.recordPath)
  })

  it("rejects a state path inside the worktree before creating it", async () => {
    const root = await cleanGitFixture()
    const stateDirectory = join(root, ".private-state")
    await expect(prepareChaosDailyLaunch({ root, model: "gpt-exact", stateDirectory }))
      .rejects.toThrow("outside the target worktree")
    await expect(lstat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a symlink state directory", async () => {
    const root = await cleanGitFixture()
    const parent = await mkdtemp(join(tmpdir(), "chaos-daily-link-parent-"))
    const target = await mkdtemp(join(tmpdir(), "chaos-daily-link-target-"))
    const stateDirectory = join(parent, "state")
    await symlink(target, stateDirectory)
    await expect(prepareChaosDailyLaunch({ root, model: "gpt-exact", stateDirectory }))
      .rejects.toThrow("not a symlink")
  })

  it.each(["p7", "p8"])("launches Qwen with %s composition without starting the Codex bridge", async (mode) => {
    const prepared = cleanPrepared()
    const advancedLauncher = vi.fn(async () => 0)
    const qwenLauncher = vi.fn(async () => 0)
    const completionVerifier = {
      id: "task-specific-test",
      verify: vi.fn(async () => ({ passed: true })),
    }
    const attemptBudget = { maxTurns: 24, maxActions: 32, ...(mode === "p8" ? { evidenceClosure: { maxTurns: 4, maxActions: 6, allowedToolNames: ["read", "bash"] } } : {}) }
    const mutationProgressSteer = { afterActions: 16 }
    const progressOptions = mode === "p7" ? { mutationProgressSteer } : { progressPolicy: { explorationSoftLimit: 12, postSteerGraceActions: 6 } }
    const confirmDirty = vi.fn(async () => true)
    const recordQwenEvent = vi.fn(async () => {})
    await expect(main([], {
      prepare: async () => prepared,
      confirmDirty,
      advancedLauncher,
      qwenProfileLoader: async () => ({
        apiKey: "secret",
        baseUrl: "https://dashscope.example.test/v1",
        model: "qwen3.8-max",
      }),
      qwenLauncher,
      completionVerifier,
      attemptBudget,
      ...progressOptions,
      opencodeCommand: "opencode-exact",
      recordQwenEvent,
      stdout: () => {},
    })).resolves.toBe(0)

    expect(confirmDirty).not.toHaveBeenCalled()
    expect(advancedLauncher).not.toHaveBeenCalled()
    expect(qwenLauncher).toHaveBeenCalledWith(expect.objectContaining({
      root: "/repo",
      profile: {
        apiKey: "secret",
        baseUrl: "https://dashscope.example.test/v1",
        model: "qwen3.8-max",
      },
      opencodeCommand: "opencode-exact",
      recordEvent: expect.any(Function),
      completionVerifier,
      attemptBudget,
      ...progressOptions,
    }))
    expect(recordQwenEvent).toHaveBeenCalledTimes(2)
  })

  it("keeps the existing Codex bridge as an explicit fallback", async () => {
    const prepared = { ...cleanPrepared(), model: DEFAULT_DAILY_CODEX_MODEL }
    const advancedLauncher = vi.fn(async () => 0)
    await expect(main(["--profile", "codex"], {
      prepare: async () => prepared,
      advancedLauncher,
      stdout: () => {},
    })).resolves.toBe(0)

    expect(advancedLauncher).toHaveBeenCalledWith([
      "--live",
      "--root", "/repo",
      "--model", DEFAULT_DAILY_CODEX_MODEL,
      "--record", "/private/repo.jsonl",
      "--allow-dirty",
    ])
  })

  it("requires one explicit confirmation for an already-dirty worktree", async () => {
    const prepared = { ...cleanPrepared(), dirty: true, statusSummary: " M src/file.ts" }
    const advancedLauncher = vi.fn(async () => 0)
    const stdout: string[] = []
    await expect(main([], {
      prepare: async () => prepared,
      qwenProfileLoader: async () => ({
        apiKey: "secret",
        baseUrl: "https://dashscope.example.test/v1",
        model: "qwen3.8-max",
      }),
      confirmDirty: async () => false,
      advancedLauncher,
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    })).resolves.toBe(2)
    expect(stdout.join("")).toContain("M src/file.ts")
    expect(advancedLauncher).not.toHaveBeenCalled()

    await expect(main([], {
      prepare: async () => prepared,
      qwenProfileLoader: async () => ({
        apiKey: "secret",
        baseUrl: "https://dashscope.example.test/v1",
        model: "qwen3.8-max",
      }),
      confirmDirty: async () => true,
      qwenLauncher: async () => 0,
      recordQwenEvent: async () => {},
      stdout: () => {},
    })).resolves.toBe(0)
    expect(advancedLauncher).not.toHaveBeenCalled()
  })

  it("writes only sanitized Qwen session events to a private journal", async () => {
    const { recordQwenSessionEvent } = await import("../src/daily-cli.js")
    const directory = await mkdtemp(join(tmpdir(), "chaos-qwen-journal-"))
    const path = join(directory, "session.jsonl")
    await recordQwenSessionEvent(path, {
      event: "session_started",
      profile: "qwen",
      model: "qwen3.8-max",
    })
    const content = await readFile(path, "utf8")
    expect(content).toContain('"event":"session_started"')
    expect(content).not.toContain("DASHSCOPE_API_KEY")
    expect((await lstat(path)).mode & 0o077).toBe(0)
  })

  it("detects real worktree changes for the confirmation summary", async () => {
    const root = await cleanGitFixture()
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8")
    const stateDirectory = join(await mkdtemp(join(tmpdir(), "chaos-daily-dirty-state-")), "state")
    const prepared = await prepareChaosDailyLaunch({ root, model: "gpt-exact", stateDirectory })
    expect(prepared.dirty).toBe(true)
    expect(prepared.statusSummary).toContain("dirty.txt")
  })
})

async function cleanGitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chaos-daily-root-"))
  await execFileAsync("git", ["init", "-q", root])
  await execFileAsync("git", ["-C", root, "config", "user.email", "chaos@example.invalid"])
  await execFileAsync("git", ["-C", root, "config", "user.name", "Chaos Test"])
  await execFileAsync("git", ["-C", root, "commit", "--allow-empty", "-qm", "baseline"])
  return await realpath(root)
}

function cleanPrepared(): PreparedChaosDailyLaunch {
  return {
    root: "/repo",
    model: DEFAULT_DAILY_CODEX_MODEL,
    recordPath: "/private/repo.jsonl",
    dirty: false,
    statusSummary: "(clean)",
  }
}
