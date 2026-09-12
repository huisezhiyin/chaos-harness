import { describe, expect, it, vi } from "vitest"
import {
  MARKOUT_45_FIXED_HEAD,
  MARKOUT_REPOSITORY,
  assessMarkout45Result,
  assertMarkout45ProbeIntegrity,
  createMarkout45Verifier,
  qualifyMarkout45Verifier,
  validateMarkout45Identity,
  validateMarkout45ProbeDigest,
  verifierChildEnvironment,
  type Markout45ProbeCaseResult,
  type Markout45ProbeResult,
  type Markout45ProbeScenario,
} from "../src/markout-45-verifier.js"

type MutableProbeResult = Omit<Markout45ProbeResult, "cases"> & {
  cases: Markout45ProbeCaseResult[]
}

const DOLLAR_ERROR = 'Attribute names cannot start with "$" (use ":" prefix for directives like ":aka", ":if", ":foreach")'
const EXPECTED_ATTRIBUTES = [
  ["at-click", "@click"],
  ["hash-slot", "#slot"],
  ["bracket-prop", "[prop]"],
  ["paren-event", "(evt)"],
  ["percent-x", "%x"],
  ["caret-y", "^y"],
  ["tilde-z", "~z"],
  ["ordinary-data", "data-x"],
  ["directive-aka", ":aka"],
  ["operator-plus", "class+"],
  ["operator-bang", "class!"],
] as const

describe("trusted Markout #45 verifier", () => {
  it("accepts all Issue names while preserving controls", () => {
    expect(assessMarkout45Result(fixedResult())).toEqual({
      passed: true,
      failedChecks: [],
    })
  })

  it("rejects over-broad, operator-loss, and partial punctuation mutants", () => {
    const overbroad = fixedResult("fixture-overbroad")
    replaceCase(overbroad, "reserved-dollar", acceptedCase("reserved-dollar", "$x"))
    expect(assessMarkout45Result(overbroad)).toMatchObject({ passed: false })

    const operatorLoss = fixedResult("fixture-operator-loss")
    replaceCase(operatorLoss, "operator-plus", rejectedCase("operator-plus"))
    replaceCase(operatorLoss, "operator-bang", rejectedCase("operator-bang"))
    expect(assessMarkout45Result(operatorLoss)).toMatchObject({ passed: false })

    const partial = fixedResult("fixture-partial")
    replaceCase(partial, "bracket-prop", rejectedCase("bracket-prop"))
    expect(assessMarkout45Result(partial)).toMatchObject({ passed: false })
  })

  it("qualifies an unfixed workspace, one fixed fixture, and three rejected mutants", async () => {
    const workspace = fixedResult("workspace")
    replaceCase(workspace, "at-click", rejectedCase("at-click"))
    const results = new Map<Markout45ProbeScenario, Markout45ProbeResult>([
      ["workspace", workspace],
      ["fixture-fixed", fixedResult("fixture-fixed")],
      ["fixture-overbroad", mutatedResult("fixture-overbroad", "reserved-dollar")],
      ["fixture-operator-loss", mutatedResult("fixture-operator-loss", "operator-plus")],
      ["fixture-partial", mutatedResult("fixture-partial", "bracket-prop")],
    ])
    const probeRunner = vi.fn(async (_root, scenario: Markout45ProbeScenario) => results.get(scenario)!)

    await expect(qualifyMarkout45Verifier(
      "/fixed-repo",
      new AbortController().signal,
      { workspaceValidator: async () => "/fixed-repo", probeRunner },
    )).resolves.toEqual({ passed: true, workspacePassed: false, failedChecks: [] })
    expect(probeRunner.mock.calls.map(([, scenario]) => scenario)).toEqual([
      "workspace",
      "fixture-fixed",
      "fixture-overbroad",
      "fixture-operator-loss",
      "fixture-partial",
    ])
  })

  it("returns bounded recovery guidance without leaking raw probe outputs", async () => {
    const result = fixedResult("workspace")
    replaceCase(result, "at-click", {
      ...rejectedCase("at-click"),
      errors: ["raw private probe output"],
    })
    const verifier = createMarkout45Verifier({
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
      head: MARKOUT_45_FIXED_HEAD,
      packageName: "markout-monorepo",
      origin: `${MARKOUT_REPOSITORY}.git`,
    }
    expect(() => validateMarkout45Identity(identity)).not.toThrow()
    expect(() => validateMarkout45Identity({ ...identity, gitRoot: "/other" }))
      .toThrow("exact Git worktree root")
    expect(() => validateMarkout45Identity({ ...identity, head: "wrong" }))
      .toThrow("requires fixed HEAD")
    expect(() => validateMarkout45Identity({ ...identity, packageName: "other" }))
      .toThrow("wrong package identity")
    expect(() => validateMarkout45Identity({ ...identity, origin: "https://example.test/repo" }))
      .toThrow("wrong origin repository")
  })

  it("binds the real probe to a reviewed digest and strips credential-like variables", async () => {
    await expect(assertMarkout45ProbeIntegrity()).resolves.toBeUndefined()
    expect(() => validateMarkout45ProbeDigest("0".repeat(64)))
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
  scenario: Markout45ProbeScenario = "fixture-fixed",
): MutableProbeResult {
  return {
    scenario,
    cases: [
      ...EXPECTED_ATTRIBUTES.map(([id, name]) => acceptedCase(id, name)),
      {
        id: "reserved-dollar",
        errors: [DOLLAR_ERROR],
        attributes: [],
        punctuationTagAccepted: false,
      },
      {
        id: "punctuation-tag",
        errors: [],
        attributes: [],
        punctuationTagAccepted: false,
      },
    ],
  }
}

function mutatedResult(
  scenario: Exclude<Markout45ProbeScenario, "workspace" | "fixture-fixed">,
  id: string,
): MutableProbeResult {
  const result = fixedResult(scenario)
  if (scenario === "fixture-overbroad") {
    replaceCase(result, id, acceptedCase(id, "$x"))
  } else {
    replaceCase(result, id, rejectedCase(id))
  }
  return result
}

function acceptedCase(id: string, name: string): Markout45ProbeCaseResult {
  return {
    id,
    errors: [],
    attributes: [{ name, value: "x" }],
    punctuationTagAccepted: false,
  }
}

function rejectedCase(id: string): Markout45ProbeCaseResult {
  return {
    id,
    errors: ["Unterminated tag BUTTON"],
    attributes: [],
    punctuationTagAccepted: false,
  }
}

function replaceCase(result: MutableProbeResult, id: string, replacement: Markout45ProbeCaseResult): void {
  const index = result.cases.findIndex(item => item.id === id)
  result.cases[index] = replacement
}

function context() {
  return {
    missionId: "mission",
    unitId: "unit",
    unitRevision: 1,
    attemptId: "attempt",
    workspaceRoot: "/workspace",
    goal: "resolve Markout #45",
    completion: "done",
    signal: new AbortController().signal,
  }
}
