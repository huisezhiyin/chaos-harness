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
const PROBE_PATH = fileURLToPath(new URL("./posthog-wizard-1198-probe.ts", import.meta.url))
const DEFAULT_PROBE_TIMEOUT_MS = 12_000
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const MACOS_PROBE_SANDBOX = "(version 1)(allow default)(deny network*)(deny file-write*)"
const EXPECTED_PROBE_SHA256 = "d1f39a9ca723f42f6cb4ce8c74113386c7eab46e29bff5b0abf5040a9b4e4017"

export const POSTHOG_WIZARD_1198_VERIFIER_ID = "posthog-wizard-1198-public-behavior-v1"
export const POSTHOG_WIZARD_1198_FIXED_HEAD = "821023a8387747716117d304fc4438298b0e41f7"

export type PostHogWizard1198Scenario = "benign" | "fatal-hung-flush"

export interface PostHogWizard1198ProbeResult {
  scenario: PostHogWizard1198Scenario
  exitCode: number
  stdout: string
  stderr: string
}

export interface PostHogWizard1198Assessment {
  passed: boolean
  failedChecks: readonly string[]
}

export interface PostHogWizard1198WorkspaceIdentity {
  root: string
  gitRoot: string
  head: string
  packageName: string
}

type ProbeRunner = (
  workspaceRoot: string,
  scenario: PostHogWizard1198Scenario,
  signal: AbortSignal,
) => Promise<PostHogWizard1198ProbeResult>

export function assessPostHogWizard1198Results(
  results: readonly PostHogWizard1198ProbeResult[],
): PostHogWizard1198Assessment {
  const benign = results.find((result) => result.scenario === "benign")
  const fatal = results.find((result) => result.scenario === "fatal-hung-flush")
  const failedChecks: string[] = []
  if (benign === undefined || benign.exitCode !== 0 || !benign.stdout.includes("CHAOS_PROBE_ALIVE")) {
    failedChecks.push("benign transport timeout did not preserve a healthy process")
  }
  if (
    fatal === undefined ||
    fatal.exitCode !== 1 ||
    !fatal.stderr.includes("Wizard crashed: genuine fatal boom") ||
    !fatal.stderr.includes('"code":"PHW_INTERNAL_UNHANDLED"')
  ) {
    failedChecks.push("fatal hung-flush path did not produce the required non-zero crash result")
  }
  return { passed: failedChecks.length === 0, failedChecks }
}

export function validatePostHogWizard1198Identity(
  identity: PostHogWizard1198WorkspaceIdentity,
): void {
  if (identity.root !== identity.gitRoot) {
    throw new TypeError("PostHog #1198 dogfood root must be the exact Git worktree root")
  }
  if (identity.packageName !== "@posthog/wizard") {
    throw new TypeError("PostHog #1198 dogfood root must contain @posthog/wizard")
  }
  if (identity.head !== POSTHOG_WIZARD_1198_FIXED_HEAD) {
    throw new TypeError(`PostHog #1198 dogfood requires fixed HEAD ${POSTHOG_WIZARD_1198_FIXED_HEAD}`)
  }
}

export function validatePostHogWizard1198ProbeDigest(actual: string): void {
  if (actual !== EXPECTED_PROBE_SHA256) {
    throw new TypeError("PostHog #1198 trusted probe digest changed")
  }
}

export async function assertPostHogWizard1198ProbeIntegrity(): Promise<void> {
  const content = await readFile(PROBE_PATH)
  validatePostHogWizard1198ProbeDigest(createHash("sha256").update(content).digest("hex"))
}

export async function assertPostHogWizard1198Workspace(input: string): Promise<string> {
  const root = await realpath(input)
  if (!(await stat(root)).isDirectory()) {
    throw new TypeError("PostHog #1198 dogfood root must be a directory")
  }
  const packagePath = join(root, "package.json")
  const packageInfo = await lstat(packagePath)
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) {
    throw new TypeError("PostHog #1198 package.json must be a regular non-symlink file")
  }
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown }
  const [{ stdout: gitRoot }, { stdout: head }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 5_000 }),
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 }),
  ])
  const canonicalGitRoot = await realpath(gitRoot.trim())
  validatePostHogWizard1198Identity({
    root,
    gitRoot: canonicalGitRoot,
    head: head.trim(),
    packageName: typeof parsed.name === "string" ? parsed.name : "",
  })
  await Promise.all([
    access(join(root, "src", "utils", "analytics.ts")),
    access(MACOS_SANDBOX_EXEC),
    assertPostHogWizard1198ProbeIntegrity(),
  ])
  return root
}

export function createPostHogWizard1198Verifier(options: {
  probeRunner?: ProbeRunner
  workspaceValidator?: typeof assertPostHogWizard1198Workspace
} = {}): QwenCompletionVerifier {
  const probeRunner = options.probeRunner ?? runPostHogWizard1198Probe
  const workspaceValidator = options.workspaceValidator ?? assertPostHogWizard1198Workspace
  return {
    id: POSTHOG_WIZARD_1198_VERIFIER_ID,
    async verify(context: QwenCompletionVerifierContext) {
      let root: string
      try {
        root = await workspaceValidator(context.workspaceRoot)
      } catch {
        return {
          passed: false,
          guidance: "The trusted PostHog #1198 verifier rejected the workspace identity. Continue only in the fixed-SHA @posthog/wizard checkout.",
        }
      }
      let results: PostHogWizard1198ProbeResult[]
      try {
        results = await Promise.all([
          probeRunner(root, "benign", context.signal),
          probeRunner(root, "fatal-hung-flush", context.signal),
        ])
      } catch {
        return {
          passed: false,
          guidance: "The independent PostHog #1198 behavior probe could not complete inside its bounded read-only network-denied sandbox. Restore the required implementation or runtime prerequisites before proposing completion.",
        }
      }
      const assessment = assessPostHogWizard1198Results(results)
      return assessment.passed
        ? { passed: true }
        : {
            passed: false,
            guidance: [
              "The independent PostHog #1198 public-behavior contract failed.",
              ...assessment.failedChecks.map((failure) => `- ${failure}`),
              "Re-inspect the process-level exception policy and validate both benign survival and fatal exit truth before proposing completion.",
            ].join("\n"),
          }
    },
  }
}

export async function runPostHogWizard1198Probe(
  workspaceRoot: string,
  scenario: PostHogWizard1198Scenario,
  signal: AbortSignal,
): Promise<PostHogWizard1198ProbeResult> {
  await assertPostHogWizard1198ProbeIntegrity()
  const childEnvironment = verifierChildEnvironment(process.env)
  try {
    const { stdout, stderr } = await execFileAsync(
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
        env: childEnvironment,
        signal,
        timeout: DEFAULT_PROBE_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
      },
    )
    return { scenario, exitCode: 0, stdout, stderr }
  } catch (error) {
    if (isAbortOrTimeout(error)) throw error
    if (isExecError(error) && typeof error.code === "number") {
      return {
        scenario,
        exitCode: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }
    }
    throw error
  }
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

function isCredentialLikeEnvironmentKey(key: string): boolean {
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key)
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    ("killed" in error && error.killed === true) ||
    ("code" in error && error.code === "ETIMEDOUT")
  )
}

function isExecError(error: unknown): error is Error & {
  code?: number | string
  stdout?: string
  stderr?: string
} {
  return error instanceof Error
}

export const postHogWizard1198VerifierPaths = {
  probe: PROBE_PATH,
  sourceDirectory: dirname(PROBE_PATH),
} as const
