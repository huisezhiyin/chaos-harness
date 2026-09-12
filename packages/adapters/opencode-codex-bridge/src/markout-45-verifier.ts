import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type {
  QwenCompletionVerifier,
  QwenCompletionVerifierContext,
} from "./qwen-loop-bridge.js"

const execFileAsync = promisify(execFile)
const PROBE_PATH = fileURLToPath(new URL("./markout-45-probe.mjs", import.meta.url))
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const MACOS_PROBE_SANDBOX = "(version 1)(allow default)(deny network*)(deny file-write*)"
const EXPECTED_PROBE_SHA256 = "4e86c0ce53fc923f20c848f286e2822e896b823bc778b6e80d47f91ce30b17f7"
const DOLLAR_ERROR = 'Attribute names cannot start with "$" (use ":" prefix for directives like ":aka", ":if", ":foreach")'

export const MARKOUT_45_VERIFIER_ID = "markout-45-public-behavior-v1"
export const MARKOUT_45_FIXED_HEAD = "edc7e40470887a1d2236d1843509b73c28a7a63f"
export const MARKOUT_REPOSITORY = "https://github.com/fcapolini/markout"

export type Markout45ProbeScenario =
  | "workspace"
  | "fixture-fixed"
  | "fixture-overbroad"
  | "fixture-operator-loss"
  | "fixture-partial"

export interface Markout45ProbeAttribute {
  name: string
  value: string | null
}

export interface Markout45ProbeCaseResult {
  id: string
  errors: readonly string[]
  attributes: readonly Markout45ProbeAttribute[]
  punctuationTagAccepted: boolean
}

export interface Markout45ProbeResult {
  scenario: Markout45ProbeScenario
  cases: readonly Markout45ProbeCaseResult[]
}

export interface Markout45Assessment {
  passed: boolean
  failedChecks: readonly string[]
}

export interface Markout45WorkspaceIdentity {
  root: string
  gitRoot: string
  head: string
  packageName: string
  origin: string
}

export interface Markout45Qualification {
  passed: boolean
  workspacePassed: boolean
  failedChecks: readonly string[]
}

type ProbeRunner = (
  workspaceRoot: string,
  scenario: Markout45ProbeScenario,
  signal: AbortSignal,
) => Promise<Markout45ProbeResult>

const EXPECTED_ATTRIBUTES = new Map<string, string>([
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
])

export function assessMarkout45Result(result: Markout45ProbeResult): Markout45Assessment {
  const failedChecks: string[] = []
  for (const [id, expectedName] of EXPECTED_ATTRIBUTES) {
    const current = findCase(result, id, failedChecks)
    if (current === undefined) continue
    if (current.errors.length !== 0) {
      failedChecks.push(`${id}: valid attribute was rejected`)
    }
    if (
      current.attributes.length !== 1 ||
      current.attributes[0]?.name !== expectedName ||
      current.attributes[0]?.value !== "x"
    ) {
      failedChecks.push(`${id}: exact attribute name/value was not preserved`)
    }
  }

  const dollar = findCase(result, "reserved-dollar", failedChecks)
  if (
    dollar !== undefined &&
    (dollar.errors.length !== 1 || dollar.errors[0] !== DOLLAR_ERROR || dollar.attributes.length !== 0)
  ) {
    failedChecks.push("reserved-dollar: Markout's explicit dollar-prefix policy regressed")
  }

  const tag = findCase(result, "punctuation-tag", failedChecks)
  if (tag !== undefined && tag.punctuationTagAccepted) {
    failedChecks.push("punctuation-tag: attribute permissiveness leaked into tag-name lexing")
  }
  return { passed: failedChecks.length === 0, failedChecks }
}

export function validateMarkout45Identity(identity: Markout45WorkspaceIdentity): void {
  if (identity.root !== identity.gitRoot) {
    throw new TypeError("Markout #45 dogfood root must be the exact Git worktree root")
  }
  if (identity.packageName !== "markout-monorepo") {
    throw new TypeError("Markout #45 dogfood root has the wrong package identity")
  }
  if (identity.head !== MARKOUT_45_FIXED_HEAD) {
    throw new TypeError(`Markout #45 dogfood requires fixed HEAD ${MARKOUT_45_FIXED_HEAD}`)
  }
  if (normalizeRepository(identity.origin) !== MARKOUT_REPOSITORY) {
    throw new TypeError("Markout #45 dogfood root has the wrong origin repository")
  }
}

