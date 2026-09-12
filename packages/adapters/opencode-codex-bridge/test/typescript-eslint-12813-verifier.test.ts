import { describe, expect, it, vi } from "vitest"
import {
  TYPESCRIPT_ESLINT_12813_FIXED_HEAD,
  TYPESCRIPT_ESLINT_REPOSITORY,
  assessTypescriptEslint12813Result,
  assertTypescriptEslint12813ProbeIntegrity,
  createTypescriptEslint12813Verifier,
  qualifyTypescriptEslint12813Verifier,
  validateTypescriptEslint12813Identity,
  validateTypescriptEslint12813ProbeDigest,
  verifierChildEnvironment,
  type TypescriptEslint12813ProbeCaseResult,
  type TypescriptEslint12813ProbeResult,
  type TypescriptEslint12813ProbeScenario,
  type TypescriptEslint12813ProbeSuggestion,
} from "../src/typescript-eslint-12813-verifier.js"

type MutableProbeCase = Omit<TypescriptEslint12813ProbeCaseResult, "suggestions"> & {
  suggestions: TypescriptEslint12813ProbeSuggestion[]
}
type MutableProbeResult = Omit<TypescriptEslint12813ProbeResult, "cases"> & {
  cases: MutableProbeCase[]
}

describe("trusted typescript-eslint #12813 verifier", () => {
  it("accepts the valid rest behavior while preserving scalar and array controls", () => {
    expect(assessTypescriptEslint12813Result(fixedResult())).toEqual({
      passed: true,
      failedChecks: [],
    })
  })

  it("rejects scalar-rest, lost-diagnostic, and double-array mutants", () => {
    const scalarRest = fixedResult("fixture-scalar-rest")
    scalarRest.cases[0]!.suggestions[0] = {
      ...scalarRest.cases[0]!.suggestions[0]!,
      output: "function fn(...args: unknown) {}",
      ts2370Count: 1,
    }
    scalarRest.cases[0]!.autofix = {
      ...scalarRest.cases[0]!.autofix,
      output: "function fn(...args: unknown) {}",
      ts2370Count: 1,
    }
    expect(assessTypescriptEslint12813Result(scalarRest)).toMatchObject({ passed: false })

    const lostDiagnostic = fixedResult("fixture-lost-diagnostic")
    lostDiagnostic.cases[1] = { ...lostDiagnostic.cases[1]!, reportCount: 0, messageIds: [] }
    expect(assessTypescriptEslint12813Result(lostDiagnostic)).toMatchObject({ passed: false })

    const doubleArray = fixedResult("fixture-double-array")
    const array = doubleArray.cases.find((item) => item.id === "existing-rest-array")!
    array.suggestions[0] = {
      ...array.suggestions[0]!,
      output: "function existing(...args: unknown[][]) {}",
    }
    array.autofix = { ...array.autofix, output: "function existing(...args: unknown[][]) {}" }
    expect(assessTypescriptEslint12813Result(doubleArray)).toMatchObject({ passed: false })
  })

  it("qualifies an unfixed workspace, one fixed fixture, and three rejected mutants", async () => {
    const results = new Map<TypescriptEslint12813ProbeScenario, TypescriptEslint12813ProbeResult>([
      ["workspace", scalarRestResult("workspace")],
      ["fixture-fixed", fixedResult("fixture-fixed")],
      ["fixture-scalar-rest", scalarRestResult("fixture-scalar-rest")],
      ["fixture-lost-diagnostic", lostDiagnosticResult()],
      ["fixture-double-array", doubleArrayResult()],
    ])
    const probeRunner = vi.fn(async (_root, scenario: TypescriptEslint12813ProbeScenario) => results.get(scenario)!)

    await expect(qualifyTypescriptEslint12813Verifier(
      "/fixed-repo",
      new AbortController().signal,
      { workspaceValidator: async () => "/fixed-repo", probeRunner },
    )).resolves.toEqual({ passed: true, workspacePassed: false, failedChecks: [] })
    expect(probeRunner.mock.calls.map(([, scenario]) => scenario)).toEqual([
      "workspace",
      "fixture-fixed",
      "fixture-scalar-rest",
      "fixture-lost-diagnostic",
      "fixture-double-array",
    ])
  })

  it("returns bounded recovery guidance without leaking raw probe outputs", async () => {
    const result = scalarRestResult("workspace")
    result.cases[0]!.suggestions[0]!.output = "raw private probe output"
    const verifier = createTypescriptEslint12813Verifier({
      workspaceValidator: async () => "/fixed-repo",
      probeRunner: async () => result,
    })

    const verdict = await verifier.verify(context())
    expect(verdict).toEqual({
      passed: false,
      guidance: expect.stringContaining("public-behavior contract failed"),
    })
    expect(JSON.stringify(verdict)).not.toContain("raw private probe output")
  })

  it("rejects repository, package, SHA, and root identity drift", () => {
    const identity = {
      root: "/target",
      gitRoot: "/target",
      head: TYPESCRIPT_ESLINT_12813_FIXED_HEAD,
      packageName: "@typescript-eslint/typescript-eslint",
      origin: `${TYPESCRIPT_ESLINT_REPOSITORY}.git`,
    }
    expect(() => validateTypescriptEslint12813Identity(identity)).not.toThrow()
    expect(() => validateTypescriptEslint12813Identity({ ...identity, gitRoot: "/other" }))
      .toThrow("exact Git worktree root")
    expect(() => validateTypescriptEslint12813Identity({ ...identity, head: "wrong" }))
      .toThrow("requires fixed HEAD")
    expect(() => validateTypescriptEslint12813Identity({ ...identity, packageName: "other" }))
      .toThrow("wrong package identity")
    expect(() => validateTypescriptEslint12813Identity({ ...identity, origin: "https://example.test/repo" }))
      .toThrow("wrong origin repository")
  })

  it("binds the real probe to a reviewed digest and strips credential-like variables", async () => {
    await expect(assertTypescriptEslint12813ProbeIntegrity()).resolves.toBeUndefined()
    expect(() => validateTypescriptEslint12813ProbeDigest("0".repeat(64)))
      .toThrow("trusted probe digest changed")
    const environment = verifierChildEnvironment({
      PATH: "/bin",
      DASHSCOPE_API_KEY: "dashscope-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_PASSWORD: "database-secret",
      SAFE_FLAG: "visible",
    })
    expect(environment).toEqual(expect.objectContaining({
      PATH: "/bin",
      SAFE_FLAG: "visible",
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    }))
    expect(JSON.stringify(environment)).not.toContain("secret")
  })
})

