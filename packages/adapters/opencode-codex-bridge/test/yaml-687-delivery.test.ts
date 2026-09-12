import { afterEach, describe, expect, it, vi } from "vitest"
import { createYamlDeliveryVerifier, validateYamlDeliveryIdentity, YAML_DELIVERY_ROOT } from "../src/yaml-687-delivery.js"
import { main } from "../src/yaml-687-delivery-dogfood.js"
import { YAML_687_FIXED_HEAD, YAML_687_ROOT } from "../src/yaml-687-verifier.js"
import { YAML_687_ATTEMPT_BUDGET } from "../src/yaml-687-dogfood.js"
import { YAML_687_P81_POLICY } from "../src/yaml-687-p81-dogfood.js"

afterEach(() => vi.unstubAllEnvs())
const context = { workspaceRoot: YAML_DELIVERY_ROOT, missionId: "m", unitId: "u", unitRevision: 1,
  attemptId: "a", goal: "Fix round-trip", completion: "Done", signal: new AbortController().signal }
function deps() {
  return { workspaceValidator: vi.fn(async () => YAML_DELIVERY_ROOT),
    sourceVerifier: { id: "source-fixture", verify: vi.fn(async () => ({ passed: true })) },
    checks: vi.fn(async () => ({ passed: true, failedChecks: [] as Array<"full-source-tests" | "source-types" | "test-types"> })),
    artifact: vi.fn(async () => ({ available: true as const, digest: "sha256:stable", changedPathCount: 2 })),
  }
}

describe("YAML delivery verifier", () => {
  it("requires source behavior and every delivery check to pass on the same artifact", async () => {
    const d = deps()
    expect(await createYamlDeliveryVerifier(d).verify(context)).toEqual({ passed: true })
    expect(d.artifact).toHaveBeenCalledTimes(2)
    expect(d.workspaceValidator).toHaveBeenCalledTimes(2)
    expect(d.checks).toHaveBeenCalledWith(YAML_DELIVERY_ROOT, context.signal)
  })
  it.each(["full-source-tests", "source-types", "test-types"] as const)("rejects source-correct artifacts with failing %s", async name => {
    const d = deps(); d.checks.mockResolvedValue({ passed: false, failedChecks: [name] })
    const result = await createYamlDeliveryVerifier(d).verify(context)
    expect(result.passed).toBe(false)
    expect(result.guidance).toContain(name)
    expect(d.sourceVerifier.verify).toHaveBeenCalledTimes(1)
  })
  it("does not accept checks from a different artifact revision", async () => {
    const d = deps(); d.artifact.mockResolvedValueOnce({ available: true, digest: "sha256:before", changedPathCount: 2 })
    const result = await createYamlDeliveryVerifier(d).verify(context)
    expect(result.passed).toBe(false); expect(result.guidance).toContain("Artifact changed")
  })
  it("runs the source gate before delivery commands", async () => {
    const d = deps(); d.sourceVerifier.verify.mockResolvedValue({ passed: false })
    expect((await createYamlDeliveryVerifier(d).verify(context)).passed).toBe(false)
    expect(d.checks).not.toHaveBeenCalled()
  })
  it("fails closed on timeout/configuration errors without publishing raw output", async () => {
    for (const phase of ["workspaceValidator", "checks"] as const) {
      const d = deps(); d[phase].mockRejectedValue(new Error("private diagnostic output"))
      const result = await createYamlDeliveryVerifier(d).verify(context)
      expect(result.passed).toBe(false)
      expect(JSON.stringify(result)).not.toContain("private diagnostic output")
    }
  })
  it("keeps the new root separate from historical roots and rejects SHA/origin drift", () => {
    const identity = { root: YAML_DELIVERY_ROOT, gitRoot: YAML_DELIVERY_ROOT, head: YAML_687_FIXED_HEAD,
      origin: "https://github.com/eemeli/yaml.git" }
    expect(() => validateYamlDeliveryIdentity(identity)).not.toThrow()
    expect(() => validateYamlDeliveryIdentity({ ...identity, root: YAML_687_ROOT, gitRoot: YAML_687_ROOT })).toThrow()
    for (const field of ["root", "gitRoot", "head", "origin"] as const) expect(() => validateYamlDeliveryIdentity({ ...identity, [field]: "wrong" })).toThrow()
  })
})

describe("Token Switch delivery launcher", () => {
  function setup() {
    return { dailyCli: vi.fn(async () => 0), workspaceValidator: vi.fn(async () => YAML_DELIVERY_ROOT),
      qualifier: vi.fn(async () => ({ passed: true, failedChecks: [] as string[] })), stdout: vi.fn(), stderr: vi.fn() }
  }
  it("keeps qualification model-free and propagates a failed qualification", async () => {
    const d = setup()
    expect(await main(["--qualify-only"], d)).toBe(0)
    expect(d.qualifier).toHaveBeenCalledWith(YAML_DELIVERY_ROOT, expect.any(AbortSignal))
    d.qualifier.mockResolvedValue({ passed: false, failedChecks: ["diagnostic rejection missing"] })
    expect(await main(["--qualify-only"], d)).toBe(1)
    expect(d.dailyCli).not.toHaveBeenCalled()
  })
  it("pins the DogFooding path, delivery verifier and unchanged P8.1 budget", async () => {
    const d = setup()
    expect(await main([], d)).toBe(0)
    expect(d.dailyCli).toHaveBeenCalledWith(["--root", YAML_DELIVERY_ROOT, "--token-switch"], expect.objectContaining({
      completionVerifier: expect.objectContaining({ id: "yaml-687-source-and-delivery-v1" }),
      attemptBudget: YAML_687_ATTEMPT_BUDGET, progressPolicy: YAML_687_P81_POLICY,
    }))
  })
  it("preserves the local-only connection check", async () => {
    const d = setup(); expect(await main(["--check-profile"], d)).toBe(0)
    expect(d.dailyCli).toHaveBeenCalledWith(["--root", YAML_DELIVERY_ROOT, "--token-switch", "--check-profile"], expect.anything())
  })
  it("rejects CLI overrides, inherited model overrides and invalid baseline before dispatch", async () => {
    const d = setup()
    for (const args of [["--root", "/other"], ["--model", "other"], ["--profile", "codex"], ["--token-switch-config", "other"], ["--qualify-only", "--check-profile"]]) {
      expect(await main(args, d)).toBe(2)
    }
    vi.stubEnv("CHAOS_MODEL", "other")
    expect(await main([], d)).toBe(2)
    vi.unstubAllEnvs()
    d.workspaceValidator.mockRejectedValue(new Error("dirty baseline"))
    expect(await main([], d)).toBe(2)
    expect(d.dailyCli).not.toHaveBeenCalled(); expect(d.qualifier).not.toHaveBeenCalled()
  })
})
