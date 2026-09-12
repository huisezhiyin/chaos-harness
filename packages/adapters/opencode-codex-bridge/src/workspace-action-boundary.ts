import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ToolCall } from "../../../kernel/src/index.js"

export type WorkspaceBoundaryFailure = "outside_workspace" | "unresolved_path"
export interface WorkspaceBoundaryDiagnostic {
  reason: WorkspaceBoundaryFailure
  detail: "missing_path" | "invalid_path_type" | "empty_path" | "home_shorthand" | "null_byte" | "lexical_escape" | "symlink_escape" | "resolution_failed"
  pathKind: "absolute" | "relative" | "home" | "missing" | "invalid"
  pathField: string
}

const pathFields: Record<string, string> = {
  read: "filePath", write: "filePath", edit: "filePath",
  glob: "path", grep: "path", list: "path", bash: "workdir",
}

function contains(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

// Check existing ancestors too: an absent file under a symlink must not turn an
// outside-workspace operation into an apparently local write. No contents read.
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Unresolved symbolic link") }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError }
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(await physicalPath(parent), relative(parent, path))
  }
}

export async function checkWorkspaceAction(root: string, call: ToolCall): Promise<WorkspaceBoundaryFailure | undefined> {
  return (await diagnoseWorkspaceAction(root, call))?.reason
}

/** Only fixed enums/field names may leave this function; never persist the path. */
export async function diagnoseWorkspaceAction(root: string, call: ToolCall): Promise<WorkspaceBoundaryDiagnostic | undefined> {
  const field = Object.hasOwn(pathFields, call.name) ? pathFields[call.name] : undefined
  if (!field) return undefined // Host still owns all other tool permissions.
  const value = call.arguments[field]
  if (value === undefined && ["path", "workdir"].includes(field)) return undefined
  const pathKind = value === undefined ? "missing" : typeof value !== "string" ? "invalid"
    : value.startsWith("~") ? "home" : isAbsolute(value) ? "absolute" : "relative"
  const failure = (reason: WorkspaceBoundaryFailure, detail: WorkspaceBoundaryDiagnostic["detail"]): WorkspaceBoundaryDiagnostic => ({ reason, detail, pathKind, pathField: field })
  if (value === undefined) return failure("unresolved_path", "missing_path")
  if (typeof value !== "string") return failure("unresolved_path", "invalid_path_type")
  if (!value.trim()) return failure("unresolved_path", "empty_path")
  if (value.startsWith("~")) return failure("unresolved_path", "home_shorthand")
  if (value.includes("\0")) return failure("unresolved_path", "null_byte")
  const workspace = resolve(root), target = resolve(workspace, value)
  if (!contains(workspace, target)) return failure("outside_workspace", "lexical_escape")
  try {
    return contains(await realpath(workspace), await physicalPath(target)) ? undefined : failure("outside_workspace", "symlink_escape")
  } catch { return failure("unresolved_path", "resolution_failed") }
}

export function workspaceBoundaryGuidance(root: string, stopped: boolean, diagnostic?: WorkspaceBoundaryDiagnostic): string {
  return [
    "Workspace path preflight rejected this action. It was not sent to the Host and did not execute.",
    ...(diagnostic ? [`Reason: ${diagnostic.reason}/${diagnostic.detail}; expected path argument: ${diagnostic.pathField}; path form: ${diagnostic.pathKind}.`] : []),
    `The exact authorized workspace root is ${JSON.stringify(root)}.`,
    "Check for a misspelled directory. Propose a new action using a path relative to that root; use the root itself as bash workdir.",
    "Do not retry an external path or broaden permissions. Native permission decisions remain authoritative.",
    ...(stopped ? ["The workspace rejection limit was reached; this Attempt is stopping."] : []),
  ].join(" ")
}