function fixedResult(
  scenario: TypescriptEslint12813ProbeScenario = "fixture-fixed",
): MutableProbeResult {
  return {
    scenario,
    cases: [
      restCase("function-rest", "function fn(...args: unknown[]) {}", "function fn(...args: never[]) {}"),
      restCase("arrow-rest", "const fn = (...args: unknown[]) => {};", "const fn = (...args: never[]) => {};"),
      restCase("call-signature-rest", "type Fn = (...args: unknown[]) => void;", "type Fn = (...args: never[]) => void;"),
      restCase("method-signature-rest", "interface Api { fn(...args: unknown[]): void; }", "interface Api { fn(...args: never[]): void; }"),
      controlCase(
        "ordinary-scalar",
        "const value: unknown = 1;",
        "const value: never = 1;",
      ),
      controlCase(
        "existing-rest-array",
        "function existing(...args: unknown[]) {}",
        "function existing(...args: never[]) {}",
      ),
    ],
  }
}

function restCase(id: string, unknownOutput: string, neverOutput: string): MutableProbeCase {
  return controlCase(id, unknownOutput, neverOutput)
}

function controlCase(
  id: string,
  unknownOutput: string,
  neverOutput: string,
): MutableProbeCase {
  return {
    id,
    reportCount: 1,
    messageIds: ["unexpectedAny"],
    suggestions: [
      { messageId: "suggestUnknown", output: unknownOutput, remainingReportCount: 0, ts2370Count: 0 },
      { messageId: "suggestNever", output: neverOutput, remainingReportCount: 0, ts2370Count: 0 },
    ],
    autofix: {
      fixed: true,
      output: unknownOutput,
      remainingReportCount: 0,
      ts2370Count: 0,
    },
  }
}

function scalarRestResult(scenario: TypescriptEslint12813ProbeScenario): ReturnType<typeof fixedResult> {
  const result = fixedResult(scenario)
  const rest = result.cases[0]!
  rest.suggestions[0] = { ...rest.suggestions[0]!, ts2370Count: 1 }
  rest.autofix = { ...rest.autofix, ts2370Count: 1 }
  return result
}

function lostDiagnosticResult(): ReturnType<typeof fixedResult> {
  const result = fixedResult("fixture-lost-diagnostic")
  result.cases[0] = { ...result.cases[0]!, reportCount: 0, messageIds: [] }
  return result
}

function doubleArrayResult(): ReturnType<typeof fixedResult> {
  const result = fixedResult("fixture-double-array")
  const array = result.cases.find((item) => item.id === "existing-rest-array")!
  array.suggestions[0] = { ...array.suggestions[0]!, output: "function existing(...args: unknown[][]) {}" }
  array.autofix = { ...array.autofix, output: "function existing(...args: unknown[][]) {}" }
  return result
}

function context() {
  return {
    missionId: "mission",
    unitId: "unit",
    unitRevision: 1,
    attemptId: "attempt",
    workspaceRoot: "/workspace",
    goal: "resolve #12813",
    completion: "done",
    signal: new AbortController().signal,
  }
}
