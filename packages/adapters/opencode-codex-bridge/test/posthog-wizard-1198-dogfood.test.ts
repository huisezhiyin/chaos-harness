import { describe, expect, it, vi } from "vitest"
import { main } from "../src/posthog-wizard-1198-dogfood.js"
import type { ChaosDailyCliArgs } from "../src/daily-cli.js"
import type { QwenCompletionVerifier } from "../src/qwen-loop-bridge.js"

describe("PostHog/wizard #1198 trusted dogfood launcher", () => {
  it("qualifies the trusted verifier without starting the daily provider path", async () => {
    const dailyCli = vi.fn(async () => 0)
    const workspaceValidator = vi.fn(async () => "/fixed-wizard")
    const verifier = acceptingVerifier()
    const output: string[] = []

    await expect(main(["--root", "/fixed-wizard", "--qualify-only"], {
      dailyCli,
      parseArgs: () => args(),
      workspaceValidator,
      verifier,
      stdout: (text) => output.push(text),
    })).resolves.toBe(0)

    expect(workspaceValidator).toHaveBeenCalledWith("/fixed-wizard")
    expect(verifier.verify).toHaveBeenCalledTimes(1)
    expect(dailyCli).not.toHaveBeenCalled()
    expect(output.join("")).toContain("qualification: passed")
  })

  it("injects the exact trusted verifier into the live daily launcher", async () => {
    const verifier = acceptingVerifier()
    const dailyCli = vi.fn(async (_argv, dependencies) => {
      expect(dependencies.completionVerifier).toBe(verifier)
      return 0
    })

    await expect(main(["--root", "/fixed-wizard"], {
      dailyCli,
      parseArgs: () => args(),
      workspaceValidator: async () => "/fixed-wizard",
      verifier,
      stdout: () => {},
      stderr: () => {},
    })).resolves.toBe(0)

    expect(dailyCli).toHaveBeenCalledWith(
      ["--root", "/fixed-wizard"],
      expect.objectContaining({ completionVerifier: verifier }),
    )
  })

  it("rejects a non-Qwen profile before workspace or provider launch", async () => {
    const workspaceValidator = vi.fn(async () => "/fixed-wizard")
    const dailyCli = vi.fn(async () => 0)
    const errors: string[] = []

    await expect(main(["--profile", "codex"], {
      dailyCli,
      parseArgs: () => ({ ...args(), profile: "codex" }),
      workspaceValidator,
      stderr: (text) => errors.push(text),
    })).resolves.toBe(2)

    expect(workspaceValidator).not.toHaveBeenCalled()
    expect(dailyCli).not.toHaveBeenCalled()
    expect(errors.join("")).toContain("supports only the qwen profile")
  })

  it("prints task-specific help without validating a workspace", async () => {
    const workspaceValidator = vi.fn(async () => "/fixed-wizard")
    const output: string[] = []

    await expect(main(["--help"], {
      workspaceValidator,
      stdout: (text) => output.push(text),
    })).resolves.toBe(0)

    expect(workspaceValidator).not.toHaveBeenCalled()
    expect(output.join("")).toContain("--qualify-only")
  })
})

function args(): ChaosDailyCliArgs {
  return {
    help: false,
    profile: "qwen",
    root: "/fixed-wizard",
    model: "qwen3.8-max",
    modelExplicit: false,
    stateDirectory: "/private-state",
    envFile: "/private-env",
  }
}

function acceptingVerifier(): QwenCompletionVerifier & { verify: ReturnType<typeof vi.fn> } {
  return {
    id: "posthog-wizard-1198-public-behavior-v1",
    verify: vi.fn(async () => ({ passed: true })),
  }
}