export function validateMarkout45ProbeDigest(actual: string): void {
  if (actual !== EXPECTED_PROBE_SHA256) {
    throw new TypeError("Markout #45 trusted probe digest changed")
  }
}

export async function assertMarkout45ProbeIntegrity(): Promise<void> {
  const content = await readFile(PROBE_PATH)
  validateMarkout45ProbeDigest(createHash("sha256").update(content).digest("hex"))
}

export async function assertMarkout45Workspace(input: string): Promise<string> {
  const root = await realpath(input)
  if (!(await stat(root)).isDirectory()) {
    throw new TypeError("Markout #45 dogfood root must be a directory")
  }
  const packagePath = join(root, "package.json")
  const packageInfo = await lstat(packagePath)
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) {
    throw new TypeError("Markout #45 package.json must be a regular non-symlink file")
  }
  const parserPath = join(root, "packages", "core", "src", "html", "parser.ts")
  const parserInfo = await lstat(parserPath)
  if (!parserInfo.isFile() || parserInfo.isSymbolicLink()) {
    throw new TypeError("Markout #45 parser source must be a regular non-symlink file")
  }
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown }
  const [{ stdout: gitRoot }, { stdout: head }, { stdout: origin }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "config", "--get", "remote.origin.url"], { timeout: 5_000 }),
  ])
  validateMarkout45Identity({
    root,
    gitRoot: await realpath(gitRoot.trim()),
    head: head.trim(),
    packageName: typeof parsed.name === "string" ? parsed.name : "",
    origin: origin.trim(),
  })
  await Promise.all([
    access(join(root, "package-lock.json")),
    access(join(root, "node_modules", "esbuild", "lib", "main.js")),
    access(MACOS_SANDBOX_EXEC),
    assertMarkout45ProbeIntegrity(),
  ])
  return root
}

export function createMarkout45Verifier(options: {
  probeRunner?: ProbeRunner
  workspaceValidator?: typeof assertMarkout45Workspace
} = {}): QwenCompletionVerifier {
  const probeRunner = options.probeRunner ?? runMarkout45Probe
  const workspaceValidator = options.workspaceValidator ?? assertMarkout45Workspace
  return {
    id: MARKOUT_45_VERIFIER_ID,
    async verify(context: QwenCompletionVerifierContext) {
      let root: string
      try {
        root = await workspaceValidator(context.workspaceRoot)
      } catch {
        return {
          passed: false,
          guidance: "The trusted Markout #45 verifier rejected the repository, package, or fixed-SHA identity.",
        }
      }
      let result: Markout45ProbeResult
      try {
        result = await probeRunner(root, "workspace", context.signal)
      } catch {
        return {
          passed: false,
          guidance: "The independent Markout #45 behavior probe could not complete inside its bounded read-only network-denied sandbox. Restore the required local runtime prerequisites before proposing completion.",
        }
      }
      const assessment = assessMarkout45Result(result)
      return assessment.passed
        ? { passed: true }
        : {
            passed: false,
            guidance: [
              "The independent Markout #45 public-behavior contract failed.",
              ...assessment.failedChecks.map(failure => `- ${failure}`),
              "Accept the Issue's legal punctuation attribute names while preserving exact names/values, composite attributes, the existing dollar-prefix diagnostic, and tag-name boundaries before proposing completion.",
            ].join("\n"),
          }
    },
  }
}

