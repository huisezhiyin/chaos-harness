import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type {
  JsonObject,
  PermissionDecision,
  PermissionPort,
  ToolDefinition,
  ToolObservation,
  ToolPort,
  ToolProposal,
} from "../../kernel/src/index.js"
import {
  WorkspaceReadToolPort,
  workspaceReadToolDefinition,
} from "./workspace-read-tool-port.js"

const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const DEFAULT_MAX_CHECK_OUTPUT_BYTES = 64 * 1024
const DEFAULT_CHECK_TIMEOUT_MS = 60_000

export type CodingCheckScript = "typecheck" | "test" | "check"

export const workspaceEditToolDefinition: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace exactly one text fragment in an existing workspace file. Use the sha256 returned by read_file as expectedSha256.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      expectedSha256: {
        type: "string",
        description: "Current file sha256 returned by read_file",
      },
      oldText: { type: "string", description: "Text that must occur exactly once" },
      newText: { type: "string", description: "Replacement text" },
    },
    required: ["path", "expectedSha256", "oldText", "newText"],
    additionalProperties: false,
  },
}

export const runCheckToolDefinition: ToolDefinition = {
  name: "run_check",
  description:
    "Run one bounded package script after editing. Allowed scripts: typecheck, test, check.",
  inputSchema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        enum: ["typecheck", "test", "check"],
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
}

export const inspectChangesToolDefinition: ToolDefinition = {
  name: "inspect_changes",
  description:
    "Inspect files changed by this coding attempt and return hashes plus a bounded unified-style diff.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}

export const codingToolDefinitions: readonly ToolDefinition[] = [
  workspaceReadToolDefinition,
  workspaceEditToolDefinition,
  runCheckToolDefinition,
  inspectChangesToolDefinition,
]

export interface ScriptRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  truncated: boolean
}

export interface ScriptRunner {
  run(
    workspaceRoot: string,
    script: CodingCheckScript,
    signal: AbortSignal,
  ): Promise<ScriptRunResult>
}

export interface CodingEvidenceSnapshot {
  successfulEdits: number
  changedFiles: readonly string[]
  lastEditSequence: number
  lastSuccessfulCheckSequence: number
  lastInspectionSequence: number
  lastSuccessfulCheck: CodingCheckScript | null
}

interface ChangeRecord {
  baselineContent: string
  baselineSha256: string
  currentContent: string
  currentSha256: string
}

interface ResolvedTextFile {
  rootRealPath: string
  targetRealPath: string
  relativePath: string
  content: string
  bytes: Buffer
  sha256: string
  mode: number
}

export interface WorkspaceCodingToolPortOptions {
  maxFileBytes?: number
  scriptRunner?: ScriptRunner
}

export class WorkspaceCodingToolPort implements ToolPort {
  readonly #workspaceRoot: string
  readonly #readPort: WorkspaceReadToolPort
  readonly #maxFileBytes: number
  readonly #scriptRunner: ScriptRunner
  readonly #changes = new Map<string, ChangeRecord>()
  #operationSequence = 0
  #successfulEdits = 0
  #lastEditSequence = 0
  #lastSuccessfulCheckSequence = 0
  #lastInspectionSequence = 0
  #lastSuccessfulCheck: CodingCheckScript | null = null

