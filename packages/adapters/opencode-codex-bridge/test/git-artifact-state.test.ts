import { execFile } from "node:child_process"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  captureGitWorkspaceArtifactState,
  GitArtifactStateError,
} from "../src/git-artifact-state.js"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe("captureGitWorkspaceArtifactState", () => {
  it("reports the bounded untracked-size failure without reading oversized content", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-artifact-size-"))
    temporaryDirectories.push(root)
    await git(root, "init")
    await git(root, "-c", "user.email=chaos@example.invalid", "-c", "user.name=Chaos", "commit", "--allow-empty", "-m", "baseline")
    const path = join(root, "large-untracked")
    await writeFile(path, "")
    await truncate(path, 33 * 1024 * 1024)
    await expect(captureGitWorkspaceArtifactState(root)).rejects.toMatchObject({ reason: "untracked_bytes_limit" })
  })

  it("binds tracked and untracked content while treating a restored tree as the same state", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-artifact-state-"))
    temporaryDirectories.push(root)
    await git(root, "init")
    await git(root, "config", "user.email", "chaos@example.invalid")
    await git(root, "config", "user.name", "Chaos Harness")
    await writeFile(join(root, "tracked.txt"), "baseline\n")
    await git(root, "add", "tracked.txt")
    await git(root, "commit", "-m", "baseline")

    const baseline = await captureGitWorkspaceArtifactState(root)
    expect(baseline).toMatchObject({ available: true, changedPathCount: 0 })
    expectAvailable(baseline)

    await writeFile(join(root, "tracked.txt"), "first change\n")
    const firstChange = await captureGitWorkspaceArtifactState(root)
    expect(firstChange).toMatchObject({ available: true, changedPathCount: 1 })
    expectAvailable(firstChange)
    expect(firstChange.digest).not.toBe(baseline.digest)

    await writeFile(join(root, "tracked.txt"), "second change\n")
    const secondChange = await captureGitWorkspaceArtifactState(root)
    expectAvailable(secondChange)
    expect(secondChange.digest).not.toBe(firstChange.digest)

    await writeFile(join(root, "tracked.txt"), "baseline\n")
    const restored = await captureGitWorkspaceArtifactState(root)
    expect(restored).toEqual(baseline)

    await writeFile(join(root, "new.txt"), "untracked content\n")
    const untracked = await captureGitWorkspaceArtifactState(root)
    expect(untracked).toMatchObject({ available: true, changedPathCount: 1 })
    expectAvailable(untracked)
    expect(untracked.digest).not.toBe(baseline.digest)
  })

  it("fails with a sanitized error when the root is not a Git worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-artifact-state-invalid-"))
    temporaryDirectories.push(root)

    await expect(captureGitWorkspaceArtifactState(root)).rejects.toEqual(
      expect.objectContaining({
        name: GitArtifactStateError.name,
        message: "Chaos Harness could not capture a bounded Git workspace artifact state",
      }),
    )
  })
})

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  })
}

function expectAvailable(
  state: Awaited<ReturnType<typeof captureGitWorkspaceArtifactState>>,
): asserts state is Extract<Awaited<ReturnType<typeof captureGitWorkspaceArtifactState>>, { available: true }> {
  expect(state.available).toBe(true)
}
