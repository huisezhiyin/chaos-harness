import { describe, expect, it, vi } from "vitest"
import { main, YAML_687_P81_ROOT, YAML_687_P81_POLICY, validateYaml687P81Identity } from "../src/yaml-687-p81-dogfood.js"
import { YAML_687_ROOT, YAML_687_FIXED_HEAD, validateYaml687Identity, qualifyYaml687Verifier } from "../src/yaml-687-verifier.js"
import { YAML_687_ATTEMPT_BUDGET, YAML_687_PROGRESS_POLICY } from "../src/yaml-687-dogfood.js"
import type { ChaosDailyCliArgs } from "../src/daily-cli.js"

const args = (): ChaosDailyCliArgs => ({ help: false, profile: "qwen", root: YAML_687_P81_ROOT,
  model: "qwen3.8-max", modelExplicit: false, stateDirectory: "/unused-state", envFile: "/unused-env" })

describe("independent YAML P8.1 experiment binding", () => {
  it("separates the exact roots while preserving SHA/origin constraints", () => {
    const identity = { root: YAML_687_P81_ROOT, gitRoot: YAML_687_P81_ROOT,
      head: YAML_687_FIXED_HEAD, origin: "https://github.com/eemeli/yaml.git" }
    expect(() => validateYaml687P81Identity(identity)).not.toThrow()
    expect(() => validateYaml687Identity(identity)).toThrow("exact root")
    const original = { ...identity, root: YAML_687_ROOT, gitRoot: YAML_687_ROOT }
    expect(() => validateYaml687Identity(original)).not.toThrow()
    expect(() => validateYaml687P81Identity(original)).toThrow("independent exact root")
    for (const field of ["root", "gitRoot", "head", "origin"] as const) {
      expect(() => validateYaml687P81Identity({ ...identity, [field]: "wrong" })).toThrow()
    }
  })

  it("adds exactly one policy field, leaves the original frozen policy untouched", () => {
    expect(YAML_687_P81_POLICY).toEqual({ ...YAML_687_PROGRESS_POLICY, investigationExtensionActions: 4 })
    expect(YAML_687_PROGRESS_POLICY).not.toHaveProperty("investigationExtensionActions")
    expect(Object.isFrozen(YAML_687_P81_POLICY)).toBe(true)
  })

  it("qualifies the independent root without dispatching the daily/provider path", async () => {
    const dailyCli = vi.fn(async () => 0)
    const qualifier = vi.fn(async () => ({ passed: true, workspacePassed: false, failedChecks: [] }))
    expect(await main(["--root", YAML_687_P81_ROOT, "--qualify-only"], {
      dailyCli, qualifier, parseArgs: args, workspaceValidator: async () => YAML_687_P81_ROOT, stdout: () => {},
    })).toBe(0)
    expect(qualifier).toHaveBeenCalledWith(YAML_687_P81_ROOT, expect.any(AbortSignal))
    expect(dailyCli).not.toHaveBeenCalled()
  })

  it("composes the same budget and verifier with explicit P8.1 policy", async () => {
    const verifier = { id: "test-only", verify: async () => ({ passed: true }) }
    const dailyCli = vi.fn(async () => 0)
    expect(await main(["--root", YAML_687_P81_ROOT], { dailyCli, verifier, parseArgs: args,
      workspaceValidator: async () => YAML_687_P81_ROOT })).toBe(0)
    expect(dailyCli).toHaveBeenCalledWith(["--root", YAML_687_P81_ROOT, "--model", "qwen3.8-max"], expect.objectContaining({
      progressPolicy: YAML_687_P81_POLICY, attemptBudget: YAML_687_ATTEMPT_BUDGET, completionVerifier: verifier,
    }))
  })

  it("fails closed on wrong model, identity or qualification without a dispatch", async () => {
    const dailyCli = vi.fn(async () => 0)
    for (const patch of [
      { parseArgs: () => ({ ...args(), model: "other" }) },
      { workspaceValidator: async (): Promise<never> => { throw new Error("wrong identity") } },
    ]) {
      expect(await main([], { dailyCli, parseArgs: args, workspaceValidator: async () => YAML_687_P81_ROOT, stderr: () => {}, ...patch })).toBe(2)
    }
    expect(await main(["--qualify-only"], { dailyCli, parseArgs: args, workspaceValidator: async () => YAML_687_P81_ROOT,
      qualifier: async () => ({ passed: false, workspacePassed: false, failedChecks: [] }), stdout: () => {} })).toBe(1)
    expect(dailyCli).not.toHaveBeenCalled()
  })

  it("runs the qualification identity validator before any fixture or probe", async () => {
    const validator = vi.fn(async (): Promise<never> => { throw new Error("identity rejected") })
    await expect(qualifyYaml687Verifier("/must-not-exist", new AbortController().signal, validator)).rejects.toThrow("identity rejected")
    expect(validator).toHaveBeenCalledWith("/must-not-exist")
  })

  it("help is model-free and clearly identifies the independent experiment", async () => {
    const output: string[] = []
    const dailyCli = vi.fn(async () => 0)
    expect(await main(["--help"], { dailyCli, stdout: text => output.push(text) })).toBe(0)
    expect(output.join("")).toContain("not a resume")
    expect(output.join("")).toContain(YAML_687_P81_ROOT)
    expect(dailyCli).not.toHaveBeenCalled()
  })
})
