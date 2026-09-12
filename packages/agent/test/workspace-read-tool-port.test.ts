import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ids, type ToolProposal } from "../../kernel/src/index.js"
import { WorkspaceReadToolPort } from "../src/index.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("WorkspaceReadToolPort", () => {
  it("reads UTF-8 files inside the workspace", async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, "note.txt"), "trusted contents", "utf8")
    const port = new WorkspaceReadToolPort(root)

    const result = await port.execute(
      proposal("note.txt"),
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      content: "trusted contents",
      metadata: {
        path: "note.txt",
        bytes: 16,
      },
    })
    expect(result.metadata?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("rejects lexical traversal outside the workspace", async () => {
    const parent = await temporaryRoot()
    const root = join(parent, "workspace")
    await mkdir(root)
    await writeFile(join(parent, "secret.txt"), "secret", "utf8")
    const port = new WorkspaceReadToolPort(root)

    const result = await port.execute(
      proposal("../secret.txt"),
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: "path_outside_workspace",
    })
    expect(result.content).not.toContain("secret")
  })

  it("rejects symlinks that resolve outside the workspace", async () => {
    const parent = await temporaryRoot()
    const root = join(parent, "workspace")
    await mkdir(root)
    const outside = join(parent, "outside.txt")
    await writeFile(outside, "outside secret", "utf8")
    await symlink(outside, join(root, "escape.txt"))
    const port = new WorkspaceReadToolPort(root)

    const result = await port.execute(
      proposal("escape.txt"),
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: "path_outside_workspace",
    })
    expect(result.content).not.toContain("outside secret")
  })
})

function proposal(path: string): ToolProposal {
  return {
    attemptId: ids.attempt("attempt-1"),
    turn: 1,
    call: {
      toolCallId: "call-1",
      name: "read_file",
      arguments: { path },
    },
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chaos-harness-agent-"))
  temporaryRoots.push(root)
  return root
}
