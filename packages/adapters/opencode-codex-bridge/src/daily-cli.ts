#!/usr/bin/env node
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, chmod, lstat, mkdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type { AttemptProgressPolicy, LoopBudget } from "../../../kernel/src/index.js"
import { main as runAdvancedLauncher, resolveDefaultOpenCodeCommand } from "./cli.js"
import {
  DEFAULT_QWEN_MODEL,
  launchOpenCodeQwen,
  loadQwenProfile,
  QwenProfileError,
  QwenHostLaunchError,
  type QwenProfile,
} from "./qwen.js"
import type {
  QwenCompletionVerifier,
  QwenMutationProgressSteerPolicy,
} from "./qwen-loop-bridge.js"
import { chatIdentity, ModelProfileError, profileIdentity, readModelProfiles, resolveChatProfile, selectModelProfile, type ModelProfile } from "./model-profiles.js"
import { loadTokenSwitchProfile } from "./token-switch-profile.js"

const execFileAsync = promisify(execFile)
export const DEFAULT_DAILY_CODEX_MODEL = "gpt-5.5"
export const DEFAULT_DAILY_PROFILE = "qwen" as const
export const DEFAULT_QWEN_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env")
const MAX_STATUS_LINES = 40

export type ChaosDailyProfile = string

export interface ChaosDailyCliArgs {
  help: boolean
  profile: ChaosDailyProfile
  root: string
  model: string
  modelExplicit: boolean
  stateDirectory: string
  envFile: string
  profilesFile?: string
  listProfiles?: boolean
  checkProfile?: boolean
  tokenSwitchConfig?: string
  qwenSource?: "personal" | "company" | "dogfood"
}

export interface PreparedChaosDailyLaunch {
  root: string
  model: string
  recordPath: string
  dirty: boolean
  statusSummary: string
}

export class ChaosDailyLauncherError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message)
    this.name = "ChaosDailyLauncherError"
  }
}

