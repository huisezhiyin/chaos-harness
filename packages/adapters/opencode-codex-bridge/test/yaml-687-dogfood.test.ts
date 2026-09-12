import { describe, expect, it, vi } from "vitest"
import {
  YAML_687_ATTEMPT_BUDGET,
  YAML_687_MODEL,
  YAML_687_PROGRESS_POLICY,
  main,
} from "../src/yaml-687-dogfood.js"
import type { ChaosDailyCliArgs } from "../src/daily-cli.js"
import type { QwenCompletionVerifier } from "../src/qwen-loop-bridge.js"

describe("YAML #687 trusted dogfood launcher", () => {
  it("stops on failed or unavailable qualification without dispatch", async () => {
    const dailyCli = vi.fn(async () => 0)
    for (const qualifier of [
      async () => ({ passed: false, workspacePassed: false, failedChecks: ["fixed rejected"] }),
      async (): Promise<never> => { throw new Error("private diagnostic") },
    ]) {
      const errors: string[] = []
      expect(await main(["--qualify-only"], {
        dailyCli, qualifier, parseArgs: () => args(), workspaceValidator: async () => "/fixed-repo",
        stdout: () => {}, stderr: text => errors.push(text),
      })).toBe(1)
      expect(errors.join("")).not.toContain("private diagnostic")
    }
    expect(dailyCli).not.toHaveBeenCalled()
  })

  it("rejects workspace identity failure before dispatch", async () => {
    const dailyCli = vi.fn(async () => 0)
    expect(await main([], { dailyCli, parseArgs: () => args(),
      workspaceValidator: async () => { throw new TypeError("wrong SHA") }, stderr: () => {},
    })).toBe(2)
    expect(dailyCli).not.toHaveBeenCalled()
  })

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
      stdout: text => output.push(text),
    })).resolves.toBe(0)

    expect(qualifier).toHaveBeenCalledWith("/fixed-repo", expect.any(AbortSignal))
    expect(dailyCli).not.toHaveBeenCalled()
    expect(output.join("")).toContain("qualification: passed")
    expect(output.join("")).toContain("rejected-as-expected")
  })

  it("pins model, verifier, and a bounded per-Attempt budget for live launch", async () => {
    const verifier = acceptingVerifier()
    const dailyCli = vi.fn(async (_argv, dependencies) => {
      expect(dependencies.completionVerifier).toBe(verifier)
      expect(dependencies.attemptBudget).toBe(YAML_687_ATTEMPT_BUDGET)
      expect(dependencies.progressPolicy).toBe(YAML_687_PROGRESS_POLICY)
      expect(dependencies.mutationProgressSteer).toBeUndefined()
      expect(Object.isFrozen(YAML_687_PROGRESS_POLICY)).toBe(true)
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
      ["--root", "/fixed-repo", "--model", YAML_687_MODEL],
      expect.objectContaining({
        completionVerifier: verifier,
        attemptBudget: {
          maxTurns: 18,
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
      stdout: text => output.push(text),
    })).resolves.toBe(0)

    expect(workspaceValidator).not.toHaveBeenCalled()
    expect(output.join("")).toContain("--qualify-only")
    expect(output.join("")).toContain("18 work turns / 24 work actions")
    expect(output.join("")).toContain("4-turn / 6-action read-only evidence closure")
  })
})

function args(): ChaosDailyCliArgs {
  return {
    help: false,
    profile: "qwen",
    root: "/fixed-repo",
    model: YAML_687_MODEL,
    modelExplicit: false,
    stateDirectory: "/private-state",
    envFile: "/private-env",
  }
}

function acceptingVerifier(): QwenCompletionVerifier {
  return {
    id: "yaml-687-public-behavior-v1",
    verify: vi.fn(async () => ({ passed: true })),
  }
}
