import type { UnitBudgetLimits } from "../../../kernel/src/loop/unit-budget.js"
import type { ExecutionDeadline } from "../../../kernel/src/loop/execution-deadline.js"
import { execFile, spawn } from "node:child_process"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { AttemptProgressPolicy, LoopBudget } from "../../../kernel/src/index.js"
import { readOpenCodeVersion } from "./cli.js"
import {
  createOpenCodeQwenLoopConfig,
  QWEN_LOOP_MODEL,
  QWEN_LOOP_PROVIDER,
  startOpenCodeQwenLoopBridge,
  type OpenCodeQwenLoopBridge,
  type QwenCompletionVerifier,
  type QwenLoopJournalEvent,
  type QwenMutationProgressSteerPolicy,
} from "./qwen-loop-bridge.js"
import { CHAOS_OBSERVATION_TOKEN_ENV } from "./opencode-observation-envelope.js"
import { CHAOS_TERMINAL_OBSERVATIONS_ENV, prepareTerminalObservations } from "./opencode-terminal-observations.js"
import { prepareOpenCodeHostProfile, verifyOpenCodeHostProfile } from "./opencode-host-profile.js"
import type { ChatAccessSettings } from "./model-profiles.js"

export const QWEN_PROVIDER = QWEN_LOOP_PROVIDER
export const DEFAULT_QWEN_MODEL = "qwen3.8-max"
export const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
export const OPENCODE_QWEN_MODEL = QWEN_LOOP_MODEL

const execFileAsync = promisify(execFile)
const OPENCODE_OBSERVATION_PLUGIN_PATH = fileURLToPath(new URL("./opencode-observation-plugin.ts", import.meta.url))

const QWEN_ENV_KEYS = new Set([
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DASHSCOPE_MODEL",
])

export interface QwenProfile {
  assertConnection?: () => Promise<void>
  /** Internal connection capability; never read from user profile JSON. */
  preserveHostUserAgent?: boolean
  /** Actual authenticated relay caller metadata, bound by the bridge to a Unit. */
  hostUserAgent?: string
  apiKey: string
  baseUrl: string
  model: string
  access?: Readonly<ChatAccessSettings>
}

export class QwenProfileError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message)
    this.name = "QwenProfileError"
  }
}

export async function loadQwenProfile(options: {
  envFilePath: string
  env?: NodeJS.ProcessEnv
  modelOverride?: string
}): Promise<QwenProfile> {
  const env = options.env ?? process.env
  const values = await readPrivateQwenEnvFile(options.envFilePath)
  const apiKey = preferredValue(env.DASHSCOPE_API_KEY, values.DASHSCOPE_API_KEY)
  if (apiKey === undefined) {
    throw new QwenProfileError(`DASHSCOPE_API_KEY is missing; fill it in ${options.envFilePath}`)
  }
  const baseUrl = preferredValue(env.DASHSCOPE_BASE_URL, values.DASHSCOPE_BASE_URL)
    ?? DEFAULT_DASHSCOPE_BASE_URL
  const model = preferredValue(options.modelOverride, env.DASHSCOPE_MODEL, values.DASHSCOPE_MODEL)
    ?? DEFAULT_QWEN_MODEL
  validateBaseUrl(baseUrl)
  validateModel(model)
  return { apiKey, baseUrl: stripTrailingSlash(baseUrl), model }
}

export async function readPrivateQwenEnvFile(path: string): Promise<Partial<Record<string, string>>> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new QwenProfileError(`Qwen environment file does not exist: ${path}`)
    }
    throw new QwenProfileError(`Qwen environment file cannot be inspected: ${path}`)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new QwenProfileError("Qwen environment path must be a regular non-symlink file")
  }
  if ((info.mode & 0o077) !== 0) {
    throw new QwenProfileError("Qwen environment file must use mode 0600")
  }
  return parseQwenEnv(await readFile(path, "utf8"))
}

export function parseQwenEnv(content: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    if (key === undefined || !QWEN_ENV_KEYS.has(key)) continue
    result[key] = parseEnvValue(match[2] ?? "")
  }
  return result
}

export const SUPPORTED_QWEN_HOST_VERSIONS = ["1.18.26", "1.18.27"] as const
export type QwenHostStage = "workspace" | "version" | "profile" | "bridge" | "isolation" | "process"
export class QwenHostLaunchError extends Error {
  constructor(readonly stage: QwenHostStage, version?: string) {
    const detail = stage === "version"
      ? ` Supported OpenCode: ${SUPPORTED_QWEN_HOST_VERSIONS.join(", ")}.${version && /^\d+\.\d+\.\d+$/.test(version) ? ` Detected: ${version}.` : ""}` : ""
    super(`OpenCode host launch failed [host:${stage}].${detail}`)
    this.name = "QwenHostLaunchError"
  }
}