export async function qualifyMarkout45Verifier(
  workspaceRoot: string,
  signal: AbortSignal,
  options: {
    probeRunner?: ProbeRunner
    workspaceValidator?: typeof assertMarkout45Workspace
  } = {},
): Promise<Markout45Qualification> {
  const root = await (options.workspaceValidator ?? assertMarkout45Workspace)(workspaceRoot)
  const runner = options.probeRunner ?? runMarkout45Probe
  const scenarios: readonly Markout45ProbeScenario[] = [
    "workspace",
    "fixture-fixed",
    "fixture-overbroad",
    "fixture-operator-loss",
    "fixture-partial",
  ]
  const assessments = new Map<Markout45ProbeScenario, Markout45Assessment>()
  for (const scenario of scenarios) {
    assessments.set(scenario, assessMarkout45Result(await runner(root, scenario, signal)))
  }
  const failedChecks: string[] = []
  if (assessments.get("workspace")?.passed !== false) {
    failedChecks.push("pinned unfixed workspace was not rejected")
  }
  if (assessments.get("fixture-fixed")?.passed !== true) {
    failedChecks.push("known-good behavior fixture was not accepted")
  }
  for (const scenario of [
    "fixture-overbroad",
    "fixture-operator-loss",
    "fixture-partial",
  ] as const) {
    if (assessments.get(scenario)?.passed !== false) {
      failedChecks.push(`${scenario} mutant was not rejected`)
    }
  }
  return {
    passed: failedChecks.length === 0,
    workspacePassed: assessments.get("workspace")?.passed === true,
    failedChecks,
  }
}

export async function runMarkout45Probe(
  workspaceRoot: string,
  scenario: Markout45ProbeScenario,
  signal: AbortSignal,
): Promise<Markout45ProbeResult> {
  await assertMarkout45ProbeIntegrity()
  const { stdout } = await execFileAsync(
    MACOS_SANDBOX_EXEC,
    ["-p", MACOS_PROBE_SANDBOX, process.execPath, PROBE_PATH, "--root", workspaceRoot, "--scenario", scenario],
    {
      cwd: workspaceRoot,
      env: verifierChildEnvironment(process.env),
      signal,
      timeout: DEFAULT_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    },
  )
  return parseProbeResult(stdout, scenario)
}

export function verifierChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isCredentialLikeEnvironmentKey(key)) continue
    child[key] = value
  }
  child.CI = "1"
  child.NO_COLOR = "1"
  child.FORCE_COLOR = "0"
  return child
}

function findCase(
  result: Markout45ProbeResult,
  id: string,
  failedChecks: string[],
): Markout45ProbeCaseResult | undefined {
  const matches = result.cases.filter(item => item.id === id)
  if (matches.length !== 1) {
    failedChecks.push(`${id}: probe case is missing or duplicated`)
    return undefined
  }
  return matches[0]
}

function parseProbeResult(stdout: string, expectedScenario: Markout45ProbeScenario): Markout45ProbeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new TypeError("Markout #45 probe returned invalid JSON")
  }
  if (!isRecord(parsed) || parsed.scenario !== expectedScenario || !Array.isArray(parsed.cases)) {
    throw new TypeError("Markout #45 probe returned an invalid envelope")
  }
  return { scenario: expectedScenario, cases: parsed.cases.map(parseProbeCase) }
}

function parseProbeCase(value: unknown): Markout45ProbeCaseResult {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !Array.isArray(value.errors) ||
    !value.errors.every(item => typeof item === "string") ||
    !Array.isArray(value.attributes) ||
    typeof value.punctuationTagAccepted !== "boolean"
  ) {
    throw new TypeError("Markout #45 probe returned an invalid case")
  }
  return {
    id: value.id,
    errors: value.errors,
    attributes: value.attributes.map(parseProbeAttribute),
    punctuationTagAccepted: value.punctuationTagAccepted,
  }
}

function parseProbeAttribute(value: unknown): Markout45ProbeAttribute {
  if (!isRecord(value) || typeof value.name !== "string" || (value.value !== null && typeof value.value !== "string")) {
    throw new TypeError("Markout #45 probe returned invalid attribute evidence")
  }
  return { name: value.name, value: value.value }
}

function normalizeRepository(value: string): string {
  return value.trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
}

function isCredentialLikeEnvironmentKey(key: string): boolean {
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const markout45VerifierPaths = {
  probe: PROBE_PATH,
  sourceDirectory: dirname(PROBE_PATH),
} as const
