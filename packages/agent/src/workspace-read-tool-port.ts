import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type {
  PermissionDecision,
  PermissionPort,
  ToolDefinition,
  ToolObservation,
  ToolPort,
  ToolProposal,
} from "../../kernel/src/index.js"

const DEFAULT_MAX_FILE_BYTES = 256 * 1024

export const workspaceReadToolDefinition: ToolDefinition = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the configured workspace root.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative file path",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
}

export class WorkspaceReadToolPort implements ToolPort {
  readonly #workspaceRoot: string
  readonly #maxFileBytes: number

  constructor(workspaceRoot: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    this.#workspaceRoot = resolve(workspaceRoot)
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new TypeError("maxFileBytes must be a positive integer")
    }
    this.#maxFileBytes = maxFileBytes
  }

  async execute(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    if (signal.aborted) {
      throw signal.reason
    }
    if (proposal.call.name !== workspaceReadToolDefinition.name) {
      return failure(proposal, "unsupported_tool", `Unsupported tool: ${proposal.call.name}`)
    }

    const requestedPath = proposal.call.arguments.path
    if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
      return failure(proposal, "invalid_arguments", "read_file.path must be a non-empty string")
    }

    const candidate = resolve(this.#workspaceRoot, requestedPath)
    if (!isContained(this.#workspaceRoot, candidate)) {
      return failure(proposal, "path_outside_workspace", "Path is outside the workspace")
    }

    try {
      const [rootRealPath, targetRealPath] = await Promise.all([
        realpath(this.#workspaceRoot),
        realpath(candidate),
      ])
      if (!isContained(rootRealPath, targetRealPath)) {
        return failure(
          proposal,
          "path_outside_workspace",
          "Resolved path is outside the workspace",
        )
      }

      const fileStat = await stat(targetRealPath)
      if (!fileStat.isFile()) {
        return failure(proposal, "not_a_file", "Requested path is not a regular file")
      }
      if (fileStat.size > this.#maxFileBytes) {
        return failure(
          proposal,
          "file_too_large",
          `File exceeds ${this.#maxFileBytes} bytes`,
        )
      }

      const bytes = await readFile(targetRealPath)
      if (signal.aborted) {
        throw signal.reason
      }
      if (bytes.byteLength > this.#maxFileBytes) {
        return failure(
          proposal,
          "file_too_large",
          `File exceeds ${this.#maxFileBytes} bytes`,
        )
      }

      let content: string
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        return failure(proposal, "not_utf8", "File is not valid UTF-8 text")
      }
      if (content.includes("\u0000")) {
        return failure(proposal, "binary_file", "File appears to be binary")
      }

      return {
        toolCallId: proposal.call.toolCallId,
        toolName: proposal.call.name,
        ok: true,
        content,
        metadata: {
          path: relative(rootRealPath, targetRealPath),
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason
      }
      return failure(proposal, "read_error", safeErrorMessage(error))
    }
  }
}

export class ReadOnlyPermissionPort implements PermissionPort {
  async evaluate(
    proposal: ToolProposal,
    _signal: AbortSignal,
  ): Promise<PermissionDecision> {
    if (proposal.call.name === workspaceReadToolDefinition.name) {
      return { outcome: "allow" }
    }
    return {
      outcome: "deny",
      reason: `Tool is not allowed in read-only Agent Alpha: ${proposal.call.name}`,
    }
  }
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
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

function safeErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") {
      return `Unable to read file (${code})`
    }
  }
  return "Unable to read file"
}