  constructor(workspaceRoot: string, options: WorkspaceCodingToolPortOptions = {}) {
    this.#workspaceRoot = resolve(workspaceRoot)
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    if (!Number.isSafeInteger(this.#maxFileBytes) || this.#maxFileBytes <= 0) {
      throw new TypeError("maxFileBytes must be a positive integer")
    }
    this.#readPort = new WorkspaceReadToolPort(this.#workspaceRoot, this.#maxFileBytes)
    this.#scriptRunner = options.scriptRunner ?? new PnpmScriptRunner()
  }

  async execute(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    if (signal.aborted) {
      throw signal.reason
    }
    switch (proposal.call.name) {
      case workspaceReadToolDefinition.name:
        return this.#read(proposal, signal)
      case workspaceEditToolDefinition.name:
        return this.#edit(proposal, signal)
      case runCheckToolDefinition.name:
        return this.#runCheck(proposal, signal)
      case inspectChangesToolDefinition.name:
        return this.#inspectChanges(proposal, signal)
      default:
        return failure(proposal, "unsupported_tool", `Unsupported tool: ${proposal.call.name}`)
    }
  }

  snapshotEvidence(): CodingEvidenceSnapshot {
    return {
      successfulEdits: this.#successfulEdits,
      changedFiles: [...this.#changes.entries()]
        .filter(([, change]) => change.baselineSha256 !== change.currentSha256)
        .map(([path]) => path)
        .sort(),
      lastEditSequence: this.#lastEditSequence,
      lastSuccessfulCheckSequence: this.#lastSuccessfulCheckSequence,
      lastInspectionSequence: this.#lastInspectionSequence,
      lastSuccessfulCheck: this.#lastSuccessfulCheck,
    }
  }

  async #read(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    const observation = await this.#readPort.execute(proposal, signal)
    if (!observation.ok) {
      return observation
    }
    const path = observation.metadata?.path
    const sha256 = observation.metadata?.sha256
    if (typeof path !== "string" || typeof sha256 !== "string") {
      return failure(proposal, "read_protocol_error", "read_file metadata is incomplete")
    }
    return {
      ...observation,
      content: JSON.stringify({ path, sha256, content: observation.content }),
    }
  }

  async #edit(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    const requestedPath = proposal.call.arguments.path
    const expectedSha256 = proposal.call.arguments.expectedSha256
    const oldText = proposal.call.arguments.oldText
    const newText = proposal.call.arguments.newText
    if (
      typeof requestedPath !== "string" ||
      requestedPath.trim().length === 0 ||
      typeof expectedSha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(expectedSha256) ||
      typeof oldText !== "string" ||
      oldText.length === 0 ||
      typeof newText !== "string"
    ) {
      return failure(
        proposal,
        "invalid_arguments",
        "edit_file requires path, a sha256 revision, non-empty oldText, and newText",
      )
    }
    if (oldText === newText) {
      return failure(proposal, "no_change", "oldText and newText must differ")
    }

    let file: ResolvedTextFile
    try {
      file = await resolveTextFile(
        this.#workspaceRoot,
        requestedPath,
        this.#maxFileBytes,
      )
    } catch (error) {
      return fileFailure(proposal, error)
    }
    if (file.sha256 !== expectedSha256.toLowerCase()) {
      return failure(
        proposal,
        "stale_revision",
        "File revision changed; read_file again before editing",
      )
    }

    const occurrences = countOccurrences(file.content, oldText)
    if (occurrences === 0) {
      return failure(proposal, "text_not_found", "oldText was not found")
    }
    if (occurrences > 1) {
      return failure(
        proposal,
        "ambiguous_match",
        "oldText occurs more than once; provide a more specific fragment",
      )
    }

    const nextContent = file.content.replace(oldText, newText)
    const nextBytes = Buffer.from(nextContent, "utf8")
    if (nextBytes.byteLength > this.#maxFileBytes) {
      return failure(
        proposal,
        "file_too_large",
        `Edited file exceeds ${this.#maxFileBytes} bytes`,
      )
    }
    const nextSha256 = sha256(nextBytes)
    const temporaryPath = `${file.targetRealPath}.harness-${randomUUID()}.tmp`
    try {
      if (signal.aborted) {
        throw signal.reason
      }
      await writeFile(temporaryPath, nextBytes, { mode: file.mode & 0o777 })
      await chmod(temporaryPath, file.mode & 0o777)
      if (signal.aborted) {
        throw signal.reason
      }
      await rename(temporaryPath, file.targetRealPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      if (signal.aborted) {
        throw signal.reason
      }
      return failure(proposal, "write_error", safeFileError(error, "Unable to edit file"))
    }

    const previous = this.#changes.get(file.relativePath)
    this.#changes.set(file.relativePath, {
      baselineContent: previous?.baselineContent ?? file.content,
      baselineSha256: previous?.baselineSha256 ?? file.sha256,
      currentContent: nextContent,
      currentSha256: nextSha256,
    })
    this.#successfulEdits += 1
    this.#lastEditSequence = ++this.#operationSequence
    return {
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: JSON.stringify({ path: file.relativePath, sha256: nextSha256 }),
      metadata: {
        path: file.relativePath,
        beforeSha256: file.sha256,
        afterSha256: nextSha256,
        bytes: nextBytes.byteLength,
      },
    }
  }

  async #runCheck(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    const script = proposal.call.arguments.script
    if (!isCodingCheckScript(script)) {
      return failure(
        proposal,
        "invalid_arguments",
        "run_check.script must be typecheck, test, or check",
      )
    }
    const result = await this.#scriptRunner.run(this.#workspaceRoot, script, signal)
    if (!result.ok) {
      return {
        toolCallId: proposal.call.toolCallId,
        toolName: proposal.call.name,
        ok: false,
        content: JSON.stringify(result),
        errorCode: result.timedOut ? "check_timeout" : "check_failed",
        metadata: checkMetadata(script, result),
      }
    }
    this.#lastSuccessfulCheckSequence = ++this.#operationSequence
    this.#lastSuccessfulCheck = script
    return {
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: JSON.stringify(result),
      metadata: checkMetadata(script, result),
    }
  }

  async #inspectChanges(
    proposal: ToolProposal,
    signal: AbortSignal,
  ): Promise<ToolObservation> {
    if (Object.keys(proposal.call.arguments).length > 0) {
      return failure(proposal, "invalid_arguments", "inspect_changes takes no arguments")
    }
    const changes: Array<Record<string, string>> = []
    for (const [path, record] of [...this.#changes.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (signal.aborted) {
        throw signal.reason
      }
      let current: ResolvedTextFile
      try {
        current = await resolveTextFile(this.#workspaceRoot, path, this.#maxFileBytes)
      } catch (error) {
        return fileFailure(proposal, error)
      }
      record.currentContent = current.content
      record.currentSha256 = current.sha256
      if (record.baselineSha256 === record.currentSha256) {
        continue
      }
      changes.push({
        path,
        beforeSha256: record.baselineSha256,
        afterSha256: record.currentSha256,
        diff: unifiedDiff(path, record.baselineContent, record.currentContent),
      })
    }
    this.#lastInspectionSequence = ++this.#operationSequence
    return {
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: JSON.stringify({ changedFiles: changes.length, changes }),
      metadata: { changedFiles: changes.length },
    }
  }
}

