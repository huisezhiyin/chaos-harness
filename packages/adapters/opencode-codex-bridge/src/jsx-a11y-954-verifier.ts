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
const PROBE_PATH = fileURLToPath(new URL("./jsx-a11y-954-probe.mjs", import.meta.url))
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const MACOS_PROBE_SANDBOX = "(version 1)(allow default)(deny network*)(deny file-write*)"
const EXPECTED_PROBE_SHA256 = "4755d892cfcaadfa150294a8004b7ab1c3122fca1a972a7ab5dbc06739a20b15"
const RULE_ID = "chaos/control-has-associated-label"
const ERROR_MESSAGE = "A control must be associated with a text label."

export const JSX_A11Y_954_VERIFIER_ID = "jsx-a11y-954-public-behavior-v1"
export const JSX_A11Y_954_FIXED_HEAD = "8f75961d965e47afb88854d324bd32fafde7acfe"
export const JSX_A11Y_REPOSITORY = "https://github.com/jsx-eslint/eslint-plugin-jsx-a11y"

export type JsxA11y954ProbeScenario =
  | "workspace"
  | "fixture-fixed"
  | "fixture-td-only"
  | "fixture-lost-empty"
  | "fixture-lost-established"

export interface JsxA11y954ProbeDiagnostic {
  ruleId: string | null
  message: string
  fatal: boolean
}

export interface JsxA11y954ProbeCaseResult {
  id: string
  diagnostics: readonly JsxA11y954ProbeDiagnostic[]
}

export interface JsxA11y954ProbeResult {
  scenario: JsxA11y954ProbeScenario
  cases: readonly JsxA11y954ProbeCaseResult[]
}

export interface JsxA11y954Assessment {
  passed: boolean
  failedChecks: readonly string[]
}

export interface JsxA11y954WorkspaceIdentity {
  root: string
  gitRoot: string
  head: string
  packageName: string
  origin: string
}

export interface JsxA11y954Qualification {
  passed: boolean
  workspacePassed: boolean
  failedChecks: readonly string[]
}

type ProbeRunner = (
  workspaceRoot: string,
  scenario: JsxA11y954ProbeScenario,
  signal: AbortSignal,
) => Promise<JsxA11y954ProbeResult>

const ACCEPTED_CASES = [
  "issue-self-closing",
  "issue-explicit-closing",
  "native-dangerous",
  "role-dangerous",
  "text-control",
  "aria-control",
] as const

const REJECTED_CASES = ["empty-td", "empty-button", "empty-role"] as const

export function assessJsxA11y954Result(result: JsxA11y954ProbeResult): JsxA11y954Assessment {
  const failedChecks: string[] = []
  for (const id of ACCEPTED_CASES) {
    const current = findCase(result, id, failedChecks)
    if (current !== undefined && current.diagnostics.length !== 0) {
      failedChecks.push(`${id}: an accessible control was reported`)
    }
  }
  for (const id of REJECTED_CASES) {
    const current = findCase(result, id, failedChecks)
    if (current === undefined) continue
    if (
      current.diagnostics.length !== 1 ||
      current.diagnostics[0]?.ruleId !== RULE_ID ||
      current.diagnostics[0]?.message !== ERROR_MESSAGE ||
      current.diagnostics[0]?.fatal !== false
    ) {
      failedChecks.push(`${id}: the exact missing-label diagnostic was not preserved`)
    }
  }
  return { passed: failedChecks.length === 0, failedChecks }
}

export function validateJsxA11y954Identity(identity: JsxA11y954WorkspaceIdentity): void {
  if (identity.root !== identity.gitRoot) {
    throw new TypeError("jsx-a11y #954 dogfood root must be the exact Git worktree root")
  }
  if (identity.packageName !== "eslint-plugin-jsx-a11y") {
    throw new TypeError("jsx-a11y #954 dogfood root has the wrong package identity")
  }
  if (identity.head !== JSX_A11Y_954_FIXED_HEAD) {
    throw new TypeError(`jsx-a11y #954 dogfood requires fixed HEAD ${JSX_A11Y_954_FIXED_HEAD}`)
  }
  if (normalizeRepository(identity.origin) !== JSX_A11Y_REPOSITORY) {
    throw new TypeError("jsx-a11y #954 dogfood root has the wrong origin repository")
  }
}