export function parseChaosDailyCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): ChaosDailyCliArgs {
  let help = false
  let root = cwd
  let profile = parseProfile(env.CHAOS_PROFILE?.trim() || DEFAULT_DAILY_PROFILE)
  let model = env.CHAOS_MODEL?.trim() || ""
  let modelExplicit = model.length > 0
  const stateBase = env.XDG_STATE_HOME?.trim() || join(homeDirectory, ".local", "state")
  let stateDirectory = env.CHAOS_HARNESS_STATE_DIR?.trim() || join(stateBase, "chaos-harness")
  let envFile = env.CHAOS_ENV_FILE?.trim() || DEFAULT_QWEN_ENV_FILE
  let profilesFile = env.CHAOS_PROFILES_FILE?.trim()
  let listProfiles = false
  let checkProfile = false
  let qwenSource: ChaosDailyCliArgs["qwenSource"]
  let tokenSwitchConfig: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }
    if (argument === "--list-profiles") { listProfiles = true; continue }
    if (argument === "--check-profile") { checkProfile = true; continue }
    if (argument === "--token-switch") { tokenSwitchConfig = join(homeDirectory, ".config", "opencode", "opencode.json"); continue }
    if (
      argument === "--profile" ||
      argument === "--root" ||
      argument === "--model" ||
      argument === "--state-dir" ||
      argument === "--qwen" || argument === "--env-file" || argument === "--profiles" || argument === "--token-switch-config"
    ) {
      const value = argv[index + 1]
      if (value === undefined || value.trim().length === 0) {
        throw new ChaosDailyLauncherError(`${argument} requires a value`)
      }
      if (argument === "--qwen") {
        if (qwenSource || !["personal", "company", "dogfood"].includes(value)) throw new ChaosDailyLauncherError("--qwen requires exactly one of personal, company, dogfood")
        qwenSource = value as NonNullable<ChaosDailyCliArgs["qwenSource"]>
      }
      else if (argument === "--profile") profile = parseProfile(value)
      else if (argument === "--root") root = resolve(cwd, value)
      else if (argument === "--model") {
        model = value
        modelExplicit = true
      } else if (argument === "--state-dir") stateDirectory = resolve(cwd, value)
      else if (argument === "--profiles") profilesFile = resolve(cwd, value)
      else if (argument === "--token-switch-config") tokenSwitchConfig = resolve(cwd, value)
      else envFile = resolve(cwd, value)
      index += 1
      continue
    }
    throw new ChaosDailyLauncherError(`Unknown option: ${String(argument)}`)
  }

  if (qwenSource) {
    if (profilesFile || argv.includes("--profile") || argv.includes("--token-switch")) {
      throw new ChaosDailyLauncherError("--qwen selects an access source; do not combine it with --profile, --profiles or --token-switch")
    }
    if (qwenSource === "personal") {
      if (tokenSwitchConfig) throw new ChaosDailyLauncherError("Personal Qwen does not use --token-switch-config")
      profile = "qwen"
    } else {
      tokenSwitchConfig ??= resolve(cwd, (qwenSource === "company" ? env.CHAOS_QWEN_COMPANY_CONFIG : env.CHAOS_QWEN_DOGFOOD_CONFIG)?.trim() || join(homeDirectory, ".config", "opencode", "opencode.json"))
    }
  }
  if (tokenSwitchConfig) {
    if (profilesFile || modelExplicit || listProfiles || argv.includes("--env-file") || argv.includes("--profile")) {
      throw new ChaosDailyLauncherError("--token-switch uses the selected dogfood connection; do not combine it with profile/model/env-file/list overrides")
    }
    profile = qwenSource === "company" ? "qwen-company" : "dogfood"
  }
  if (!help && !profilesFile && !tokenSwitchConfig && profile !== "qwen" && profile !== "codex") {
    throw new ChaosDailyLauncherError("Named profiles require --profiles <json-file>; no fallback was attempted")
  }
  if (profilesFile && argv.includes("--env-file")) {
    throw new ChaosDailyLauncherError("--env-file is for legacy Qwen; named profiles use apiKeyEnv")
  }
  if (!modelExplicit && !profilesFile && !tokenSwitchConfig) {
    model = profile === "qwen"
      ? DEFAULT_QWEN_MODEL
      : (env.CHAOS_CODEX_MODEL?.trim() || DEFAULT_DAILY_CODEX_MODEL)
  }
  return { help, profile, root, model, modelExplicit, stateDirectory, envFile,
    ...(profilesFile ? { profilesFile: resolve(cwd, profilesFile) } : {}),
    ...(tokenSwitchConfig ? { tokenSwitchConfig } : {}),
    ...(qwenSource ? { qwenSource } : {}),
    ...(listProfiles ? { listProfiles: true } : {}), ...(checkProfile ? { checkProfile: true } : {}),
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    prepare?: typeof prepareChaosDailyLaunch
    confirmDirty?: (prepared: PreparedChaosDailyLaunch) => Promise<boolean>
    advancedLauncher?: (argv: readonly string[]) => Promise<number>
    qwenProfileLoader?: typeof loadQwenProfile
    qwenLauncher?: typeof launchOpenCodeQwen
    completionVerifier?: QwenCompletionVerifier
    attemptBudget?: LoopBudget
    mutationProgressSteer?: QwenMutationProgressSteerPolicy
    progressPolicy?: AttemptProgressPolicy
    opencodeCommand?: string
    recordQwenEvent?: typeof recordQwenSessionEvent
    stdout?: (text: string) => void
    stderr?: (text: string) => void
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text))
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text))
  let args: ChaosDailyCliArgs
  try {
    args = parseChaosDailyCliArgs(argv)
  } catch (error) {
    if (error instanceof ChaosDailyLauncherError) {
      stderr(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }

  if (args.help) {
    stdout(`${usage()}\n`)
    return 0
  }

  let qwenProfile: QwenProfile | undefined
  let namedProfile: ModelProfile | undefined
  if (args.tokenSwitchConfig) {
    try {
      qwenProfile = await loadTokenSwitchProfile(args.tokenSwitchConfig, args.qwenSource === "company" ? "company" : "dogfood", args.qwenSource === "company" ? "高级" : args.qwenSource === "dogfood" ? "Qwen3.8-Max-DogFooding" : undefined)
      args = { ...args, model: qwenProfile.model }
    } catch (error) {
      stderr(`${error instanceof ModelProfileError ? error.message : "Token Switch connection could not be loaded"}\n`)
      return 2
    }
  } else if (args.profilesFile) {
    try {
      const profiles = await readModelProfiles(args.profilesFile)
      if (args.listProfiles) {
        stdout(`${JSON.stringify([...profiles.values()].map(profile => ({ ...profileIdentity(profile), enabled: profile.enabled })), null, 2)}\n`)
        return 0
      }
      namedProfile = selectModelProfile(profiles, args.profile, args.modelExplicit ? args.model : undefined)
      args = { ...args, model: namedProfile.model }
      if (namedProfile.adapter === "chat-api") qwenProfile = resolveChatProfile(namedProfile)
    } catch (error) {
      stderr(`${error instanceof ModelProfileError ? error.message : "Model profile could not be loaded"}\n`)
      return 2
    }
  } else if (args.listProfiles) {
    stdout("qwen: chat-api / model-tool-turn (personal)\n--qwen company: Token Switch regular selection\n--qwen dogfood: Token Switch DogFood selection\ncodex: codex-app-server / attempt\nUse --profiles <json-file> for named profiles.\n")
    return 0
  } else if (args.profile === "qwen") {
    try {
      qwenProfile = await (dependencies.qwenProfileLoader ?? loadQwenProfile)({
        envFilePath: args.envFile,
        ...(args.modelExplicit ? { modelOverride: args.model } : {}),
      })
      args = { ...args, model: qwenProfile.model }
    } catch (error) {
      stderr(`${safeErrorMessage(error, "Qwen profile could not be loaded")}\n`)
      return error instanceof QwenProfileError ? error.exitCode : 1
    }
  }
  if (args.checkProfile) {
    stdout(`${JSON.stringify(namedProfile ? profileIdentity(namedProfile) : qwenProfile ? { ...chatIdentity(qwenProfile), displayName: qwenProfile.access?.displayName ?? qwenProfile.model, source: args.qwenSource ?? (args.tokenSwitchConfig ? "dogfood" : "personal") } : {
      profile: "codex", adapter: "codex-app-server", provider: "codex", model: args.model, controlDepth: "attempt",
    })}\nLocal configuration valid; connectivity, login, credits and model capabilities were not tested.\n`)
    return 0
  }

  let prepared: PreparedChaosDailyLaunch
  try {
    prepared = await (dependencies.prepare ?? prepareChaosDailyLaunch)(args)
  } catch (error) {
    stderr(`${safeErrorMessage(error, "Chaos daily launcher preflight failed")}\n`)
    return error instanceof ChaosDailyLauncherError ? error.exitCode : 1
  }

  if (prepared.dirty) {
    stdout(`Chaos Harness found existing worktree changes:\n${prepared.statusSummary}\n`)
    const accepted = await (dependencies.confirmDirty ?? confirmDirtyInteractively)(prepared)
    if (!accepted) {
      stderr("Launch cancelled; existing worktree changes were not accepted.\n")
      return 2
    }
  }

  stdout(`Opening OpenCode through Chaos Harness (${args.profile}/${qwenProfile?.access?.displayName ?? prepared.model}).\n`)
  if (namedProfile?.adapter === "codex-app-server" || (!namedProfile && args.profile === "codex")) {
    const launch = () => (dependencies.advancedLauncher ?? runAdvancedLauncher)([
      "--live", "--root", prepared.root, "--model", prepared.model,
      "--record", prepared.recordPath, "--allow-dirty",
    ])
    // The advanced launcher retains its own Attempt journal and control boundary.
    if (namedProfile) {
      const record = dependencies.recordQwenEvent ?? recordQwenSessionEvent
      const identity = profileIdentity(namedProfile)
      await record(prepared.recordPath, { event: "backend_selected", ...identity })
      try {
        const exitCode = await launch()
        await record(prepared.recordPath, { event: "backend_session_ended", ...identity, exitCode })
        return exitCode
      } catch {
        await record(prepared.recordPath, { event: "backend_session_failed", ...identity })
        stderr("Codex app-server launch failed\n")
        return 1
      }
    }
    return await launch()
  }

  const selectedQwen = qwenProfile as QwenProfile
  const identity = chatIdentity(selectedQwen)
  const recordEvent = dependencies.recordQwenEvent ?? recordQwenSessionEvent
  await recordEvent(prepared.recordPath, {
    event: "session_started",
    ...identity,
  })
  try {
    const exitCode = await (dependencies.qwenLauncher ?? launchOpenCodeQwen)({
      root: prepared.root,
      profile: selectedQwen,
      opencodeCommand: dependencies.opencodeCommand ?? resolveDefaultOpenCodeCommand(),
      recordEvent: async (event) => recordEvent(prepared.recordPath, event),
      ...(dependencies.completionVerifier === undefined
        ? {}
        : { completionVerifier: dependencies.completionVerifier }),
      ...(dependencies.attemptBudget === undefined
        ? {}
        : { attemptBudget: dependencies.attemptBudget }),
      ...(dependencies.mutationProgressSteer === undefined
        ? {}
        : { mutationProgressSteer: dependencies.mutationProgressSteer }),
      ...(dependencies.progressPolicy === undefined ? {} : { progressPolicy: dependencies.progressPolicy }),
    })
    await recordEvent(prepared.recordPath, {
      event: "session_ended",
      ...identity,
      exitCode,
    })
    return exitCode
  } catch (error) {
    await recordEvent(prepared.recordPath, {
      event: "session_failed",
      ...identity,
      failure: error instanceof QwenHostLaunchError ? error.message : (namedProfile || args.tokenSwitchConfig) ? "Chat API host launch failed" : safeErrorMessage(error, "Qwen OpenCode launch failed"),
    })
    stderr(`${error instanceof QwenHostLaunchError ? error.message : (namedProfile || args.tokenSwitchConfig) ? "Chat API host launch failed" : safeErrorMessage(error, "Qwen OpenCode launch failed")}\n`)
    return 1
  }
}

export async function prepareChaosDailyLaunch(
  args: Pick<ChaosDailyCliArgs, "root" | "model" | "stateDirectory">,
): Promise<PreparedChaosDailyLaunch> {
  const root = await resolveGitRoot(args.root)
  const stateDirectory = await canonicalizeTargetPath(args.stateDirectory)
  if (isWithin(root, stateDirectory)) {
    throw new ChaosDailyLauncherError("Chaos state directory must stay outside the target worktree")
  }
  await ensurePrivateStateDirectory(stateDirectory)
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "status", "--short", "--untracked-files=normal"],
    { timeout: 5_000, maxBuffer: 262_144 },
  )
  const status = stdout.trimEnd()
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  const slug = basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree"
  return {
    root,
    model: args.model,
    recordPath: join(stateDirectory, `${slug}-${hash}.jsonl`),
    dirty: status.trim().length > 0,
    statusSummary: summarizeStatus(status),
  }
}

