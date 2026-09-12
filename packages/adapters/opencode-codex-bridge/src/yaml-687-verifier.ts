import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"

const exec = promisify(execFile)
const PROBE = fileURLToPath(new URL("./yaml-687-probe.mjs", import.meta.url))
const SANDBOX = "/usr/bin/sandbox-exec"
const POLICY = "(version 1)(allow default)(deny network*)(deny file-write*)"
const PROBE_DIGEST = "8e524ec09d27d9655b39bf87ca4322d7f0f85a31ff05f2f3ae5324734e574cf4"
export const YAML_687_FIXED_HEAD = "b91c3747333c7379bfd6edb6000fa163ca33805b"
export const YAML_687_ROOT = process.env.CHAOS_YAML_687_ROOT ?? join(homedir(), "chaos-dogfood", "yaml-687")
export const YAML_687_VERIFIER_ID = "yaml-687-source-roundtrip-v1"
const PACKAGE_DIGEST = "160c20163fb647215d7ae2185200553615aec4c206032d546189d56374a6c56d"
const LOCK_DIGEST = "c3d06817cfc782e04544feb2fb2193096870373d6205f675c34bee707be1ab13"

export interface Yaml687Case {
  id: string
  beforeValue: string
  afterValue: string
  beforeComment: string | null
  afterComment: string | null
  beforeErrors: number
  afterErrors: number
  threw: boolean
}
export interface Yaml687Result { version: 1; cases: readonly Yaml687Case[] }
export interface Yaml687Assessment { passed: boolean; failedChecks: readonly string[] }
type Runner = (root: string, signal: AbortSignal) => Promise<Yaml687Result>
const EXPECTED = new Map<string, { value: string; comment: string | null }>()
for (const style of ["|", ">"]) for (const indent of [1, 5, 9]) for (const multi of [false, true]) {
  EXPECTED.set(`root-${style}-${indent}-${multi ? "multi" : "single"}`, {
    value: JSON.stringify(""), comment: multi ? "first\nsecond" : "comment",
  })
}
for (const [id, value, comment] of [
  ["mapping-empty", { a: "" }, "comment"],
  ["sequence-empty", [""], "comment"],
  ["nested-empty", { a: { b: "" } }, "comment"],
  ["empty-no-comment", "", null],
  ["hash-content", "#content\n", null],
  ["nonempty-comment", "text\n", "comment"],
] as const) EXPECTED.set(id, { value: JSON.stringify(value), comment })

export function assessYaml687Result(result: Yaml687Result): Yaml687Assessment {
  const failedChecks: string[] = []
  if (result.version !== 1 || result.cases.length !== EXPECTED.size) failedChecks.push("invalid case coverage")
  for (const [id, expected] of EXPECTED) {
    const matches = result.cases.filter(item => item.id === id)
    if (matches.length !== 1) { failedChecks.push(`${id}: missing or duplicate evidence`); continue }
    const c = matches[0]!
    if (c.threw || c.beforeErrors !== 0 || c.afterErrors !== 0) failedChecks.push(`${id}: parse/serialize failed`)
    if (c.beforeValue !== expected.value || c.afterValue !== expected.value) failedChecks.push(`${id}: value not preserved`)
    if (c.beforeComment !== expected.comment || c.afterComment !== expected.comment) failedChecks.push(`${id}: comment not preserved`)
  }
  return { passed: failedChecks.length === 0, failedChecks }
}

export function parseYaml687Result(stdout: string): Yaml687Result {
  const value: unknown = JSON.parse(stdout)
  if (!record(value) || value.version !== 1 || !Array.isArray(value.cases)) throw new TypeError("Invalid probe envelope")
  const cases = value.cases.map((c: unknown): Yaml687Case => {
    if (!record(c) || typeof c.id !== "string" || typeof c.beforeValue !== "string" ||
      typeof c.afterValue !== "string" || !nullableString(c.beforeComment) || !nullableString(c.afterComment) ||
      typeof c.beforeErrors !== "number" || !Number.isInteger(c.beforeErrors) || c.beforeErrors < 0 ||
      typeof c.afterErrors !== "number" || !Number.isInteger(c.afterErrors) || c.afterErrors < 0 ||
      typeof c.threw !== "boolean") throw new TypeError("Invalid probe case")
    return c as unknown as Yaml687Case
  })
  return { version: 1, cases }
}

export function yaml687ChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Allowlist: no NODE_OPTIONS, loaders, provider credentials, or user config.
  return { PATH: env.PATH ?? "/usr/bin:/bin", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" }
}

export async function assertYaml687ProbeIntegrity(): Promise<void> {
  if (digest(await readFile(PROBE)) !== PROBE_DIGEST) throw new TypeError("YAML #687 trusted probe digest changed")
}

export function validateYaml687Identity(identity: { root: string; gitRoot: string; head: string; origin: string }): void {
  if (identity.root !== YAML_687_ROOT || identity.root !== identity.gitRoot) throw new TypeError("YAML #687 requires exact root")
  if (identity.head !== YAML_687_FIXED_HEAD) throw new TypeError("YAML #687 requires fixed HEAD")
  if (identity.origin !== "https://github.com/eemeli/yaml.git") throw new TypeError("YAML #687 requires official origin")
}

export async function assertYaml687Workspace(input: string, validateIdentity = validateYaml687Identity): Promise<string> {
  const root = await realpath(input)
  const run = (args: string[]) => exec("git", ["-C", root, ...args], { timeout: 5_000 })
  const [gitRoot, head, origin] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]), run(["rev-parse", "HEAD"]), run(["remote", "get-url", "origin"]),
  ])
  validateIdentity({ root, gitRoot: await realpath(gitRoot.stdout.trim()), head: head.stdout.trim(), origin: origin.stdout.trim() })
  for (const [name, expected] of [["package.json", PACKAGE_DIGEST], ["package-lock.json", LOCK_DIGEST]] as const) {
    const path = join(root, name)
    if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== expected) throw new TypeError("YAML #687 package/lock identity changed")
  }
  await sourceDigest(root)
  await Promise.all([access(SANDBOX), assertYaml687ProbeIntegrity()])
  return root
}

