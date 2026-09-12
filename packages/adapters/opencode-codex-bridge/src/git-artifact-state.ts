import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readlink } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { DailyWorkspaceArtifactState } from "./daily-runtime.js"

const execFileAsync = promisify(execFile)
const MAX_STATUS_BYTES = 4 * 1024 * 1024
const MAX_DIFF_BYTES = 32 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024
const MAX_CHANGED_PATHS = 4_096

export class GitArtifactStateError extends Error {
  constructor(readonly reason: "unavailable" | "changed_path_limit" | "untracked_bytes_limit" = "unavailable") {
    super("Chaos Harness could not capture a bounded Git workspace artifact state")
    this.name = "GitArtifactStateError"
  }
}

export async function captureGitWorkspaceArtifactState(
  workspaceRoot: string,
): Promise<DailyWorkspaceArtifactState> {
  try {
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync(
        "git",
        ["-C", workspaceRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
        { encoding: "utf8", timeout: 5_000, maxBuffer: MAX_STATUS_BYTES },
      ),
      execFileAsync(
        "git",
        ["-C", workspaceRoot, "diff", "--binary", "--no-ext-diff", "HEAD", "--", "."],
        { encoding: "utf8", timeout: 10_000, maxBuffer: MAX_DIFF_BYTES },
      ),
    ])
    const parsed = parsePorcelainStatus(status)
    if (parsed.changedPathCount > MAX_CHANGED_PATHS) throw new GitArtifactStateError("changed_path_limit")

    const hash = createHash("sha256")
      .update("chaos.git-artifact-state.v1\0")
      .update(status)
      .update("\0tracked-diff\0")
      .update(diff)

    let untrackedBytes = 0
    for (const path of parsed.untrackedPaths.sort()) {
      const absolutePath = resolveWorkspacePath(workspaceRoot, path)
      const details = await lstat(absolutePath)
      hash.update("\0untracked-path\0").update(path).update("\0")
      if (details.isSymbolicLink()) {
        hash.update("symlink\0").update(await readlink(absolutePath))
        continue
      }
      if (!details.isFile()) throw new GitArtifactStateError()
      untrackedBytes += details.size
      if (untrackedBytes > MAX_UNTRACKED_BYTES) throw new GitArtifactStateError("untracked_bytes_limit")
      hash.update("file\0").update(await readFile(absolutePath))
    }

    return {
      available: true,
      digest: `sha256:${hash.digest("hex")}`,
      changedPathCount: parsed.changedPathCount,
    }
  } catch (error) {
    if (error instanceof GitArtifactStateError) throw error
    throw new GitArtifactStateError()
  }
}

function parsePorcelainStatus(status: string): {
  changedPathCount: number
  untrackedPaths: string[]
} {
  if (status.length === 0) return { changedPathCount: 0, untrackedPaths: [] }
  const records = status.split("\0")
  if (records.at(-1) !== "") throw new GitArtifactStateError()
  records.pop()
  const untrackedPaths: string[] = []
  let changedPathCount = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length < 4 || record[2] !== " ") {
      throw new GitArtifactStateError()
    }
    const statusCode = record.slice(0, 2)
    const path = record.slice(3)
    if (path.length === 0) throw new GitArtifactStateError()
    changedPathCount += 1
    if (statusCode === "??") untrackedPaths.push(path)
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const previousPath = records[index + 1]
      if (previousPath === undefined || previousPath.length === 0) throw new GitArtifactStateError()
      index += 1
    }
  }
  return { changedPathCount, untrackedPaths }
}

function resolveWorkspacePath(workspaceRoot: string, path: string): string {
  const absolutePath = resolve(workspaceRoot, path)
  const candidate = relative(workspaceRoot, absolutePath)
  if (
    candidate.length === 0 ||
    candidate === ".." ||
    candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(candidate)
  ) {
    throw new GitArtifactStateError()
  }
  return absolutePath
}