async function canonicalizeTargetPath(input: string): Promise<string> {
  const requested = resolve(input)
  const suffix: string[] = [basename(requested)]
  let cursor = dirname(requested)
  while (true) {
    try {
      return join(await realpath(cursor), ...suffix.reverse())
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new ChaosDailyLauncherError("Chaos state directory parent cannot be resolved safely")
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        throw new ChaosDailyLauncherError("Chaos state directory parent cannot be resolved safely")
      }
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

async function ensurePrivateStateDirectory(path: string): Promise<void> {
  try {
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new ChaosDailyLauncherError("Chaos state path must be a real directory, not a symlink")
    }
    const currentUid = process.getuid?.()
    if (currentUid !== undefined && current.uid !== currentUid) {
      throw new ChaosDailyLauncherError("Chaos state directory must be owned by the current user")
    }
  } catch (error) {
    if (error instanceof ChaosDailyLauncherError) throw error
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new ChaosDailyLauncherError("Chaos state directory cannot be inspected safely")
    }
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  await chmod(path, 0o700)
  const secured = await lstat(path)
  if (secured.isSymbolicLink() || !secured.isDirectory() || (secured.mode & 0o077) !== 0) {
    throw new ChaosDailyLauncherError("Chaos state directory could not be secured to mode 0700")
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
    throw new ChaosDailyLauncherError("Run chaos from a Git worktree root, or pass --root <git-worktree>")
  }
}

async function confirmDirtyInteractively(_prepared: PreparedChaosDailyLaunch): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question("Continue with these existing changes? [y/N] ")
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
  } finally {
    prompt.close()
  }
}