export class CodingPermissionPort implements PermissionPort {
  async evaluate(
    proposal: ToolProposal,
    _signal: AbortSignal,
  ): Promise<PermissionDecision> {
    if (codingToolDefinitions.some((tool) => tool.name === proposal.call.name)) {
      return { outcome: "allow" }
    }
    return {
      outcome: "deny",
      reason: `Tool is not allowed in Coding Agent Alpha: ${proposal.call.name}`,
    }
  }
}

export class PnpmScriptRunner implements ScriptRunner {
  readonly #timeoutMs: number
  readonly #maxOutputBytes: number

  constructor(
    timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_CHECK_OUTPUT_BYTES,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive integer")
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new TypeError("maxOutputBytes must be a positive integer")
    }
    this.#timeoutMs = timeoutMs
    this.#maxOutputBytes = maxOutputBytes
  }

  async run(
    workspaceRoot: string,
    script: CodingCheckScript,
    signal: AbortSignal,
  ): Promise<ScriptRunResult> {
    if (signal.aborted) {
      throw signal.reason
    }
    return new Promise<ScriptRunResult>((resolveResult, reject) => {
      let timedOut = false
      let truncated = false
      let settled = false
      let outputBytes = 0
      const output: Buffer[] = []
      const detached = process.platform !== "win32"
      const child = spawn(
        "pnpm",
        ["run", script],
        {
          cwd: workspaceRoot,
          detached,
          env: sanitizedProcessEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      )
      const terminate = (): void => {
        if (child.pid !== undefined && detached) {
          try {
            process.kill(-child.pid, "SIGTERM")
            return
          } catch {
            // Fall back to terminating the direct child.
          }
        }
        child.kill("SIGTERM")
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
      }
      const abort = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        terminate()
        reject(signal.reason)
      }
      const append = (chunk: Buffer): void => {
        if (settled || truncated) {
          return
        }
        const remaining = this.#maxOutputBytes - outputBytes
        if (chunk.byteLength <= remaining) {
          output.push(chunk)
          outputBytes += chunk.byteLength
          return
        }
        if (remaining > 0) {
          output.push(chunk.subarray(0, remaining))
          outputBytes += remaining
        }
        truncated = true
        terminate()
      }
      child.stdout.on("data", (chunk: Buffer) => append(chunk))
      child.stderr.on("data", (chunk: Buffer) => append(chunk))
      child.on("error", (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolveResult({
          ok: false,
          exitCode: null,
          output: safeProcessError(error),
          timedOut,
          truncated,
        })
      })
      child.on("close", (exitCode) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        const suffix = timedOut
          ? "\n...[check timed out]"
          : truncated
            ? "\n...[output truncated]"
            : ""
        resolveResult({
          ok: exitCode === 0 && !timedOut && !truncated,
          exitCode,
          output: Buffer.concat(output).toString("utf8") + suffix,
          timedOut,
          truncated,
        })
      })
      signal.addEventListener("abort", abort, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, this.#timeoutMs)
    })
  }
}

