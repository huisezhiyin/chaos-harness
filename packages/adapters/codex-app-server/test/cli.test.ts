import { describe, expect, it, vi } from "vitest"
import { ids } from "../../../kernel/src/index.js"
import { main, parseCodexAgentCliArgs } from "../src/cli.js"

describe("Codex app-server CLI", () => {
  it("renders help without invoking self-check", async () => {
    const selfCheck = vi.fn()
    const stdout: string[] = []

    await expect(main(["--help"], {
      selfCheck,
      stdout: (text) => stdout.push(text),
    })).resolves.toBe(0)

    expect(selfCheck).not.toHaveBeenCalled()
    expect(stdout.join("")).toContain("never starts a Codex turn without --live")
  })

  it("runs only the model-free self-check path", async () => {
    const selfCheck = vi.fn(async () => ({
      status: "degraded" as const,
      liveReady: false as const,
      cliVersion: "0.133.0",
      schemaCompatibility: "codex-cli/0.133.0:stable",
      initialize: { platformFamily: "unix", platformOs: "macos", userAgent: "test" },
      modelList: { status: "safe_timeout" as const },
    }))
    const stdout: string[] = []

    await expect(main(["--self-check", "--model-list-timeout-ms", "25"], {
      selfCheck,
      stdout: (text) => stdout.push(text),
    })).resolves.toBe(0)

    expect(selfCheck).toHaveBeenCalledWith(expect.objectContaining({ modelListTimeoutMs: 25 }))
    expect(JSON.parse(stdout.join(""))).toMatchObject({ liveReady: false })
  })

  it("refuses a goal while the live gate is closed", async () => {
    const selfCheck = vi.fn()
    const stderr: string[] = []

    await expect(main(["--root", ".", "fix", "it"], {
      selfCheck,
      stderr: (text) => stderr.push(text),
    })).resolves.toBe(2)

    expect(selfCheck).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("Live Codex turn gate is closed")
  })

  it("parses workspace and timeout without enabling live mode", () => {
    expect(parseCodexAgentCliArgs(
      ["--root", "fixture", "--model-list-timeout-ms", "100", "inspect"],
      "/repo",
    )).toMatchObject({
      root: "/repo/fixture",
      goal: "inspect",
      selfCheck: false,
      live: false,
      modelListTimeoutMs: 100,
    })
  })

  it("records a model-free review without invoking self-check or live run", async () => {
    const selfCheck = vi.fn()
    const dogfoodRun = vi.fn()
    const dogfoodReview = vi.fn(async () => ({
      runId: "finished-run-id",
      recordPath: "/records/private-dogfood.jsonl",
      verification: "passed" as const,
      experience: "mixed" as const,
      intervention: "minor" as const,
    }))
    const stdout: string[] = []

    await expect(main([
      "--review",
      "--record",
      "/records/private-dogfood.jsonl",
      "--run-id",
      "finished-run-id",
      "--verification",
      "passed",
      "--experience",
      "mixed",
      "--intervention",
      "minor",
    ], {
      selfCheck,
      dogfoodRun,
      dogfoodReview,
      stdout: (text) => stdout.push(text),
    })).resolves.toBe(0)

    expect(selfCheck).not.toHaveBeenCalled()
    expect(dogfoodRun).not.toHaveBeenCalled()
    expect(dogfoodReview).toHaveBeenCalledWith({
      recordPath: "/records/private-dogfood.jsonl",
      runId: "finished-run-id",
      verification: "passed",
      experience: "mixed",
      intervention: "minor",
    })
    expect(stdout.join("")).toBe("dogfood review recorded\n")
    expect(stdout.join("")).not.toContain("/records/private-dogfood.jsonl")
  })

  it("rejects review mode conflicts before invoking any dogfood path", async () => {
    const selfCheck = vi.fn()
    const dogfoodRun = vi.fn()
    const dogfoodReview = vi.fn()
    const stderr: string[] = []

    for (const conflict of [
      ["--review", "--self-check"],
      ["--review", "--live"],
      ["--review", "--root", "."],
      ["--review", "--model", "gpt-exact"],
      ["--review", "--allow-dirty"],
      ["--review", "--timeout-ms", "100"],
      ["--review", "--model-list-timeout-ms", "100"],
      ["--review", "free-text-goal"],
    ]) {
      stderr.length = 0
      await expect(main(conflict, {
        selfCheck,
        dogfoodRun,
        dogfoodReview,
        stderr: (text) => stderr.push(text),
      })).resolves.toBe(2)
      expect(stderr.join("")).toContain("--review cannot be combined")
    }

    expect(selfCheck).not.toHaveBeenCalled()
    expect(dogfoodRun).not.toHaveBeenCalled()
    expect(dogfoodReview).not.toHaveBeenCalled()
  })

  it("requires all review enum arguments", async () => {
    const dogfoodReview = vi.fn()
    const stderr: string[] = []

    await expect(main([
      "--review",
      "--record",
      "/records/private-dogfood.jsonl",
      "--run-id",
      "finished-run-id",
      "--verification",
      "passed",
      "--experience",
      "mixed",
    ], {
      dogfoodReview,
      stderr: (text) => stderr.push(text),
    })).resolves.toBe(2)

    expect(dogfoodReview).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("--review requires --intervention")
  })

  it("rejects review-only arguments outside review mode", async () => {
    const selfCheck = vi.fn()
    const dogfoodRun = vi.fn()
    const dogfoodReview = vi.fn()
    const stderr: string[] = []

    for (const argv of [
      ["--self-check", "--run-id", "finished-run-id"],
      [
        "--live",
        "--root",
        "/workspace",
        "--model",
        "gpt-exact",
        "--record",
        "/records/private-dogfood.jsonl",
        "--verification",
        "passed",
        "goal",
      ],
      ["--experience", "mixed", "goal"],
      ["--intervention", "minor", "goal"],
    ]) {
      stderr.length = 0
      await expect(main(argv, {
        selfCheck,
        dogfoodRun,
        dogfoodReview,
        stderr: (text) => stderr.push(text),
      })).resolves.toBe(2)
      expect(stderr.join("")).toContain("require --review")
    }

    expect(selfCheck).not.toHaveBeenCalled()
    expect(dogfoodRun).not.toHaveBeenCalled()
    expect(dogfoodReview).not.toHaveBeenCalled()
  })

  it("runs one explicitly configured live dogfood attempt", async () => {
    const dogfoodRun = vi.fn(async () => ({
      runId: "safe-run-id",
      recordPath: "/records/dogfood.jsonl",
      verification: "pending" as const,
      boundaryViolation: false,
      result: {
        attemptId: ids.attempt("attempt-1"),
        runtime: { profile: "codex-app-server" },
        actions: [],
        artifacts: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
        events: [],
        status: "completion_proposed" as const,
        completion: "Finished the bounded task.",
      },
    }))
    const stdout: string[] = []
    const stderr: string[] = []

    await expect(main([
      "--live",
      "--root",
      "/workspace",
      "--model",
      "gpt-exact",
      "--record",
      "/records/dogfood.jsonl",
      "--timeout-ms",
      "2500",
      "fix",
      "it",
    ], {
      dogfoodRun,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })).resolves.toBe(0)

    expect(dogfoodRun).toHaveBeenCalledTimes(1)
    expect(dogfoodRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "/workspace",
      goal: "fix it",
      model: "gpt-exact",
      recordPath: "/records/dogfood.jsonl",
      timeoutMs: 2500,
      allowDirty: false,
    }))
    expect(stdout.join("")).toContain("Finished the bounded task.")
    expect(stderr.join("")).toContain("completion_proposed verification=pending boundary=passed")
  })

  it("requires an exact model and outside-workspace record for live mode", async () => {
    const dogfoodRun = vi.fn()
    const stderr: string[] = []

    await expect(main(["--live", "goal"], {
      dogfoodRun,
      stderr: (text) => stderr.push(text),
    })).resolves.toBe(2)
    expect(dogfoodRun).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("requires an exact --model")

    stderr.length = 0
    await expect(main(["--live", "--model", "gpt-exact", "goal"], {
      dogfoodRun,
      stderr: (text) => stderr.push(text),
    })).resolves.toBe(2)
    expect(stderr.join("")).toContain("requires an outside-workspace --record")
  })
})
