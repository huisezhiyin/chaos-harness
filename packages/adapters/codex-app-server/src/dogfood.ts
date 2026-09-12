import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import {
  emptyHostAttemptUsage,
  ids,
  type HostActionKind,
  type HostAttemptPort,
  type HostAttemptResult,
} from "../../../kernel/src/index.js"
import { CodexAppServerAttemptAdapter } from "./attempt-adapter.js"
import { DEFAULT_CODEX_COMMAND } from "./client.js"

const execFileAsync = promisify(execFile)

export interface CodexDogfoodRunOptions {
  workspaceRoot: string
  goal: string
  model: string
  recordPath: string
  command?: string
  timeoutMs?: number
  allowDirty?: boolean
  signal?: AbortSignal
  attemptPort?: HostAttemptPort
  createRunId?: () => string
  now?: () => Date
}

export interface CodexDogfoodRunSummary {
  runId: string
  recordPath: string
  result: HostAttemptResult
  verification: "pending"
  boundaryViolation: boolean
}

export const codexDogfoodReviewVerifications = ["passed", "failed", "not_run"] as const
export const codexDogfoodReviewExperiences = ["smooth", "mixed", "blocked"] as const
export const codexDogfoodReviewInterventions = ["none", "minor", "major"] as const

export type CodexDogfoodReviewVerification = typeof codexDogfoodReviewVerifications[number]
export type CodexDogfoodReviewExperience = typeof codexDogfoodReviewExperiences[number]
export type CodexDogfoodReviewIntervention = typeof codexDogfoodReviewInterventions[number]

export interface CodexDogfoodReviewOptions {
  recordPath: string
  runId: string
  verification: CodexDogfoodReviewVerification
  experience: CodexDogfoodReviewExperience
  intervention: CodexDogfoodReviewIntervention
  now?: () => Date
}

export interface CodexDogfoodReviewSummary {
  runId: string
  recordPath: string
  verification: CodexDogfoodReviewVerification
  experience: CodexDogfoodReviewExperience
  intervention: CodexDogfoodReviewIntervention
}

export class CodexDogfoodConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexDogfoodConfigurationError"
  }
}

export async function runCodexDogfoodAttempt(
  options: CodexDogfoodRunOptions,
): Promise<CodexDogfoodRunSummary> {
  if (options.goal.trim().length === 0) {
    throw new CodexDogfoodConfigurationError("Dogfood goal must not be empty")
  }
  if (options.model.trim().length === 0) {
    throw new CodexDogfoodConfigurationError("Dogfood model must not be empty")
  }
  const now = options.now ?? (() => new Date())
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  const recordPath = await resolveRecordPath(options.recordPath, workspaceRoot)
  const gitHead = await readGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"])
  const dirtyBefore = await isDirty(workspaceRoot)
  if (dirtyBefore && options.allowDirty !== true) {
    throw new CodexDogfoodConfigurationError(
      "Workspace is dirty; pass --allow-dirty only after reviewing the existing changes",
    )
  }

  const runId = (options.createRunId ?? randomUUID)()
  const startedAt = now()
  const shared = {
    schemaVersion: 1,
    runId,
    profile: "codex-app-server",
    model: options.model,
    workspace: basename(workspaceRoot),
    goalSha256: createHash("sha256").update(options.goal).digest("hex"),
  } as const
  await appendRecord(recordPath, {
    ...shared,
    event: "started",
    occurredAt: startedAt.toISOString(),
    gitHead,
    dirtyBefore,
    allowDirty: options.allowDirty === true,
  })

  const attemptPort = options.attemptPort ?? new CodexAppServerAttemptAdapter({
    liveEnabled: true,
    command: options.command ?? DEFAULT_CODEX_COMMAND,
  })
  const attempt = {
    attemptId: ids.attempt(`codex-dogfood-${runId}-attempt-1`),
    unitId: ids.unit(`codex-dogfood-${runId}-unit-1`),
    unitRevision: 1,
    projectionId: ids.projection(`codex-dogfood-${runId}-projection-1`),
  }
  let result: HostAttemptResult
  try {
    result = await attemptPort.run({
      attempt,
      workspaceRoot,
      prompt: dogfoodPrompt(options.goal),
      model: { provider: "openai", model: options.model },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }, options.signal)
  } catch (error) {
    result = {
      attemptId: attempt.attemptId,
      runtime: { profile: "codex-app-server" },
      actions: [],
      artifacts: [],
      usage: emptyHostAttemptUsage(),
      events: [],
      status: "failed",
      failure: {
        kind: "unknown",
        message: error instanceof Error ? error.message : "Codex dogfood attempt failed",
        retryable: false,
      },
    }
  }

  const artifacts = await normalizeArtifacts(result, workspaceRoot)
  const finishedAt = now()
  await appendRecord(recordPath, {
    ...shared,
    event: "finished",
    occurredAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    terminalState: result.status,
    failureKind: result.status === "completion_proposed" ? null : result.failure.kind,
    backendSessionPresent: result.runtime.backendSessionId !== undefined,
    backendRunPresent: result.runtime.backendRunId !== undefined,
    actionKinds: countActionKinds(result),
    actionStatuses: countActionStatuses(result),
    artifactPaths: artifacts.paths,
    outOfBoundsArtifactCount: artifacts.outOfBoundsCount,
    usage: result.usage,
    permissionRequestCount: result.events.filter((event) =>
      event.type === "permission_requested").length,
    completionPresent: result.status === "completion_proposed" && result.completion.trim().length > 0,
    dirtyAfter: await isDirty(workspaceRoot),
    verification: "pending",
  })

  return {
    runId,
    recordPath,
    result,
    verification: "pending",
    boundaryViolation: artifacts.outOfBoundsCount > 0,
  }
}