export async function launchOpenCodeQwen(options: {
  root: string
  profile: QwenProfile
  opencodeCommand: string
  recordEvent?: (event: QwenLoopJournalEvent) => Promise<void>
  completionVerifier?: QwenCompletionVerifier
  completionVerifierTimeoutMs?: number
  completionVerificationOrder?: "artifact-first"
  unitBudget?: UnitBudgetLimits
  noArtifactContinuation?: { maxAdditionalActions: number }
  workspacePathRecovery?: { maxAdditionalActions: number }
  deliveryReadiness?: { afterActions: number; probe: QwenCompletionVerifier; timeoutMs?: number }
  attemptBudget?: LoopBudget
  deadline?: ExecutionDeadline
  mutationProgressSteer?: QwenMutationProgressSteerPolicy
  progressPolicy?: AttemptProgressPolicy
  workspaceBoundary?: "root-only"
  modelLengthRecovery?: "once-per-unit"
}, dependencies: {
  readVersion?: typeof readOpenCodeVersion
  startBridge?: typeof startOpenCodeQwenLoopBridge
  prepareHostProfile?: typeof prepareOpenCodeHostProfile
  verifyHostProfile?: typeof verifyOpenCodeHostProfile
  runTui?: (input: {
    command: string
    args: readonly string[]
    env: NodeJS.ProcessEnv
    deadline?: ExecutionDeadline
  }) => Promise<number>
} = {}): Promise<number> {
  let stage: QwenHostStage = "workspace"
  try {
    const root = await resolveGitRoot(options.root)
    stage = "version"
    const version = await (dependencies.readVersion ?? readOpenCodeVersion)(options.opencodeCommand)
    if (!SUPPORTED_QWEN_HOST_VERSIONS.some(supported => supported === version)) throw new QwenHostLaunchError("version", version)
    let bridge: OpenCodeQwenLoopBridge | undefined
    stage = "profile"
    const host = await (dependencies.prepareHostProfile ?? prepareOpenCodeHostProfile)(process.env)
    let terminal: Awaited<ReturnType<typeof prepareTerminalObservations>> | undefined
    // The upstream credential belongs to the Harness process, not the host/tools.
    if (options.profile.access) delete host.env[options.profile.access.apiKeyEnv]
    try {
      terminal = await prepareTerminalObservations()
      stage = "bridge"
      bridge = await (dependencies.startBridge ?? startOpenCodeQwenLoopBridge)({
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        workspaceRoot: root,
        profile: options.profile,
        ...(options.recordEvent === undefined ? {} : { recordEvent: options.recordEvent }),
        ...(options.completionVerifier === undefined
          ? {}
          : { completionVerifier: options.completionVerifier }),
        ...(options.completionVerifierTimeoutMs === undefined ? {} : { completionVerifierTimeoutMs: options.completionVerifierTimeoutMs }),
        ...(options.completionVerificationOrder === undefined ? {} : { completionVerificationOrder: options.completionVerificationOrder }),
        ...(options.unitBudget === undefined ? {} : { unitBudget: options.unitBudget }),
        ...(options.noArtifactContinuation === undefined ? {} : { noArtifactContinuation: options.noArtifactContinuation }),
        ...(options.workspacePathRecovery === undefined ? {} : { workspacePathRecovery: options.workspacePathRecovery }),
        ...(options.deliveryReadiness === undefined ? {} : { deliveryReadiness: options.deliveryReadiness }),
        ...(options.attemptBudget === undefined
          ? {}
          : { attemptBudget: options.attemptBudget }),
        ...(options.mutationProgressSteer === undefined
          ? {}
          : { mutationProgressSteer: options.mutationProgressSteer }),
        ...(options.progressPolicy === undefined ? {} : { progressPolicy: options.progressPolicy }),
        ...(options.workspaceBoundary === undefined ? {} : { workspaceBoundary: options.workspaceBoundary }),
        ...(options.modelLengthRecovery === undefined ? {} : { modelLengthRecovery: options.modelLengthRecovery }),
      })
      const config = createOpenCodeQwenLoopConfig(
        bridge.baseUrl,
        bridge.apiKey,
        OPENCODE_OBSERVATION_PLUGIN_PATH,
        options.profile,
      )
      const env = {
        ...host.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        [CHAOS_OBSERVATION_TOKEN_ENV]: bridge.observationToken,
        [CHAOS_TERMINAL_OBSERVATIONS_ENV]: terminal.path,
      }
      stage = "isolation"
      await (dependencies.verifyHostProfile ?? verifyOpenCodeHostProfile)({
        command: options.opencodeCommand, root, env, observationPlugin: OPENCODE_OBSERVATION_PLUGIN_PATH,
      })
      stage = "process"
      if (options.deadline?.expired) return 1
      return await (dependencies.runTui ?? runTuiProcess)({
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        command: options.opencodeCommand,
        args: [root, "--model", QWEN_LOOP_MODEL],
        env,
      })
    } finally {
      try { await bridge?.close(await terminal?.read().catch(() => [])) }
      finally { try { await terminal?.dispose() } finally { await host.dispose() } }
    }
  } catch (error) {
    if (error instanceof QwenHostLaunchError) throw error
    throw new QwenHostLaunchError(stage)
  }
}

async function resolveGitRoot(input: string): Promise<string> {
  try {
    const root = await realpath(input)
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory")
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { timeout: 5_000 },
    )
    if (await realpath(stdout.trim()) !== root) throw new Error("not the worktree root")
    return root
  } catch {
    throw new QwenProfileError("Qwen root must point to an existing Git worktree root")
  }
}

async function runTuiProcess(input: {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  deadline?: ExecutionDeadline
}): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, { env: input.env, stdio: "inherit",
      ...(input.deadline === undefined ? {} : { signal: input.deadline.signal, killSignal: "SIGKILL" }),
    })
    child.once("error", error => input.deadline?.expired ? resolvePromise(1) : reject(error))
    child.once("exit", (code, signal) => resolvePromise(signal === null ? (code ?? 1) : 1))
  })
}

function preferredValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed.length > 0) return trimmed
  }
  return undefined
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  const comment = /\s+#/.exec(trimmed)
  return (comment === null ? trimmed : trimmed.slice(0, comment.index)).trim()
}

function validateBaseUrl(value: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) throw new Error("unsafe")
  } catch {
    throw new QwenProfileError("DASHSCOPE_BASE_URL must be an HTTPS URL without embedded credentials")
  }
}

function validateModel(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new QwenProfileError("DASHSCOPE_MODEL must be a plain model identifier")
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