export async function runYaml687Probe(root: string, signal: AbortSignal): Promise<Yaml687Result> {
  await assertYaml687ProbeIntegrity()
  const { stdout } = await exec(SANDBOX, ["-p", POLICY, process.execPath, "--experimental-strip-types", PROBE, root], {
    cwd: root, env: yaml687ChildEnvironment(process.env), signal, timeout: 20_000, maxBuffer: 256 * 1024,
  })
  return parseYaml687Result(stdout)
}

export function createYaml687Verifier(options: {
  workspaceValidator?: typeof assertYaml687Workspace
  probeRunner?: Runner
  fingerprint?: typeof sourceDigest
} = {}): QwenCompletionVerifier {
  return {
    id: YAML_687_VERIFIER_ID,
    async verify(context) {
      try {
        const root = await (options.workspaceValidator ?? assertYaml687Workspace)(context.workspaceRoot)
        const fingerprint = options.fingerprint ?? sourceDigest
        const before = await fingerprint(root)
        const assessment = assessYaml687Result(await (options.probeRunner ?? runYaml687Probe)(root, context.signal))
        if (before !== await fingerprint(root)) return { passed: false, guidance: "YAML source changed during independent verification; validate the final artifact again." }
        return assessment.passed ? { passed: true } : {
          passed: false,
          guidance: ["YAML #687 public round-trip contract failed. Preserve scalar values and document comments without changing valid hash content or nested controls.", ...assessment.failedChecks].join("\n"),
        }
      } catch {
        return { passed: false, guidance: "YAML #687 identity or bounded source probe failed. Restore local prerequisites and verify the final artifact; raw probe diagnostics are not completion evidence." }
      }
    },
  }
}

export type Yaml687Variant = "baseline" | "fixed" | "literal-only" | "drop-comment" | "erase-content"
export function yaml687QualificationSource(source: string, variant: Yaml687Variant): string {
  const old = "if (!value) return literal ? '|\\n' : '>\\n'"
  if (source.split(old).length !== 2) throw new TypeError("Qualification baseline source anchor changed")
  if (variant === "baseline") return source
  const fixed = "if (!value) return (literal ? '|' : '>') + (indent ? '1' : '') + '\\n'"
  if (variant === "literal-only") return source.replace(old, "if (!value) return literal ? '|1\\n' : '>\\n'")
  if (variant === "erase-content") return source.replace(old, "return '\"\"\\n'")
  return source.replace(old, fixed)
}

export async function qualifyYaml687Verifier(rootInput: string, signal: AbortSignal, workspaceValidator = assertYaml687Workspace): Promise<{
  passed: boolean; workspacePassed: boolean; failedChecks: readonly string[]
}> {
  const root = await workspaceValidator(rootInput)
  const { stdout: dirty } = await exec("git", ["-C", root, "status", "--porcelain"], { timeout: 5_000 })
  if (dirty.trim()) throw new TypeError("Qualification requires the pristine baseline; never reset the target")
  const before = await sourceDigest(root)
  const temp = await mkdtemp(join(tmpdir(), "chaos-yaml-687-qualification-"))
  const results = new Map<Yaml687Variant, Yaml687Assessment>()
  try {
    for (const variant of ["baseline", "fixed", "literal-only", "drop-comment", "erase-content"] as const) {
      signal.throwIfAborted()
      const fixture = join(temp, variant)
      await cp(join(root, "src"), join(fixture, "src"), { recursive: true, errorOnExist: true, force: false })
      const path = join(fixture, "src/stringify/stringifyString.ts")
      await writeFile(path, yaml687QualificationSource(await readFile(path, "utf8"), variant))
      if (variant === "drop-comment") {
        const docPath = join(fixture, "src/doc/Document.ts")
        const doc = await readFile(docPath, "utf8")
        const anchor = "return stringifyDocument(this, options)"
        if (doc.split(anchor).length !== 2) throw new TypeError("Qualification document anchor changed")
        await writeFile(docPath, doc.replace(anchor, "this.comment = null; return stringifyDocument(this, options)"))
      }
      results.set(variant, assessYaml687Result(await runYaml687Probe(fixture, signal)))
    }
    if (before !== await sourceDigest(root)) throw new TypeError("Target source changed during qualification")
  } finally {
    // Only this invocation's generated fixture tree, never any user checkout.
    await rm(temp, { recursive: true, force: true })
  }
  const failedChecks: string[] = []
  for (const variant of ["baseline", "fixed", "literal-only", "drop-comment", "erase-content"] as const) {
    if (results.get(variant)?.passed !== (variant === "fixed")) failedChecks.push(`${variant}: unexpected qualification verdict`)
  }
  return { passed: failedChecks.length === 0, workspacePassed: results.get("baseline")?.passed === true, failedChecks }
}

export async function sourceDigest(root: string): Promise<string> {
  const hash = createHash("sha256")
  let files = 0
  async function walk(relative: string): Promise<void> {
    const path = join(root, relative)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new TypeError("Source symlinks are not allowed")
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(`${relative}/${name}`)
    } else if (info.isFile()) {
      if (++files > 1000 || info.size > 2_000_000) throw new TypeError("Source tree exceeds probe limits")
      hash.update(relative).update("\0").update(await readFile(path)).update("\0")
    } else throw new TypeError("Source tree must contain regular files")
  }
  await walk("src")
  return hash.digest("hex")
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === "string" }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
