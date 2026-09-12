import { execFile } from "node:child_process"
import { cp, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { promisify } from "node:util"
import { captureGitWorkspaceArtifactState } from "./git-artifact-state.js"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"
import { assertYaml687Workspace, validateYaml687Identity, YAML_687_ROOT, createYaml687Verifier,
  qualifyYaml687Verifier, yaml687ChildEnvironment, yaml687QualificationSource,
  assessYaml687Result, runYaml687Probe } from "./yaml-687-verifier.js"

const exec = promisify(execFile)
export const YAML_DELIVERY_ROOT = process.env.CHAOS_YAML_DELIVERY_ROOT ?? join(homedir(), "chaos-dogfood", "yaml-687-dogfood-delivery")
const CONFIGS = ["vitest.config.js", "tsconfig.json", "tests/tsconfig.json", "tests/_setup.ts"] as const
export type DeliveryCheck = "full-source-tests" | "source-types" | "test-types"
export interface DeliveryResult { passed: boolean; failedChecks: readonly DeliveryCheck[] }

export function validateYamlDeliveryIdentity(identity: Parameters<typeof validateYaml687Identity>[0], expectedRoot = YAML_DELIVERY_ROOT): void {
  if (identity.root !== expectedRoot || identity.gitRoot !== expectedRoot) {
    throw new TypeError("YAML delivery regression requires its independent exact root")
  }
  validateYaml687Identity({ ...identity, root: YAML_687_ROOT, gitRoot: YAML_687_ROOT })
}

export async function assertYamlDeliveryWorkspace(input: string, expectedRoot = YAML_DELIVERY_ROOT): Promise<string> {
  const root = await assertYaml687Workspace(input, identity => validateYamlDeliveryIdentity(identity, expectedRoot))
  for (const name of CONFIGS) {
    if (!(await lstat(join(root, name))).isFile()) throw new Error("Validation config must be a regular file")
    const { stdout } = await exec("git", ["-C", root, "show", `HEAD:${name}`], { timeout: 5000, encoding: "buffer" })
    if (!stdout.equals(await readFile(join(root, name)))) throw new Error("Pinned validation configuration changed")
  }
  const { stdout } = await exec("git", ["-C", root, "submodule", "status", "--", "tests/json-test-suite", "tests/yaml-test-suite"], { timeout: 5000 })
  const lines = stdout.trimEnd().split("\n")
  if (lines.length !== 2 || lines.some(line => !line.startsWith(" "))) throw new Error("Pinned test data is unavailable or changed")
  for (const name of ["tests/json-test-suite", "tests/yaml-test-suite"]) {
    const { stdout: dirty } = await exec("git", ["-C", join(root, name), "status", "--porcelain"], { timeout: 5000 })
    if (dirty.trim()) throw new Error("Pinned test data must remain clean")
  }
  return root
}

export async function assertYamlDeliveryBaseline(input: string, expectedRoot = YAML_DELIVERY_ROOT): Promise<string> {
  const root = await assertYamlDeliveryWorkspace(input, expectedRoot)
  const artifact = await captureGitWorkspaceArtifactState(root)
  if (!artifact.available || artifact.changedPathCount !== 0) throw new Error("Start only from the pristine delivery baseline; preserve prior attempts")
  return root
}

/** Fixed commands, no package-script substitution; target writes/network denied. */
export async function runYamlDeliveryChecks(root: string, signal: AbortSignal): Promise<DeliveryResult> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "chaos-yaml-delivery-check-")))
  const policy = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}))`
  const checks: Array<[DeliveryCheck, string[]]> = [
    ["full-source-tests", ["node_modules/vitest/vitest.mjs", "run", "--configLoader", "native", "--cache=false", "--maxWorkers=2"]],
    ["source-types", ["node_modules/typescript/bin/tsc", "--noEmit"]],
    ["test-types", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tests/tsconfig.json"]],
  ]
  const failedChecks: DeliveryCheck[] = []
  try {
    for (const [name, args] of checks) {
      signal.throwIfAborted()
      try {
        await exec("/usr/bin/sandbox-exec", ["-p", policy, process.execPath, ...args], {
          cwd: root, env: { ...yaml687ChildEnvironment(process.env), TMPDIR: scratch },
          signal, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
        })
      } catch { signal.throwIfAborted(); failedChecks.push(name) }
    }
    return { passed: failedChecks.length === 0, failedChecks }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

export function createYamlDeliveryVerifier(deps: {
  workspaceValidator?: (input: string) => Promise<string>
  sourceVerifier?: QwenCompletionVerifier
  checks?: typeof runYamlDeliveryChecks
  artifact?: typeof captureGitWorkspaceArtifactState
} = {}): QwenCompletionVerifier {
  const validate = deps.workspaceValidator ?? ((input: string) => assertYamlDeliveryWorkspace(input))
  const source = deps.sourceVerifier ?? createYaml687Verifier({ workspaceValidator: validate })
  const artifact = deps.artifact ?? captureGitWorkspaceArtifactState
  return { id: "yaml-687-source-and-delivery-v1", async verify(context) {
    try {
      const root = await validate(context.workspaceRoot)
      const before = await artifact(root)
      if (!before.available) return { passed: false, guidance: "Delivery artifact is unavailable." }
      const behavior = await source.verify(context)
      if (!behavior.passed) return behavior
      const checks = await (deps.checks ?? runYamlDeliveryChecks)(root, context.signal)
      const after = await artifact(root)
      await validate(root)
      if (!after.available || before.digest !== after.digest) return { passed: false, guidance: "Artifact changed during delivery verification; validate the final state again." }
      return checks.passed ? { passed: true } : { passed: false,
        guidance: `YAML behavior passed but delivery failed: ${checks.failedChecks.join(", ")}. Fix all failing tests and type errors, including temporary diagnostics, then validate the final diff.` }
    } catch {
      return { passed: false, guidance: "YAML delivery verification could not complete: check pinned configuration, test data, timeout and final artifact. No successful delivery was recorded." }
    }
  } }
}

export async function qualifyYamlDelivery(rootInput: string, signal: AbortSignal, validate: (input: string) => Promise<string> = input => assertYamlDeliveryWorkspace(input)) {
  const root = await validate(rootInput)
  const source = await qualifyYaml687Verifier(root, signal, validate)
  const baseline = await runYamlDeliveryChecks(root, signal)
  const failedChecks = [...source.failedChecks, ...baseline.failedChecks.map(name => `baseline:${name}`)]
  if (!source.passed || source.workspacePassed) failedChecks.push("source qualification")
  const scratch = await mkdtemp(join(tmpdir(), "chaos-yaml-delivery-qualification-"))
  try {
    for (const variant of ["fixed", "failing-diagnostic", "type-error"] as const) {
      signal.throwIfAborted()
      const fixture = join(scratch, variant)
      for (const name of ["src", "tests"]) await cp(join(root, name), join(fixture, name), { recursive: true, force: false, errorOnExist: true })
      for (const name of ["package.json", "vitest.config.js", "tsconfig.json"]) await cp(join(root, name), join(fixture, name), { force: false, errorOnExist: true })
      await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir")
      const path = join(fixture, "src/stringify/stringifyString.ts")
      await writeFile(path, yaml687QualificationSource(await readFile(path, "utf8"), "fixed"))
      if (variant !== "fixed") await writeFile(join(fixture, "tests/doc/delivery-diagnostic.ts"), variant === "failing-diagnostic"
        ? 'test("diagnostic", () => { throw new Error("fixture failure") })\n'
        : 'const broken: number = "fixture"\ntest("diagnostic", () => { expect(broken).toBe("fixture") })\n')
      const behavior = assessYaml687Result(await runYaml687Probe(fixture, signal))
      const delivery = await runYamlDeliveryChecks(fixture, signal)
      if (!behavior.passed || delivery.passed !== (variant === "fixed")) failedChecks.push(`${variant}:unexpected verdict`)
      if (variant === "failing-diagnostic" && !delivery.failedChecks.includes("full-source-tests")) failedChecks.push("diagnostic:missing test rejection")
      if (variant === "type-error" && !delivery.failedChecks.includes("test-types")) failedChecks.push("type-error:missing type rejection")
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
  return { passed: failedChecks.length === 0, failedChecks }
}