export async function recordCodexDogfoodReview(
  options: CodexDogfoodReviewOptions,
): Promise<CodexDogfoodReviewSummary> {
  if (options.runId.trim().length === 0) {
    throw new CodexDogfoodConfigurationError("Dogfood review --run-id must not be empty")
  }
  if (!isOneOf(options.verification, codexDogfoodReviewVerifications)) {
    throw new CodexDogfoodConfigurationError(
      "Dogfood review --verification must be passed, failed, or not_run",
    )
  }
  if (!isOneOf(options.experience, codexDogfoodReviewExperiences)) {
    throw new CodexDogfoodConfigurationError(
      "Dogfood review --experience must be smooth, mixed, or blocked",
    )
  }
  if (!isOneOf(options.intervention, codexDogfoodReviewInterventions)) {
    throw new CodexDogfoodConfigurationError(
      "Dogfood review --intervention must be none, minor, or major",
    )
  }

  const recordPath = await resolveExistingPrivateRecordPath(options.recordPath)
  const state = await readReviewState(recordPath, options.runId)
  if (!state.finished) {
    throw new CodexDogfoodConfigurationError(
      "Dogfood review requires an existing finished run ID",
    )
  }
  if (state.reviewed) {
    throw new CodexDogfoodConfigurationError(
      "Dogfood review already exists for this run ID",
    )
  }

  await appendRecord(recordPath, {
    schemaVersion: 1,
    event: "review",
    runId: options.runId,
    occurredAt: (options.now ?? (() => new Date()))().toISOString(),
    verification: options.verification,
    experience: options.experience,
    intervention: options.intervention,
  }, false)

  return {
    runId: options.runId,
    recordPath,
    verification: options.verification,
    experience: options.experience,
    intervention: options.intervention,
  }
}

function dogfoodPrompt(goal: string): string {
  return [
    `Goal: ${goal}`,
    "Authorization boundary: work only inside the current workspace.",
    "Local reads, edits, and non-destructive validation are allowed.",
    "Do not perform external writes, git commit or push, deployment, destructive actions, or scope expansion.",
    "If any of those are needed, stop and report the requirement.",
    "Your final answer is only a completion proposal; Chaos Harness owns evidence verification.",
  ].join(" ")
}

