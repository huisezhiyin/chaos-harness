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
const PROBE_PATH = fileURLToPath(new URL("./typescript-eslint-12813-probe.ts", import.meta.url))
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const MACOS_PROBE_SANDBOX = "(version 1)(allow default)(deny network*)(deny file-write*)"
const EXPECTED_PROBE_SHA256 = "d5850465b7b30ffb9d1d0c1af92ca43c34acf0bc91d9adca93c7f610886beb16"

export const TYPESCRIPT_ESLINT_12813_VERIFIER_ID = "typescript-eslint-12813-public-behavior-v1"
export const TYPESCRIPT_ESLINT_12813_FIXED_HEAD = "4586535ab24d7d5e9b3ba87e4adb8636f9314aca"
export const TYPESCRIPT_ESLINT_REPOSITORY = "https://github.com/typescript-eslint/typescript-eslint"

export type TypescriptEslint12813ProbeScenario =
  | "workspace"
  | "fixture-fixed"
  | "fixture-scalar-rest"
  | "fixture-lost-diagnostic"
  | "fixture-double-array"

export interface TypescriptEslint12813ProbeSuggestion {
  messageId: string
  output: string
  remainingReportCount: number
  ts2370Count: number
}

export interface TypescriptEslint12813ProbeCaseResult {
  id: string
  reportCount: number
  messageIds: readonly string[]
  suggestions: readonly TypescriptEslint12813ProbeSuggestion[]
  autofix: {
    fixed: boolean
    output: string
    remainingReportCount: number
    ts2370Count: number
  }
}

export interface TypescriptEslint12813ProbeResult {
  scenario: TypescriptEslint12813ProbeScenario
  cases: readonly TypescriptEslint12813ProbeCaseResult[]
}

export interface TypescriptEslint12813Assessment {
  passed: boolean
  failedChecks: readonly string[]
}

export interface TypescriptEslint12813WorkspaceIdentity {
  root: string
  gitRoot: string
  head: string
  packageName: string
  origin: string
}

export interface TypescriptEslint12813Qualification {
  passed: boolean
  workspacePassed: boolean
  failedChecks: readonly string[]
}

type ProbeRunner = (
  workspaceRoot: string,
  scenario: TypescriptEslint12813ProbeScenario,
  signal: AbortSignal,
) => Promise<TypescriptEslint12813ProbeResult>

const REST_CASES = [
  "function-rest",
  "arrow-rest",
  "call-signature-rest",
  "method-signature-rest",
] as const

export function assessTypescriptEslint12813Result(
  result: TypescriptEslint12813ProbeResult,
): TypescriptEslint12813Assessment {
  const failedChecks: string[] = []
  for (const id of REST_CASES) {
    const current = findCase(result, id, failedChecks)
    if (current === undefined) continue
    if (current.reportCount !== 1 || current.messageIds.some((messageId) => messageId !== "unexpectedAny")) {
      failedChecks.push(`${id}: unexpectedAny diagnostic was not preserved`)
    }
    for (const suggestion of current.suggestions) {
      if (suggestion.ts2370Count !== 0 || suggestion.remainingReportCount !== 0) {
        failedChecks.push(`${id}: an offered suggestion is not a valid complete repair`)
      }
    }
    if (
      current.autofix.fixed &&
      (current.autofix.ts2370Count !== 0 || current.autofix.remainingReportCount !== 0)
    ) {
      failedChecks.push(`${id}: fixToUnknown produced an invalid or incomplete repair`)
    }
  }

  const scalar = findCase(result, "ordinary-scalar", failedChecks)
  if (scalar !== undefined) {
    if (scalar.reportCount !== 1 || scalar.messageIds.some((messageId) => messageId !== "unexpectedAny")) {
      failedChecks.push("ordinary-scalar: diagnostic regressed")
    }
    requireSuggestionOutput(scalar, "suggestUnknown", "const value: unknown = 1;", failedChecks)
    requireSuggestionOutput(scalar, "suggestNever", "const value: never = 1;", failedChecks)
    if (
      !scalar.autofix.fixed ||
      scalar.autofix.output !== "const value: unknown = 1;" ||
      scalar.autofix.remainingReportCount !== 0
    ) {
      failedChecks.push("ordinary-scalar: existing scalar fixToUnknown behavior regressed")
    }
  }

  const array = findCase(result, "existing-rest-array", failedChecks)
  if (array !== undefined) {
    if (array.reportCount !== 1 || array.messageIds.some((messageId) => messageId !== "unexpectedAny")) {
      failedChecks.push("existing-rest-array: diagnostic regressed")
    }
    requireSuggestionOutput(array, "suggestUnknown", "function existing(...args: unknown[]) {}", failedChecks)
    requireSuggestionOutput(array, "suggestNever", "function existing(...args: never[]) {}", failedChecks)
    if (
      !array.autofix.fixed ||
      array.autofix.output !== "function existing(...args: unknown[]) {}" ||
      array.autofix.remainingReportCount !== 0 ||
      array.autofix.ts2370Count !== 0
    ) {
      failedChecks.push("existing-rest-array: array fix was removed or double-wrapped")
    }
  }

  return { passed: failedChecks.length === 0, failedChecks }
}

