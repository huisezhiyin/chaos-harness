import { describe, expect, it, vi } from "vitest"
import {
  JSX_A11Y_954_FIXED_HEAD,
  JSX_A11Y_REPOSITORY,
  assessJsxA11y954Result,
  assertJsxA11y954ProbeIntegrity,
  createJsxA11y954Verifier,
  qualifyJsxA11y954Verifier,
  validateJsxA11y954Identity,
  validateJsxA11y954ProbeDigest,
  verifierChildEnvironment,
  type JsxA11y954ProbeCaseResult,
  type JsxA11y954ProbeResult,
  type JsxA11y954ProbeScenario,
} from "../src/jsx-a11y-954-verifier.js"

type MutableProbeCaseResult = Omit<JsxA11y954ProbeCaseResult, "diagnostics"> & {
  diagnostics: Array<{
    ruleId: string | null
    message: string
    fatal: boolean
  }>
}

type MutableProbeResult = Omit<JsxA11y954ProbeResult, "cases"> & {
  cases: MutableProbeCaseResult[]
}

describe("trusted jsx-a11y #954 verifier", () => {
  it("accepts dangerous HTML content while preserving empty and established controls", () => {
    expect(assessJsxA11y954Result(fixedResult())).toEqual({
      passed: true,
      failedChecks: [],
    })
  })

  it("rejects element-specific, lost-empty, and lost-established mutants", () => {
    const tdOnly = fixedResult("fixture-td-only")
    tdOnly.cases.find((item) => item.id === "native-dangerous")!.diagnostics = [diagnostic()]
    expect(assessJsxA11y954Result(tdOnly)).toMatchObject({ passed: false })

    const lostEmpty = fixedResult("fixture-lost-empty")
    lostEmpty.cases.find((item) => item.id === "empty-button")!.diagnostics = []
    expect(assessJsxA11y954Result(lostEmpty)).toMatchObject({ passed: false })

    const lostEstablished = fixedResult("fixture-lost-established")
    lostEstablished.cases.find((item) => item.id === "aria-control")!.diagnostics = [diagnostic()]
    expect(assessJsxA11y954Result(lostEstablished)).toMatchObject({ passed: false })
  })

  it("rejects missing, duplicate, parser, and wrong-message probe evidence", () => {
    const missing = fixedResult()
    missing.cases = missing.cases.filter((item) => item.id !== "issue-self-closing")
    expect(assessJsxA11y954Result(missing)).toMatchObject({ passed: false })

    const duplicate = fixedResult()
    duplicate.cases.push({ ...duplicate.cases[0]! })
    expect(assessJsxA11y954Result(duplicate)).toMatchObject({ passed: false })

    const parser = fixedResult()
    parser.cases.find((item) => item.id === "issue-explicit-closing")!.diagnostics = [{
      ruleId: null,
      message: "Parsing error",
      fatal: true,
    }]
    expect(assessJsxA11y954Result(parser)).toMatchObject({ passed: false })

    const wrongMessage = fixedResult()
    wrongMessage.cases.find((item) => item.id === "empty-td")!.diagnostics = [{
      ruleId: "chaos/control-has-associated-label",
      message: "wrong",
      fatal: false,
    }]
    expect(assessJsxA11y954Result(wrongMessage)).toMatchObject({ passed: false })
  })

  it("qualifies an unfixed workspace, one fixed fixture, and three rejected mutants", async () => {
    const results = new Map<JsxA11y954ProbeScenario, JsxA11y954ProbeResult>([
      ["workspace", workspaceResult()],
      ["fixture-fixed", fixedResult("fixture-fixed")],
      ["fixture-td-only", tdOnlyResult()],
      ["fixture-lost-empty", lostEmptyResult()],
      ["fixture-lost-established", lostEstablishedResult()],
    ])
    const probeRunner = vi.fn(async (_root, scenario: JsxA11y954ProbeScenario) => results.get(scenario)!)

    await expect(qualifyJsxA11y954Verifier(
      "/fixed-repo",
      new AbortController().signal,
      { workspaceValidator: async () => "/fixed-repo", probeRunner },
    )).resolves.toEqual({ passed: true, workspacePassed: false, failedChecks: [] })
    expect(probeRunner.mock.calls.map(([, scenario]) => scenario)).toEqual([
      "workspace",
      "fixture-fixed",
      "fixture-td-only",
      "fixture-lost-empty",
      "fixture-lost-established",
    ])
  })

  it("returns bounded recovery guidance without leaking raw probe messages", async () => {
    const result = workspaceResult()
    result.cases[0]!.diagnostics[0] = {
      ruleId: "chaos/control-has-associated-label",
      message: "raw private probe message",
      fatal: false,
    }
    const verifier = createJsxA11y954Verifier({
      workspaceValidator: async () => "/fixed-repo",
      probeRunner: async () => result,
    })

    const verdict = await verifier.verify(context())
    expect(verdict).toEqual({
      passed: false,
      guidance: expect.stringContaining("public-behavior contract failed"),
    })
    expect(JSON.stringify(verdict)).not.toContain("raw private probe message")
  })

  it("rejects repository, package, SHA, and root identity drift", () => {
    const identity = {
      root: "/target",
      gitRoot: "/target",
      head: JSX_A11Y_954_FIXED_HEAD,
      packageName: "eslint-plugin-jsx-a11y",
      origin: `${JSX_A11Y_REPOSITORY}.git`,
    }
    expect(() => validateJsxA11y954Identity(identity)).not.toThrow()
    expect(() => validateJsxA11y954Identity({ ...identity, gitRoot: "/other" }))
      .toThrow("exact Git worktree root")
    expect(() => validateJsxA11y954Identity({ ...identity, head: "wrong" }))
      .toThrow("requires fixed HEAD")
    expect(() => validateJsxA11y954Identity({ ...identity, packageName: "other" }))
      .toThrow("wrong package identity")
    expect(() => validateJsxA11y954Identity({ ...identity, origin: "https://example.test/repo" }))
      .toThrow("wrong origin repository")
  })

  it("binds the real probe to a reviewed digest and strips credential-like variables", async () => {
    await expect(assertJsxA11y954ProbeIntegrity()).resolves.toBeUndefined()
    expect(() => validateJsxA11y954ProbeDigest("0".repeat(64)))
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
      BABEL_DISABLE_CACHE: "1",
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    }))
    expect(JSON.stringify(environment)).not.toContain("secret")
  })
})

