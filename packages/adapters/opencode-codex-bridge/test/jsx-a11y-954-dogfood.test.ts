import { describe, expect, it, vi } from "vitest"
import {
  JSX_A11Y_954_ATTEMPT_BUDGET,
  JSX_A11Y_954_MODEL,
  main,
} from "../src/jsx-a11y-954-dogfood.js"
import type { ChaosDailyCliArgs } from "../src/daily-cli.js"
import type { QwenCompletionVerifier } from "../src/qwen-loop-bridge.js"

describe("jsx-a11y #954 trusted dogfood launcher", () => {
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

  it("pins model, verifier, and per-Attempt work/evidence budgets", async () => {
    const verifier = acceptingVerifier()
    const dailyCli = vi.fn(async (_argv, dependencies) => {
      expect(dependencies.completionVerifier).toBe(verifier)
      expect(dependencies.attemptBudget).toBe(JSX_A11Y_954_ATTEMPT_BUDGET)
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
      ["--root", "/fixed-repo", "--model", JSX_A11Y_954_MODEL],
      expect.objectContaining({
        completionVerifier: verifier,
        attemptBudget: {
          maxTurns: 16,
          maxActions: 24,
          evidenceClosure: {
            maxTurns: 4,
            maxActions: 6,
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
    expect(output.join("")).toContain("16 work turns / 24 work actions")
    expect(output.join("")).toContain("4-turn / 6-action read-only evidence closure")
  })
})

function args(): ChaosDailyCliArgs {
  return {
    help: false,
    profile: "qwen",
    root: "/fixed-repo",
    model: JSX_A11Y_954_MODEL,
    modelExplicit: false,
    stateDirectory: "/private-state",
    envFile: "/private-env",
  }
}

function acceptingVerifier(): QwenCompletionVerifier {
  return {
    id: "jsx-a11y-954-public-behavior-v1",
    verify: vi.fn(async () => ({ passed: true })),
  }
}