async function resolveTextFile(
  workspaceRoot: string,
  requestedPath: string,
  maxFileBytes: number,
): Promise<ResolvedTextFile> {
  const candidate = resolve(workspaceRoot, requestedPath)
  if (!isContained(workspaceRoot, candidate)) {
    throw new WorkspaceFileError("path_outside_workspace", "Path is outside the workspace")
  }
  let rootRealPath: string
  let targetRealPath: string
  try {
    ;[rootRealPath, targetRealPath] = await Promise.all([
      realpath(workspaceRoot),
      realpath(candidate),
    ])
  } catch (error) {
    throw new WorkspaceFileError("read_error", safeFileError(error, "Unable to read file"))
  }
  if (!isContained(rootRealPath, targetRealPath)) {
    throw new WorkspaceFileError(
      "path_outside_workspace",
      "Resolved path is outside the workspace",
    )
  }
  const fileStat = await stat(targetRealPath)
  if (!fileStat.isFile()) {
    throw new WorkspaceFileError("not_a_file", "Requested path is not a regular file")
  }
  if (fileStat.size > maxFileBytes) {
    throw new WorkspaceFileError("file_too_large", `File exceeds ${maxFileBytes} bytes`)
  }
  const bytes = await readFile(targetRealPath)
  if (bytes.byteLength > maxFileBytes) {
    throw new WorkspaceFileError("file_too_large", `File exceeds ${maxFileBytes} bytes`)
  }
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceFileError("not_utf8", "File is not valid UTF-8 text")
  }
  if (content.includes("\u0000")) {
    throw new WorkspaceFileError("binary_file", "File appears to be binary")
  }
  return {
    rootRealPath,
    targetRealPath,
    relativePath: relative(rootRealPath, targetRealPath),
    content,
    bytes,
    sha256: sha256(bytes),
    mode: fileStat.mode,
  }
}

class WorkspaceFileError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "WorkspaceFileError"
    this.code = code
  }
}

function fileFailure(proposal: ToolProposal, error: unknown): ToolObservation {
  if (error instanceof WorkspaceFileError) {
    return failure(proposal, error.code, error.message)
  }
  return failure(proposal, "file_error", "Unable to access file")
}

function failure(
  proposal: ToolProposal,
  errorCode: string,
  content: string,
): ToolObservation {
  return {
    toolCallId: proposal.call.toolCallId,
    toolName: proposal.call.name,
    ok: false,
    content,
    errorCode,
  }
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

function countOccurrences(content: string, search: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const index = content.indexOf(search, offset)
    if (index === -1) {
      return count
    }
    count += 1
    if (count > 1) {
      return count
    }
    offset = index + search.length
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function isCodingCheckScript(value: unknown): value is CodingCheckScript {
  return value === "typecheck" || value === "test" || value === "check"
}

function checkMetadata(script: CodingCheckScript, result: ScriptRunResult): JsonObject {
  return {
    script,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
  }
}

function safeFileError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") {
      return `${fallback} (${code})`
    }
  }
  return fallback
}

function safeProcessError(error: Error): string {
  if ("code" in error && typeof error.code === "string") {
    return `Unable to run validation (${error.code})`
  }
  return "Unable to run validation"
}

function capUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false }
  }
  return {
    text: bytes.subarray(0, maxBytes).toString("utf8") + "\n...[output truncated]",
    truncated: true,
  }
}

function sanitizedProcessEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL)/i.test(key)) {
      continue
    }
    result[key] = value
  }
  result.CI = "1"
  result.NO_COLOR = "1"
  return result
}

function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return ""
  }
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] ===
      afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1
  }
  const contextBefore = Math.min(3, prefix)
  const contextAfter = Math.min(3, suffix)
  const beforeStart = prefix - contextBefore
  const beforeChangedEnd = beforeLines.length - suffix
  const afterChangedEnd = afterLines.length - suffix
  const beforeEnd = beforeChangedEnd + contextAfter
  const afterEnd = afterChangedEnd + contextAfter
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${beforeStart + 1},${beforeEnd - beforeStart} +${beforeStart + 1},${afterEnd - beforeStart} @@`,
    ...beforeLines.slice(beforeStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, beforeChangedEnd).map((line) => `-${line}`),
    ...afterLines.slice(prefix, afterChangedEnd).map((line) => `+${line}`),
    ...beforeLines.slice(beforeChangedEnd, beforeEnd).map((line) => ` ${line}`),
  ]
  return capUtf8(lines.join("\n"), DEFAULT_MAX_CHECK_OUTPUT_BYTES).text
}