function fixedResult(
  scenario: JsxA11y954ProbeScenario = "fixture-fixed",
): MutableProbeResult {
  return {
    scenario,
    cases: [
      passCase("issue-self-closing"),
      passCase("issue-explicit-closing"),
      passCase("native-dangerous"),
      passCase("role-dangerous"),
      passCase("text-control"),
      passCase("aria-control"),
      failCase("empty-td"),
      failCase("empty-button"),
      failCase("empty-role"),
    ],
  }
}

function workspaceResult(): MutableProbeResult {
  const result = fixedResult("workspace")
  for (const id of [
    "issue-self-closing",
    "issue-explicit-closing",
    "native-dangerous",
    "role-dangerous",
  ]) {
    result.cases.find((item) => item.id === id)!.diagnostics = [diagnostic()]
  }
  return result
}

function tdOnlyResult(): MutableProbeResult {
  const result = fixedResult("fixture-td-only")
  result.cases.find((item) => item.id === "native-dangerous")!.diagnostics = [diagnostic()]
  result.cases.find((item) => item.id === "role-dangerous")!.diagnostics = [diagnostic()]
  return result
}

function lostEmptyResult(): MutableProbeResult {
  const result = fixedResult("fixture-lost-empty")
  for (const id of ["empty-td", "empty-button", "empty-role"]) {
    result.cases.find((item) => item.id === id)!.diagnostics = []
  }
  return result
}

function lostEstablishedResult(): MutableProbeResult {
  const result = fixedResult("fixture-lost-established")
  result.cases.find((item) => item.id === "text-control")!.diagnostics = [diagnostic()]
  result.cases.find((item) => item.id === "aria-control")!.diagnostics = [diagnostic()]
  return result
}

function passCase(id: string): MutableProbeCaseResult {
  return { id, diagnostics: [] }
}

function failCase(id: string): MutableProbeCaseResult {
  return { id, diagnostics: [diagnostic()] }
}

function diagnostic() {
  return {
    ruleId: "chaos/control-has-associated-label",
    message: "A control must be associated with a text label.",
    fatal: false,
  }
}

function context() {
  return {
    missionId: "mission",
    unitId: "unit",
    unitRevision: 1,
    attemptId: "attempt",
    workspaceRoot: "/workspace",
    goal: "resolve #954",
    completion: "done",
    signal: new AbortController().signal,
  }
}
