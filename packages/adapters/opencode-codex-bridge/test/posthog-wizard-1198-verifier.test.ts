import { describe, expect, it } from "vitest"
import {
  POSTHOG_WIZARD_1198_FIXED_HEAD,
  assessPostHogWizard1198Results,
  assertPostHogWizard1198ProbeIntegrity,
  createPostHogWizard1198Verifier,
  validatePostHogWizard1198Identity,
  validatePostHogWizard1198ProbeDigest,
  verifierChildEnvironment,
  type PostHogWizard1198ProbeResult,
} from "../src/posthog-wizard-1198-verifier.js"

describe("trusted PostHog/wizard #1198 verifier", () => {
  it("accepts the fixed public behavior matrix", () => {
    expect(assessPostHogWizard1198Results(fixedResults())).toEqual({
      passed: true,
      failedChecks: [],
    })
  })

  it("rejects a broken benign-survival contract", () => {
    const results = fixedResults()
    results[0] = { ...results[0]!, exitCode: 1, stdout: "" }

    expect(assessPostHogWizard1198Results(results)).toEqual({
      passed: false,
      failedChecks: ["benign transport timeout did not preserve a healthy process"],
    })
  })

  it("rejects a fatal-exit-0 mutant", () => {
    const results = fixedResults()
    results[1] = { ...results[1]!, exitCode: 0 }

    expect(assessPostHogWizard1198Results(results)).toEqual({
      passed: false,
      failedChecks: ["fatal hung-flush path did not produce the required non-zero crash result"],
    })
  })

  it("runs both independent scenarios and returns only bounded repair guidance", async () => {
    const scenarios: string[] = []
    const verifier = createPostHogWizard1198Verifier({
      workspaceValidator: async () => "/fixed-wizard",
      probeRunner: async (_root, scenario) => {
        scenarios.push(scenario)
        return scenario === "benign"
          ? fixedResults()[0]!
          : { ...fixedResults()[1]!, exitCode: 0, stderr: "raw private diagnostic" }
      },
    })

    await expect(verifier.verify(context())).resolves.toEqual({
      passed: false,
      guidance: expect.stringContaining("fatal hung-flush path"),
    })
    expect(scenarios).toEqual(["benign", "fatal-hung-flush"])
    expect(JSON.stringify(await verifier.verify(context()))).not.toContain("raw private diagnostic")
  })

  it("fails closed without leaking a probe execution failure", async () => {
    const verifier = createPostHogWizard1198Verifier({
      workspaceValidator: async () => "/fixed-wizard",
      probeRunner: async () => { throw new Error("private child failure") },
    })

    const verdict = await verifier.verify(context())
    expect(verdict).toEqual({
      passed: false,
      guidance: expect.stringContaining("could not complete"),
    })
    expect(JSON.stringify(verdict)).not.toContain("private child failure")
  })

  it("rejects workspace identity drift", () => {
    expect(() => validatePostHogWizard1198Identity({
      root: "/target",
      gitRoot: "/different",
      head: POSTHOG_WIZARD_1198_FIXED_HEAD,
      packageName: "@posthog/wizard",
    })).toThrow("exact Git worktree root")
    expect(() => validatePostHogWizard1198Identity({
      root: "/target",
      gitRoot: "/target",
      head: "wrong",
      packageName: "@posthog/wizard",
    })).toThrow("requires fixed HEAD")
    expect(() => validatePostHogWizard1198Identity({
      root: "/target",
      gitRoot: "/target",
      head: POSTHOG_WIZARD_1198_FIXED_HEAD,
      packageName: "other",
    })).toThrow("must contain @posthog/wizard")
  })

  it("binds every real probe run to the reviewed Harness-owned source digest", async () => {
    await expect(assertPostHogWizard1198ProbeIntegrity()).resolves.toBeUndefined()
    expect(() => validatePostHogWizard1198ProbeDigest("0".repeat(64)))
      .toThrow("trusted probe digest changed")
  })

  it("removes credential-like variables from verifier children", () => {
    expect(verifierChildEnvironment({
      PATH: "/bin",
      DASHSCOPE_API_KEY: "dashscope-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_PASSWORD: "database-secret",
      SAFE_FLAG: "visible",
    })).toEqual(expect.objectContaining({
      PATH: "/bin",
      SAFE_FLAG: "visible",
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    }))
    const serialized = JSON.stringify(verifierChildEnvironment({
      DASHSCOPE_API_KEY: "dashscope-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_PASSWORD: "database-secret",
    }))
    expect(serialized).not.toContain("secret")
  })
})

function fixedResults(): PostHogWizard1198ProbeResult[] {
  return [
    {
      scenario: "benign",
      exitCode: 0,
      stdout: "CHAOS_PROBE_ALIVE\n",
      stderr: "",
    },
    {
      scenario: "fatal-hung-flush",
      exitCode: 1,
      stdout: "",
      stderr: 'Wizard crashed: genuine fatal boom\n{"code":"PHW_INTERNAL_UNHANDLED"}',
    },
  ]
}

function context() {
  return {
    missionId: "mission",
    unitId: "unit",
    unitRevision: 1,
    attemptId: "attempt",
    workspaceRoot: "/workspace",
    goal: "verify #1198",
    completion: "done",
    signal: new AbortController().signal,
  }
}