export async function recordQwenSessionEvent(
  path: string,
  event: object,
): Promise<void> {
  try {
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isFile() || (current.mode & 0o077) !== 0) {
      throw new ChaosDailyLauncherError("Existing Chaos journal must be a regular 0600 file")
    }
  } catch (error) {
    if (error instanceof ChaosDailyLauncherError) throw error
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new ChaosDailyLauncherError("Chaos journal cannot be inspected safely")
    }
  }
  const line = JSON.stringify({
    schema: "chaos.harness.host-session.v1",
    timestamp: new Date().toISOString(),
    ...event,
  })
  await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 })
  await chmod(path, 0o600)
}

function summarizeStatus(status: string): string {
  if (status.trim().length === 0) return "(clean)"
  const lines = status.split("\n")
  const visible = lines.slice(0, MAX_STATUS_LINES)
  if (lines.length > MAX_STATUS_LINES) {
    visible.push(`... ${lines.length - MAX_STATUS_LINES} more entries`)
  }
  return visible.join("\n")
}

function isWithin(root: string, target: string): boolean {
  const candidate = relative(root, target)
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function parseProfile(value: string): ChaosDailyProfile {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) return value
  throw new ChaosDailyLauncherError("--profile requires a plain profile name")
}

function usage(): string {
  return [
    "Usage:",
    "  chaos",
    "  chaos [--profile qwen|codex] [--root <git-worktree>] [--model <exact-model>]",
    "        [--env-file <private-env-file>] [--state-dir <outside-workspace-directory>]",
    "  chaos --profiles <json-file> --profile <name> [--model <exact-model>]",
    "  chaos [--profiles <json-file>] --list-profiles",
    "  chaos --profiles <json-file> --profile <name> --check-profile",
    "  chaos --qwen personal|company|dogfood [--check-profile] [--root <git-worktree>]",
    "  chaos --token-switch [--check-profile] [--root <git-worktree>]",
    "        [--token-switch-config <explicit-opencode-json>]",
    "",
    "Run from a Git worktree root to open the native OpenCode TUI through Chaos Harness.",
    `Default profile: Qwen through the Chaos NativeAttemptEngine with relayed OpenCode tools (${DEFAULT_QWEN_MODEL}).`,
    `Codex fallback: chaos --profile codex (default model ${DEFAULT_DAILY_CODEX_MODEL}).`,
    `Qwen credentials default to the private Git-ignored file: ${DEFAULT_QWEN_ENV_FILE}`,
    "A private per-worktree journal is created under ~/.local/state/chaos-harness.",
    "Existing worktree changes require one interactive confirmation; later prompts may continue on session changes.",
    "No model call starts until you submit normal text in the OpenCode TUI.",
    "Named profiles: chat-api or codex-app-server. Checks are local only; no credit/eligibility claim.",
  ].join("\n")
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (error: unknown) => {
      process.stderr.write(`${safeErrorMessage(error, "Chaos daily launcher failed")}\n`)
      process.exitCode = 1
    },
  )
}