export function validateJsxA11y954ProbeDigest(actual: string): void {
  if (actual !== EXPECTED_PROBE_SHA256) {
    throw new TypeError("jsx-a11y #954 trusted probe digest changed")
  }
}

export async function assertJsxA11y954ProbeIntegrity(): Promise<void> {
  const content = await readFile(PROBE_PATH)
  validateJsxA11y954ProbeDigest(createHash("sha256").update(content).digest("hex"))
}

export async function assertJsxA11y954Workspace(input: string): Promise<string> {
  const root = await realpath(input)
  if (!(await stat(root)).isDirectory()) {
    throw new TypeError("jsx-a11y #954 dogfood root must be a directory")
  }
  const packagePath = join(root, "package.json")
  const packageInfo = await lstat(packagePath)
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) {
    throw new TypeError("jsx-a11y #954 package.json must be a regular non-symlink file")
  }
  const rulePath = join(root, "src", "rules", "control-has-associated-label.js")
  const ruleInfo = await lstat(rulePath)
  if (!ruleInfo.isFile() || ruleInfo.isSymbolicLink()) {
    throw new TypeError("jsx-a11y #954 rule source must be a regular non-symlink file")
  }
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown }
  const [{ stdout: gitRoot }, { stdout: head }, { stdout: origin }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "config", "--get", "remote.origin.url"], { timeout: 5_000 }),
  ])
  validateJsxA11y954Identity({
    root,
    gitRoot: await realpath(gitRoot.trim()),
    head: head.trim(),
    packageName: typeof parsed.name === "string" ? parsed.name : "",
    origin: origin.trim(),
  })
  await Promise.all([
    access(join(root, "node_modules", "eslint", "lib", "api.js")),
    access(join(root, "node_modules", "@babel", "register", "lib", "index.cjs")),
    access(join(root, "node_modules", "jsx-ast-utils")),
    access(MACOS_SANDBOX_EXEC),
    assertJsxA11y954ProbeIntegrity(),
  ])
  return root
}

export function createJsxA11y954Verifier(options: {
  probeRunner?: ProbeRunner
  workspaceValidator?: typeof assertJsxA11y954Workspace
} = {}): QwenCompletionVerifier {
  const probeRunner = options.probeRunner ?? runJsxA11y954Probe
  const workspaceValidator = options.workspaceValidator ?? assertJsxA11y954Workspace
  return {
    id: JSX_A11Y_954_VERIFIER_ID,
    async verify(context: QwenCompletionVerifierContext) {
      let root: string
      try {
        root = await workspaceValidator(context.workspaceRoot)
      } catch {
        return {
          passed: false,
          guidance: "The trusted jsx-a11y #954 verifier rejected the repository, package, or fixed-SHA identity.",
        }
      }
      let result: JsxA11y954ProbeResult
      try {
        result = await probeRunner(root, "workspace", context.signal)
      } catch {
        return {
          passed: false,
          guidance: "The independent jsx-a11y #954 behavior probe could not complete inside its bounded read-only network-denied sandbox. Restore the required local runtime prerequisites before proposing completion.",
        }
      }
      const assessment = assessJsxA11y954Result(result)
      return assessment.passed
        ? { passed: true }
        : {
            passed: false,
            guidance: [
              "The independent jsx-a11y #954 public-behavior contract failed.",
              ...assessment.failedChecks.map((failure) => `- ${failure}`),
              "Accept controls whose content is supplied through dangerouslySetInnerHTML while preserving empty-control diagnostics and established text/ARIA behavior before proposing completion.",
            ].join("\n"),
          }
    },
  }
}