export function validateTypescriptEslint12813Identity(
  identity: TypescriptEslint12813WorkspaceIdentity,
): void {
  if (identity.root !== identity.gitRoot) {
    throw new TypeError("typescript-eslint #12813 dogfood root must be the exact Git worktree root")
  }
  if (identity.packageName !== "@typescript-eslint/typescript-eslint") {
    throw new TypeError("typescript-eslint #12813 dogfood root has the wrong package identity")
  }
  if (identity.head !== TYPESCRIPT_ESLINT_12813_FIXED_HEAD) {
    throw new TypeError(`typescript-eslint #12813 dogfood requires fixed HEAD ${TYPESCRIPT_ESLINT_12813_FIXED_HEAD}`)
  }
  if (normalizeRepository(identity.origin) !== TYPESCRIPT_ESLINT_REPOSITORY) {
    throw new TypeError("typescript-eslint #12813 dogfood root has the wrong origin repository")
  }
}

export function validateTypescriptEslint12813ProbeDigest(actual: string): void {
  if (actual !== EXPECTED_PROBE_SHA256) {
    throw new TypeError("typescript-eslint #12813 trusted probe digest changed")
  }
}

export async function assertTypescriptEslint12813ProbeIntegrity(): Promise<void> {
  const content = await readFile(PROBE_PATH)
  validateTypescriptEslint12813ProbeDigest(createHash("sha256").update(content).digest("hex"))
}

export async function assertTypescriptEslint12813Workspace(input: string): Promise<string> {
  const root = await realpath(input)
  if (!(await stat(root)).isDirectory()) {
    throw new TypeError("typescript-eslint #12813 dogfood root must be a directory")
  }
  const packagePath = join(root, "package.json")
  const packageInfo = await lstat(packagePath)
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) {
    throw new TypeError("typescript-eslint #12813 package.json must be a regular non-symlink file")
  }
  const rulePath = join(root, "packages", "eslint-plugin", "src", "rules", "no-explicit-any.ts")
  const ruleInfo = await lstat(rulePath)
  if (!ruleInfo.isFile() || ruleInfo.isSymbolicLink()) {
    throw new TypeError("typescript-eslint #12813 rule source must be a regular non-symlink file")
  }
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown }
  const [{ stdout: gitRoot }, { stdout: head }, { stdout: origin }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "config", "--get", "remote.origin.url"], { timeout: 5_000 }),
  ])
  validateTypescriptEslint12813Identity({
    root,
    gitRoot: await realpath(gitRoot.trim()),
    head: head.trim(),
    packageName: typeof parsed.name === "string" ? parsed.name : "",
    origin: origin.trim(),
  })
  await Promise.all([
    access(join(root, "packages", "parser", "dist", "index.js")),
    access(join(root, "node_modules", "eslint", "lib", "api.js")),
    access(join(root, "node_modules", "typescript", "lib", "typescript.js")),
    access(join(root, "node_modules", "tsx")),
    access(MACOS_SANDBOX_EXEC),
    assertTypescriptEslint12813ProbeIntegrity(),
  ])
  return root
}

export function createTypescriptEslint12813Verifier(options: {
  probeRunner?: ProbeRunner
  workspaceValidator?: typeof assertTypescriptEslint12813Workspace
} = {}): QwenCompletionVerifier {
  const probeRunner = options.probeRunner ?? runTypescriptEslint12813Probe
  const workspaceValidator = options.workspaceValidator ?? assertTypescriptEslint12813Workspace
  return {
    id: TYPESCRIPT_ESLINT_12813_VERIFIER_ID,
    async verify(context: QwenCompletionVerifierContext) {
      let root: string
      try {
        root = await workspaceValidator(context.workspaceRoot)
      } catch {
        return {
          passed: false,
          guidance: "The trusted typescript-eslint #12813 verifier rejected the repository, package, or fixed-SHA identity.",
        }
      }
      let result: TypescriptEslint12813ProbeResult
      try {
        result = await probeRunner(root, "workspace", context.signal)
      } catch {
        return {
          passed: false,
          guidance: "The independent typescript-eslint #12813 behavior probe could not complete inside its bounded read-only network-denied sandbox. Restore the required local build/runtime prerequisites before proposing completion.",
        }
      }
      const assessment = assessTypescriptEslint12813Result(result)
      return assessment.passed
        ? { passed: true }
        : {
            passed: false,
            guidance: [
              "The independent typescript-eslint #12813 public-behavior contract failed.",
              ...assessment.failedChecks.map((failure) => `- ${failure}`),
              "Keep the no-explicit-any diagnostic, ensure every offered rest-parameter edit is TypeScript-valid, and preserve scalar/array controls before proposing completion.",
            ].join("\n"),
          }
    },
  }
}

