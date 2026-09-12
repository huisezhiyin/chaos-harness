#!/usr/bin/env node
import { execFile, spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { lstat, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { DEFAULT_CODEX_COMMAND } from "../../codex-app-server/src/client.js"
import {
  assertCompatibleCodexCliVersion,
  readCodexCliVersion,
} from "../../codex-app-server/src/version.js"
import {
  createOpenCodeBridgeConfig,
  OPENCODE_BRIDGE_HOST,
  OPENCODE_BRIDGE_MODEL,
  OPENCODE_BRIDGE_SMALL_MODEL,
  startOpenCodeCodexBridge,
  type OpenCodeCodexBridge,
} from "./server.js"

const execFileAsync = promisify(execFile)
export const SUPPORTED_OPENCODE_VERSION = "1.18.26"
export const DEFAULT_OPENCODE_COMMAND = "opencode"

export interface OpenCodeHostUxCliArgs {
  help: boolean
  selfCheck: boolean
  live: boolean
  allowDirty: boolean
  root: string
  codexModel: string | undefined
  recordPath: string | undefined
  opencodeCommand: string
  codexCommand: string
  timeoutMs: number
  explicitRoot: boolean
}

export interface OpenCodeHostUxLaunchOptions {
  root: string
  codexModel: string
  recordPath: string
  opencodeCommand: string
  codexCommand: string
  timeoutMs: number
  allowDirty: boolean
  existingConfigContent?: string
}

export interface OpenCodeHostUxSelfCheckResult {
  status: "ready"
  liveReady: false
  openCodeVersion: string
  codexVersion: string
  bridge: {
    host: typeof OPENCODE_BRIDGE_HOST
    config: "process_overlay"
    codeModel: typeof OPENCODE_BRIDGE_MODEL
    metadataModel: typeof OPENCODE_BRIDGE_SMALL_MODEL
  }
  workspace: "git_root"
}

export class OpenCodeHostUxCliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message)
    this.name = "OpenCodeHostUxCliError"
  }
}

export function parseOpenCodeHostUxCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): OpenCodeHostUxCliArgs {
  let help = false
  let selfCheck = false
  let live = false
  let allowDirty = false
  let root = cwd
  let codexModel: string | undefined
  let recordPath: string | undefined
  let opencodeCommand = resolveDefaultOpenCodeCommand()
  let codexCommand = DEFAULT_CODEX_COMMAND
  let timeoutMs = 1_800_000
  let explicitRoot = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }
    if (argument === "--self-check") {
      selfCheck = true
      continue
    }
    if (argument === "--live") {
      live = true
      continue
    }
    if (argument === "--allow-dirty") {
      allowDirty = true
      continue
    }
    if (
      argument === "--root" ||
      argument === "--model" ||
      argument === "--record" ||
      argument === "--opencode-bin" ||
      argument === "--codex-bin" ||
      argument === "--timeout-ms"
    ) {
      const value = argv[index + 1]
      if (value === undefined) throw new OpenCodeHostUxCliError(`${argument} requires a value`)
      if (argument === "--root") {
        root = resolve(cwd, value)
        explicitRoot = true
      } else if (argument === "--model") {
        codexModel = value
      } else if (argument === "--record") {
        recordPath = resolve(cwd, value)
      } else if (argument === "--opencode-bin") {
        opencodeCommand = resolveExecutable(cwd, value)
      } else if (argument === "--codex-bin") {
        codexCommand = resolveExecutable(cwd, value)
      } else {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_600_000) {
          throw new OpenCodeHostUxCliError("--timeout-ms must be an integer from 1 to 3600000")
        }
        timeoutMs = parsed
      }
      index += 1
      continue
    }
    throw new OpenCodeHostUxCliError(`Unknown option: ${String(argument)}`)
  }

  return {
    help,
    selfCheck,
    live,
    allowDirty,
    root,
    codexModel,
    recordPath,
    opencodeCommand,
    codexCommand,
    timeoutMs,
    explicitRoot,
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    selfCheck?: typeof runOpenCodeHostUxSelfCheck
    launch?: typeof launchOpenCodeHostUx
    stdout?: (text: string) => void
    stderr?: (text: string) => void
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text))
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text))
  let args: OpenCodeHostUxCliArgs
  try {
    args = parseOpenCodeHostUxCliArgs(argv)
  } catch (error) {
    if (error instanceof OpenCodeHostUxCliError) {
      stderr(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }

  if (args.help) {
    stdout(`${usage()}\n`)
    return 0
  }
  if (args.selfCheck) {
    if (args.live || args.allowDirty || args.codexModel !== undefined || args.recordPath !== undefined) {
      stderr("--self-check cannot be combined with live options\n")
      return 2
    }
    try {
      const result = await (dependencies.selfCheck ?? runOpenCodeHostUxSelfCheck)({
        root: args.root,
        opencodeCommand: args.opencodeCommand,
        codexCommand: args.codexCommand,
      })
      stdout(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    } catch (error) {
      stderr(`${safeErrorMessage(error, "OpenCode Host UX self-check failed")}\n`)
      return 1
    }
  }
  if (!args.live) {
    stderr("OpenCode Host UX live gate is closed; pass --live to open an interactive dogfood session\n")
    return 2
  }
  if (args.codexModel === undefined || args.codexModel.trim().length === 0) {
    stderr("--live requires an exact --model\n")
    return 2
  }
  if (args.recordPath === undefined) {
    stderr("--live requires an outside-workspace --record path\n")
    return 2
  }

  try {
    const exitCode = await (dependencies.launch ?? launchOpenCodeHostUx)({
      root: args.root,
      codexModel: args.codexModel,
      recordPath: args.recordPath,
      opencodeCommand: args.opencodeCommand,
      codexCommand: args.codexCommand,
      timeoutMs: args.timeoutMs,
      allowDirty: args.allowDirty,
      ...(process.env.OPENCODE_CONFIG_CONTENT === undefined
        ? {}
        : { existingConfigContent: process.env.OPENCODE_CONFIG_CONTENT }),
    })
    return exitCode
  } catch (error) {
    stderr(`${safeErrorMessage(error, "OpenCode Host UX launch failed")}\n`)
    return 1
  }
}

export async function launchOpenCodeHostUx(
  options: OpenCodeHostUxLaunchOptions,
  dependencies: {
    startBridge?: typeof startOpenCodeCodexBridge
    runTui?: (input: {
      command: string
      args: readonly string[]
      env: NodeJS.ProcessEnv
    }) => Promise<number>
    verifyVersions?: typeof verifyRuntimeVersions
  } = {},
): Promise<number> {
  const paths = await resolveLaunchPaths(options.root, options.recordPath)
  await (dependencies.verifyVersions ?? verifyRuntimeVersions)(
    options.opencodeCommand,
    options.codexCommand,
  )
  let bridge: OpenCodeCodexBridge | undefined
  try {
    bridge = await (dependencies.startBridge ?? startOpenCodeCodexBridge)({
      workspaceRoot: paths.root,
      codexModel: options.codexModel,
      recordPath: paths.recordPath,
      codexCommand: options.codexCommand,
      timeoutMs: options.timeoutMs,
      allowDirty: options.allowDirty,
    })
    const config = createOpenCodeBridgeConfig(
      bridge.baseUrl,
      bridge.apiKey,
      options.existingConfigContent,
    )
    return await (dependencies.runTui ?? runTuiProcess)({
      command: options.opencodeCommand,
      args: ["--pure", paths.root, "--model", OPENCODE_BRIDGE_MODEL],
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      },
    })
  } finally {
    await bridge?.close()
  }
}

export async function runOpenCodeHostUxSelfCheck(options: {
  root: string
  opencodeCommand: string
  codexCommand: string
  readOpenCodeVersion?: typeof readOpenCodeVersion
  readCodexVersion?: typeof readCodexCliVersion
  startBridge?: typeof startOpenCodeCodexBridge
}): Promise<OpenCodeHostUxSelfCheckResult> {
  await resolveGitRoot(options.root)
  const openCodeVersion = await (options.readOpenCodeVersion ?? readOpenCodeVersion)(options.opencodeCommand)
  assertCompatibleOpenCodeVersion(openCodeVersion)
  const codexVersion = await (options.readCodexVersion ?? readCodexCliVersion)(options.codexCommand)
  assertCompatibleCodexCliVersion(codexVersion)

  const bridge = await (options.startBridge ?? startOpenCodeCodexBridge)({
    workspaceRoot: await realpath(options.root),
    codexModel: "self-check-no-live-model",
    recordPath: join(tmpdir(), "chaos-harness-opencode-self-check.jsonl"),
    attemptRunner: async () => {
      throw new Error("Self-check must not run an Attempt")
    },
  })
  try {
    createOpenCodeBridgeConfig(bridge.baseUrl, bridge.apiKey)
  } finally {
    await bridge.close()
  }
  return {
    status: "ready",
    liveReady: false,
    openCodeVersion,
    codexVersion,
    bridge: {
      host: OPENCODE_BRIDGE_HOST,
      config: "process_overlay",
      codeModel: OPENCODE_BRIDGE_MODEL,
      metadataModel: OPENCODE_BRIDGE_SMALL_MODEL,
    },
    workspace: "git_root",
  }
}

export async function verifyRuntimeVersions(
  opencodeCommand: string,
  codexCommand: string,
): Promise<{ openCodeVersion: string; codexVersion: string }> {
  const [openCodeVersion, codexVersion] = await Promise.all([
    readOpenCodeVersion(opencodeCommand),
    readCodexCliVersion(codexCommand),
  ])
  assertCompatibleOpenCodeVersion(openCodeVersion)
  assertCompatibleCodexCliVersion(codexVersion)
  return { openCodeVersion, codexVersion }
}

export async function readOpenCodeVersion(
  command = DEFAULT_OPENCODE_COMMAND,
  timeoutMs = 5_000,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: timeoutMs })
    const match = /^(\S+)\s*$/.exec(stdout)
    if (match?.[1] === undefined) throw new Error("unrecognized output")
    return match[1]
  } catch (error) {
    throw new OpenCodeHostUxCliError(`Unable to read OpenCode version: ${safeErrorMessage(error, "unknown error")}`, 1)
  }
}