async function resolveWorkspaceRoot(input: string): Promise<string> {
  let workspaceRoot: string
  try {
    workspaceRoot = await realpath(input)
    if (!(await stat(workspaceRoot)).isDirectory()) {
      throw new CodexDogfoodConfigurationError("Workspace root must be a directory")
    }
  } catch (error) {
    if (error instanceof CodexDogfoodConfigurationError) {
      throw error
    }
    throw new CodexDogfoodConfigurationError("Workspace root must be an existing directory")
  }

  let gitRoot: string
  try {
    gitRoot = await realpath((await readGit(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim())
  } catch {
    throw new CodexDogfoodConfigurationError("Workspace root must be a Git worktree root")
  }
  if (gitRoot !== workspaceRoot) {
    throw new CodexDogfoodConfigurationError("--root must point to the Git worktree root")
  }
  return workspaceRoot
}

async function resolveRecordPath(input: string, workspaceRoot: string): Promise<string> {
  const requested = resolve(input)
  let parent: string
  try {
    parent = await realpath(dirname(requested))
  } catch {
    throw new CodexDogfoodConfigurationError("Record parent directory must already exist")
  }
  const recordPath = join(parent, basename(requested))
  if (isWithin(workspaceRoot, recordPath)) {
    throw new CodexDogfoodConfigurationError("Dogfood record must be outside the workspace")
  }
  try {
    const current = await lstat(recordPath)
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new CodexDogfoodConfigurationError("Dogfood record must be a regular non-symlink file")
    }
    if ((current.mode & 0o077) !== 0) {
      throw new CodexDogfoodConfigurationError("Existing dogfood record must use mode 0600")
    }
  } catch (error) {
    if (error instanceof CodexDogfoodConfigurationError) {
      throw error
    }
    if (isNodeError(error) && error.code !== "ENOENT") {
      throw new CodexDogfoodConfigurationError("Dogfood record cannot be inspected safely")
    }
  }
  return recordPath
}

async function resolveExistingPrivateRecordPath(input: string): Promise<string> {
  const recordPath = resolve(input)
  try {
    const current = await lstat(recordPath)
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new CodexDogfoodConfigurationError("Dogfood record must be a regular non-symlink file")
    }
    if ((current.mode & 0o077) !== 0) {
      throw new CodexDogfoodConfigurationError("Existing dogfood record must use mode 0600")
    }
  } catch (error) {
    if (error instanceof CodexDogfoodConfigurationError) {
      throw error
    }
    throw new CodexDogfoodConfigurationError("Dogfood review record must already exist")
  }
  return recordPath
}

async function readReviewState(
  recordPath: string,
  runId: string,
): Promise<{ finished: boolean; reviewed: boolean }> {
  const raw = await readFile(recordPath, "utf8")
  let finished = false
  let reviewed = false
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      throw new CodexDogfoodConfigurationError("Dogfood record must contain valid JSONL")
    }
    if (!isRecord(record) || record.runId !== runId) {
      continue
    }
    if (record.event === "finished") {
      finished = true
    } else if (record.event === "review") {
      reviewed = true
    }
  }
  return { finished, reviewed }
}

async function appendRecord(
  path: string,
  value: Record<string, unknown>,
  createIfMissing = true,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (createIfMissing ? constants.O_CREAT : 0),
    0o600,
  )
  try {
    const current = await handle.stat()
    if (!current.isFile() || (current.mode & 0o077) !== 0) {
      throw new CodexDogfoodConfigurationError(
        "Dogfood record must remain a private owner-only regular file",
      )
    }
    await handle.appendFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" })
  } finally {
    await handle.close()
  }
}

async function isDirty(workspaceRoot: string): Promise<boolean> {
  return (await readGit(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]))
    .trim().length > 0
}

async function readGit(workspaceRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })
  return result.stdout.trim()
}

async function normalizeArtifacts(
  result: HostAttemptResult,
  workspaceRoot: string,
): Promise<{ paths: string[]; outOfBoundsCount: number }> {
  const paths = new Set<string>()
  let outOfBoundsCount = 0
  for (const artifact of result.artifacts) {
    const lexicalPath = isAbsolute(artifact.path)
      ? resolve(artifact.path)
      : resolve(workspaceRoot, artifact.path)
    let absolute = lexicalPath
    try {
      absolute = await realpath(lexicalPath)
    } catch {
      // Deleted artifacts cannot be canonicalized; retain the lexical containment check.
    }
    if (!isWithin(workspaceRoot, absolute) || absolute === workspaceRoot) {
      outOfBoundsCount += 1
      continue
    }
    paths.add(relative(workspaceRoot, absolute))
  }
  return { paths: [...paths].sort(), outOfBoundsCount }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function countActionKinds(result: HostAttemptResult): Record<HostActionKind, number> {
  const counts: Record<HostActionKind, number> = { read: 0, mutation: 0, execute: 0, other: 0 }
  for (const action of result.actions) {
    counts[action.kind] += 1
  }
  return counts
}

function countActionStatuses(result: HostAttemptResult): Record<"completed" | "failed", number> {
  const counts = { completed: 0, failed: 0 }
  for (const action of result.actions) {
    counts[action.status] += 1
  }
  return counts
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOneOf<const T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return allowed.includes(value)
}