export async function qualifyJsxA11y954Verifier(
  workspaceRoot: string,
  signal: AbortSignal,
  options: {
    probeRunner?: ProbeRunner
    workspaceValidator?: typeof assertJsxA11y954Workspace
  } = {},
): Promise<JsxA11y954Qualification> {
  const root = await (options.workspaceValidator ?? assertJsxA11y954Workspace)(workspaceRoot)
  const runner = options.probeRunner ?? runJsxA11y954Probe
  const scenarios: readonly JsxA11y954ProbeScenario[] = [
    "workspace",
    "fixture-fixed",
    "fixture-td-only",
    "fixture-lost-empty",
    "fixture-lost-established",
  ]
  const assessments = new Map<JsxA11y954ProbeScenario, JsxA11y954Assessment>()
  for (const scenario of scenarios) {
    assessments.set(scenario, assessJsxA11y954Result(await runner(root, scenario, signal)))
  }
  const failedChecks: string[] = []
  if (assessments.get("workspace")?.passed !== false) {
    failedChecks.push("pinned unfixed workspace was not rejected")
  }
  if (assessments.get("fixture-fixed")?.passed !== true) {
    failedChecks.push("known-good behavior fixture was not accepted")
  }
  for (const scenario of [
    "fixture-td-only",
    "fixture-lost-empty",
    "fixture-lost-established",
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

export async function runJsxA11y954Probe(
  workspaceRoot: string,
  scenario: JsxA11y954ProbeScenario,
  signal: AbortSignal,
): Promise<JsxA11y954ProbeResult> {
  await assertJsxA11y954ProbeIntegrity()
  const { stdout } = await execFileAsync(
    MACOS_SANDBOX_EXEC,
    [
      "-p", MACOS_PROBE_SANDBOX,
      process.execPath, PROBE_PATH,
      "--root", workspaceRoot,
      "--scenario", scenario,
    ],
    {
      cwd: workspaceRoot,
      env: verifierChildEnvironment(process.env),
      signal,
      timeout: DEFAULT_PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
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
  child.BABEL_DISABLE_CACHE = "1"
  child.CI = "1"
  child.NO_COLOR = "1"
  child.FORCE_COLOR = "0"
  return child
}

function findCase(
  result: JsxA11y954ProbeResult,
  id: string,
  failedChecks: string[],
): JsxA11y954ProbeCaseResult | undefined {
  const matches = result.cases.filter((item) => item.id === id)
  if (matches.length !== 1) {
    failedChecks.push(`${id}: probe case is missing or duplicated`)
    return undefined
  }
  return matches[0]
}

function parseProbeResult(
  stdout: string,
  expectedScenario: JsxA11y954ProbeScenario,
): JsxA11y954ProbeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new TypeError("jsx-a11y #954 probe returned invalid JSON")
  }
  if (!isRecord(parsed) || parsed.scenario !== expectedScenario || !Array.isArray(parsed.cases)) {
    throw new TypeError("jsx-a11y #954 probe returned an invalid envelope")
  }
  return { scenario: expectedScenario, cases: parsed.cases.map(parseProbeCase) }
}

function parseProbeCase(value: unknown): JsxA11y954ProbeCaseResult {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.diagnostics)) {
    throw new TypeError("jsx-a11y #954 probe returned an invalid case")
  }
  return { id: value.id, diagnostics: value.diagnostics.map(parseProbeDiagnostic) }
}

function parseProbeDiagnostic(value: unknown): JsxA11y954ProbeDiagnostic {
  if (
    !isRecord(value) ||
    (value.ruleId !== null && typeof value.ruleId !== "string") ||
    typeof value.message !== "string" ||
    typeof value.fatal !== "boolean"
  ) {
    throw new TypeError("jsx-a11y #954 probe returned an invalid diagnostic")
  }
  return { ruleId: value.ruleId, message: value.message, fatal: value.fatal }
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

export const jsxA11y954VerifierPaths = {
  probe: PROBE_PATH,
  sourceDirectory: dirname(PROBE_PATH),
} as const
