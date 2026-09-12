import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ids, type JsonObject, type ToolProposal } from "../../kernel/src/index.js"
import {
  PnpmScriptRunner,
  WorkspaceCodingToolPort,
  type CodingCheckScript,
  type ScriptRunResult,
  type ScriptRunner,
} from "../src/index.js"

const temporaryRoots: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("WorkspaceCodingToolPort", () => {
  it("runs guarded edit -> check -> change inspection with evidence revisions", async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, "math.ts"), "export const answer = 41\n", "utf8")
    const runner = new FakeScriptRunner({
      ok: true,
      exitCode: 0,
      output: "tests passed",
      timedOut: false,
      truncated: false,
    })
    const port = new WorkspaceCodingToolPort(root, { scriptRunner: runner })

    const read = await port.execute(tool("read_file", { path: "math.ts" }), signal)
    expect(read.ok).toBe(true)
    const document = JSON.parse(read.content) as {
      path: string
      sha256: string
      content: string
    }
    expect(document).toMatchObject({
      path: "math.ts",
      content: "export const answer = 41\n",
    })
    expect(document.sha256).toMatch(/^[a-f0-9]{64}$/)

    const edit = await port.execute(
      tool("edit_file", {
        path: "math.ts",
        expectedSha256: document.sha256,
        oldText: "answer = 41",
        newText: "answer = 42",
      }),
      signal,
    )
    expect(edit).toMatchObject({ ok: true, metadata: { path: "math.ts" } })
    expect(await readFile(join(root, "math.ts"), "utf8")).toBe(
      "export const answer = 42\n",
    )

    const check = await port.execute(tool("run_check", { script: "test" }), signal)
    expect(check).toMatchObject({ ok: true })
    expect(runner.calls).toEqual([{ workspaceRoot: root, script: "test" }])

    const inspection = await port.execute(tool("inspect_changes", {}), signal)
    expect(inspection.ok).toBe(true)
    const changeSet = JSON.parse(inspection.content) as {
      changedFiles: number
      changes: Array<{ path: string; diff: string }>
    }
    expect(changeSet.changedFiles).toBe(1)
    expect(changeSet.changes[0]).toMatchObject({ path: "math.ts" })
    expect(changeSet.changes[0]?.diff).toContain("-export const answer = 41")
    expect(changeSet.changes[0]?.diff).toContain("+export const answer = 42")

    const evidence = port.snapshotEvidence()
    expect(evidence).toMatchObject({
      successfulEdits: 1,
      changedFiles: ["math.ts"],
      lastSuccessfulCheck: "test",
    })
    expect(evidence.lastSuccessfulCheckSequence).toBeGreaterThan(
      evidence.lastEditSequence,
    )
    expect(evidence.lastInspectionSequence).toBeGreaterThan(evidence.lastEditSequence)
  })

  it("rejects a stale revision without writing", async () => {
    const root = await temporaryRoot()
    const path = join(root, "note.txt")
    await writeFile(path, "before", "utf8")
    const port = new WorkspaceCodingToolPort(root, {
      scriptRunner: successfulRunner(),
    })

    const result = await port.execute(
      tool("edit_file", {
        path: "note.txt",
        expectedSha256: "0".repeat(64),
        oldText: "before",
        newText: "after",
      }),
      signal,
    )

    expect(result).toMatchObject({ ok: false, errorCode: "stale_revision" })
    expect(await readFile(path, "utf8")).toBe("before")
  })

  it("rejects ambiguous replacement without writing", async () => {
    const root = await temporaryRoot()
    const path = join(root, "note.txt")
    await writeFile(path, "same same", "utf8")
    const port = new WorkspaceCodingToolPort(root, {
      scriptRunner: successfulRunner(),
    })
    const read = await port.execute(tool("read_file", { path: "note.txt" }), signal)
    const revision = (JSON.parse(read.content) as { sha256: string }).sha256

    const result = await port.execute(
      tool("edit_file", {
        path: "note.txt",
        expectedSha256: revision,
        oldText: "same",
        newText: "changed",
      }),
      signal,
    )

    expect(result).toMatchObject({ ok: false, errorCode: "ambiguous_match" })
    expect(await readFile(path, "utf8")).toBe("same same")
  })

  it("rejects edit through a symlink that escapes the workspace", async () => {
    const parent = await temporaryRoot()
    const root = join(parent, "workspace")
    await mkdir(root)
    const outside = join(parent, "outside.txt")
    await writeFile(outside, "outside", "utf8")
    await symlink(outside, join(root, "escape.txt"))
    const port = new WorkspaceCodingToolPort(root, {
      scriptRunner: successfulRunner(),
    })

    const result = await port.execute(
      tool("edit_file", {
        path: "escape.txt",
        expectedSha256: "0".repeat(64),
        oldText: "outside",
        newText: "changed",
      }),
      signal,
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: "path_outside_workspace",
    })
    expect(await readFile(outside, "utf8")).toBe("outside")
  })

  it("rejects lexical edit traversal outside the workspace", async () => {
    const parent = await temporaryRoot()
    const root = join(parent, "workspace")
    await mkdir(root)
    const outside = join(parent, "outside.txt")
    await writeFile(outside, "outside", "utf8")
    const port = new WorkspaceCodingToolPort(root, {
      scriptRunner: successfulRunner(),
    })

    const result = await port.execute(
      tool("edit_file", {
        path: "../outside.txt",
        expectedSha256: "0".repeat(64),
        oldText: "outside",
        newText: "changed",
      }),
      signal,
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: "path_outside_workspace",
    })
    expect(await readFile(outside, "utf8")).toBe("outside")
  })

  it("allows only fixed validation script names", async () => {
    const root = await temporaryRoot()
    const runner = successfulRunner()
    const port = new WorkspaceCodingToolPort(root, { scriptRunner: runner })

    const result = await port.execute(
      tool("run_check", { script: "deploy" }),
      signal,
    )

    expect(result).toMatchObject({ ok: false, errorCode: "invalid_arguments" })
    expect(runner.calls).toHaveLength(0)
  })

  it("runs an allowed package script without a shell", async () => {
    const root = await temporaryRoot()
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "coding-fixture",
        private: true,
        scripts: { test: "node -e \"process.stdout.write('green')\"" },
      }),
    )
    const runner = new PnpmScriptRunner(10_000, 4_096)

    const result = await runner.run(root, "test", signal)

    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false })
    expect(result.output).toContain("green")
  })

  it("terminates and bounds excessive validation output", async () => {
    const root = await temporaryRoot()
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "coding-output-fixture",
        private: true,
        scripts: { test: "node -e \"process.stdout.write('x'.repeat(10000))\"" },
      }),
    )
    const runner = new PnpmScriptRunner(10_000, 512)

    const result = await runner.run(root, "test", signal)

    expect(result.ok).toBe(false)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(600)
  })

  it("terminates a validation process tree at the timeout", async () => {
    const root = await temporaryRoot()
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "coding-timeout-fixture",
        private: true,
        scripts: { test: "node -e \"setTimeout(() => {}, 5000)\"" },
      }),
    )
    const runner = new PnpmScriptRunner(100, 4_096)
    const startedAt = Date.now()

    const result = await runner.run(root, "test", signal)

    expect(result).toMatchObject({ ok: false, timedOut: true })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})

class FakeScriptRunner implements ScriptRunner {
  readonly calls: Array<{ workspaceRoot: string; script: CodingCheckScript }> = []
  readonly #result: ScriptRunResult

  constructor(result: ScriptRunResult) {
    this.#result = result
  }

  async run(
    workspaceRoot: string,
    script: CodingCheckScript,
    _signal: AbortSignal,
  ): Promise<ScriptRunResult> {
    this.calls.push({ workspaceRoot, script })
    return this.#result
  }
}

function successfulRunner(): FakeScriptRunner {
  return new FakeScriptRunner({
    ok: true,
    exitCode: 0,
    output: "ok",
    timedOut: false,
    truncated: false,
  })
}

function tool(name: string, arguments_: JsonObject): ToolProposal {
  return {
    attemptId: ids.attempt("coding-attempt-1"),
    turn: 1,
    call: {
      toolCallId: `call-${name}`,
      name,
      arguments: arguments_,
    },
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chaos-harness-coding-"))
  temporaryRoots.push(root)
  return root
}