export function assertCompatibleOpenCodeVersion(version: string): void {
  if (version !== SUPPORTED_OPENCODE_VERSION) {
    throw new OpenCodeHostUxCliError(
      `Unsupported OpenCode version ${version}; expected ${SUPPORTED_OPENCODE_VERSION}`,
      1,
    )
  }
}

export function resolveDefaultOpenCodeCommand(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
  canExecute: (path: string) => boolean = isExecutable,
): string {
  if (env.OPENCODE_BIN !== undefined && env.OPENCODE_BIN.trim().length > 0) {
    return env.OPENCODE_BIN
  }
  const userInstall = join(homeDirectory, ".opencode", "bin", "opencode")
  return canExecute(userInstall) ? userInstall : DEFAULT_OPENCODE_COMMAND
}

async function resolveLaunchPaths(
  rootInput: string,
  recordInput: string,
): Promise<{ root: string; recordPath: string }> {
  const root = await resolveGitRoot(rootInput)
  const recordParent = await realpath(dirname(resolve(recordInput)))
  const recordPath = join(recordParent, basename(resolve(recordInput)))
  if (isWithin(root, recordPath)) {
    throw new OpenCodeHostUxCliError("Dogfood record must be outside the workspace")
  }
  try {
    const current = await lstat(recordPath)
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new OpenCodeHostUxCliError("Dogfood record must be a regular non-symlink file")
    }
    if ((current.mode & 0o077) !== 0) {
      throw new OpenCodeHostUxCliError("Existing dogfood record must use mode 0600")
    }
  } catch (error) {
    if (error instanceof OpenCodeHostUxCliError) throw error
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new OpenCodeHostUxCliError("Dogfood record cannot be inspected safely")
    }
  }
  return { root, recordPath }
}

async function resolveGitRoot(input: string): Promise<string> {
  let root: string
  try {
    root = await realpath(input)
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory")
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 5_000 })
    if (await realpath(stdout.trim()) !== root) throw new Error("not the worktree root")
  } catch {
    throw new OpenCodeHostUxCliError("--root must point to an existing Git worktree root")
  }
  return root
}

async function runTuiProcess(input: {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
}): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolvePromise(1)
        return
      }
      resolvePromise(code ?? 1)
    })
  })
}

function isWithin(root: string, target: string): boolean {
  const candidate = relative(root, target)
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
}

function resolveExecutable(cwd: string, value: string): string {
  return value.includes("/") ? resolve(cwd, value) : value
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm agent:opencode -- --self-check [--root <git-worktree>] [--opencode-bin <path>] [--codex-bin <path>]",
    "  pnpm agent:opencode -- --live --root <git-worktree> --model <exact-codex-model> --record <outside-workspace-jsonl> [--allow-dirty] [--timeout-ms <ms>]",
    "",
    "The live command opens the native OpenCode TUI. Each submitted coding prompt becomes one Chaos Harness Codex Attempt.",
    "For a multi-prompt coding session, review git status first and pass --allow-dirty because earlier prompts may leave changes.",
    "No model turn starts during --self-check or until you submit text in the TUI.",
  ].join("\n")
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (error: unknown) => {
      process.stderr.write(`${safeErrorMessage(error, "OpenCode Host UX failed")}\n`)
      process.exitCode = 1
    },
  )
}