export async function qualifyTypescriptEslint12813Verifier(
  workspaceRoot: string,
  signal: AbortSignal,
  options: {
    probeRunner?: ProbeRunner
    workspaceValidator?: typeof assertTypescriptEslint12813Workspace
  } = {},
): Promise<TypescriptEslint12813Qualification> {
  const root = await (options.workspaceValidator ?? assertTypescriptEslint12813Workspace)(workspaceRoot)
  const runner = options.probeRunner ?? runTypescriptEslint12813Probe
  const scenarios: readonly TypescriptEslint12813ProbeScenario[] = [
    "workspace",
    "fixture-fixed",
    "fixture-scalar-rest",
    "fixture-lost-diagnostic",
    "fixture-double-array",
  ]
  const assessments = new Map<TypescriptEslint12813ProbeScenario, TypescriptEslint12813Assessment>()
  for (const scenario of scenarios) {
    assessments.set(scenario, assessTypescriptEslint12813Result(await runner(root, scenario, signal)))
  }
  const failedChecks: string[] = []
  if (assessments.get("workspace")?.passed !== false) {
    failedChecks.push("pinned unfixed workspace was not rejected")
  }
  if (assessments.get("fixture-fixed")?.passed !== true) {
    failedChecks.push("known-good behavior fixture was not accepted")
  }
  for (const scenario of [
    "fixture-scalar-rest",
    "fixture-lost-diagnostic",
    "fixture-double-array",
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

export async function runTypescriptEslint12813Probe(
  workspaceRoot: string,
  scenario: TypescriptEslint12813ProbeScenario,
  signal: AbortSignal,
): Promise<TypescriptEslint12813ProbeResult> {
  await assertTypescriptEslint12813ProbeIntegrity()
  const { stdout } = await execFileAsync(
    MACOS_SANDBOX_EXEC,
    [
      "-p", MACOS_PROBE_SANDBOX,
      process.execPath,
      "--import", "tsx",
      PROBE_PATH,
      "--root", workspaceRoot,
      "--scenario", scenario,
    ],
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
  result: TypescriptEslint12813ProbeResult,
  id: string,
  failedChecks: string[],
): TypescriptEslint12813ProbeCaseResult | undefined {
  const matches = result.cases.filter((item) => item.id === id)
  if (matches.length !== 1) {
    failedChecks.push(`${id}: probe case is missing or duplicated`)
    return undefined
  }
  return matches[0]
}

function requireSuggestionOutput(
  result: TypescriptEslint12813ProbeCaseResult,
  messageId: string,
  expectedOutput: string,
  failedChecks: string[],
): void {
  const matches = result.suggestions.filter((suggestion) => suggestion.messageId === messageId)
  if (
    matches.length !== 1 ||
    matches[0]?.output !== expectedOutput ||
    matches[0].remainingReportCount !== 0 ||
    matches[0].ts2370Count !== 0
  ) {
    failedChecks.push(`${result.id}: ${messageId} control behavior regressed`)
  }
}

function parseProbeResult(
  stdout: string,
  expectedScenario: TypescriptEslint12813ProbeScenario,
): TypescriptEslint12813ProbeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new TypeError("typescript-eslint #12813 probe returned invalid JSON")
  }
  if (!isRecord(parsed) || parsed.scenario !== expectedScenario || !Array.isArray(parsed.cases)) {
    throw new TypeError("typescript-eslint #12813 probe returned an invalid envelope")
  }
  const cases = parsed.cases.map(parseProbeCase)
  return { scenario: expectedScenario, cases }
}

function parseProbeCase(value: unknown): TypescriptEslint12813ProbeCaseResult {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isNonNegativeInteger(value.reportCount) ||
    !Array.isArray(value.messageIds) ||
    !value.messageIds.every((item) => typeof item === "string") ||
    !Array.isArray(value.suggestions) ||
    !isRecord(value.autofix)
  ) {
    throw new TypeError("typescript-eslint #12813 probe returned an invalid case")
  }
  const autofix = value.autofix
  if (
    typeof autofix.fixed !== "boolean" ||
    typeof autofix.output !== "string" ||
    !isNonNegativeInteger(autofix.remainingReportCount) ||
    !isNonNegativeInteger(autofix.ts2370Count)
  ) {
    throw new TypeError("typescript-eslint #12813 probe returned invalid autofix evidence")
  }
  return {
    id: value.id,
    reportCount: value.reportCount,
    messageIds: value.messageIds,
    suggestions: value.suggestions.map(parseProbeSuggestion),
    autofix: {
      fixed: autofix.fixed,
      output: autofix.output,
      remainingReportCount: autofix.remainingReportCount,
      ts2370Count: autofix.ts2370Count,
    },
  }
}

function parseProbeSuggestion(value: unknown): TypescriptEslint12813ProbeSuggestion {
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    typeof value.output !== "string" ||
    !isNonNegativeInteger(value.remainingReportCount) ||
    !isNonNegativeInteger(value.ts2370Count)
  ) {
    throw new TypeError("typescript-eslint #12813 probe returned invalid suggestion evidence")
  }
  return {
    messageId: value.messageId,
    output: value.output,
    remainingReportCount: value.remainingReportCount,
    ts2370Count: value.ts2370Count,
  }
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const typescriptEslint12813VerifierPaths = {
  probe: PROBE_PATH,
  sourceDirectory: dirname(PROBE_PATH),
} as const
