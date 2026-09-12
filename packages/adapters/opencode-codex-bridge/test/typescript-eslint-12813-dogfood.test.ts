import { describe, expect, it, vi } from "vitest"
import {
  TYPESCRIPT_ESLINT_12813_ATTEMPT_BUDGET,
  TYPESCRIPT_ESLINT_12813_MODEL,
  main,
} from "../src/typescript-eslint-12813-dogfood.js"
import type { ChaosDailyCliArgs } from "../src/daily-cli.js"
import type { QwenCompletionVerifier } from "../src/qwen-loop-bridge.js"

describe("typescript-eslint #12813 trusted dogfood launcher", () => {
  it("qualifies without loading the provider or daily TUI path", async () => {
    const dailyCli = vi.fn(async () => 0)
    const qualifier = vi.fn(async () => ({
      passed: true,
      workspacePassed: false,
      failedChecks: [],
    }))
    const output: string[] = []

    await expect(main(["--root", "/fixed-repo", "--qualify-only"], {
      dailyCli,
      parseArgs: () => args(),
      workspaceValidator: async () => "/fixed-repo",
      qualifier,
      stdout: (text) => output.push(text),
    })).resolves.toBe(0)

    expect(qualifier).toHaveBeenCalledWith("/fixed-repo", expect.any(AbortSignal))
    expect(dailyCli).not.toHaveBeenCalled()
    expect(output.join("")).toContain("qualification: passed")
    expect(output.join("")).toContain("rejected-as-expected")
  })

  it("pins model, verifier, and per-Attempt turn/action budget for live launch", async () => {
    const verifier = acceptingVerifier()
    const dailyCli = vi.fn(async (_argv, dependencies) => {
      expect(dependencies.completionVerifier).toBe(verifier)
      expect(dependencies.attemptBudget).toBe(TYPESCRIPT_ESLINT_12813_ATTEMPT_BUDGET)
      return 0
    })

    await expect(main(["--root", "/fixed-repo"], {
      dailyCli,
      parseArgs: () => args(),
      workspaceValidator: async () => "/fixed-repo",
      verifier,
      stdout: () => {},
      stderr: () => {},
    })).resolves.toBe(0)

    expect(dailyCli).toHaveBeenCalledWith(
      ["--root", "/fixed-repo", "--model", TYPESCRIPT_ESLINT_12813_MODEL],
      expect.objectContaining({
        completionVerifier: verifier,
        attemptBudget: {
          maxTurns: 24,
          maxActions: 32,
          evidenceClosure: {
            maxTurns: 5,
            maxActions: 8,
            allowedToolNames: expect.arrayContaining(["bash", "read", "todowrite"]),
          },
        },
      }),
    )
  })

  it("rejects another profile or model before workspace and provider launch", async () => {
    const workspaceValidator = vi.fn(async () => "/fixed-repo")
    const dailyCli = vi.fn(async () => 0)
    for (const invalid of [
      { ...args(), profile: "codex" as const },
      { ...args(), model: "other-model", modelExplicit: true },
    ]) {
      await expect(main([], {
        dailyCli,
        parseArgs: () => invalid,
        workspaceValidator,
        stdout: () => {},
        stderr: () => {},
      })).resolves.toBe(2)
    }
    expect(workspaceValidator).not.toHaveBeenCalled()
    expect(dailyCli).not.toHaveBeenCalled()
  })

  it("prints task-specific help without touching the workspace", async () => {
    const workspaceValidator = vi.fn(async () => "/fixed-repo")
    const output: string[] = []

    await expect(main(["--help"], {
      workspaceValidator,
      stdout: (text) => output.push(text),
    })).resolves.toBe(0)

    expect(workspaceValidator).not.toHaveBeenCalled()
    expect(output.join("")).toContain("--qualify-only")
    expect(output.join("")).toContain("24 work turns / 32 work actions")
    expect(output.join("")).toContain("5-turn / 8-action read-only evidence closure")
  })
})

function args(): ChaosDailyCliArgs {
  return {
    help: false,
    profile: "qwen",
    root: "/fixed-repo",
    model: TYPESCRIPT_ESLINT_12813_MODEL,
    modelExplicit: false,
    stateDirectory: "/private-state",
    envFile: "/private-env",
  }
}

function acceptingVerifier(): QwenCompletionVerifier {
  return {
    id: "typescript-eslint-12813-public-behavior-v1",
    verify: vi.fn(async () => ({ passed: true })),
  }
}
