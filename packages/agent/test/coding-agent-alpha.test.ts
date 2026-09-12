import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { JsonObject, ModelStreamEvent } from "../../kernel/src/index.js"
import { ScriptedModelPort } from "../../kernel/test/loop/fakes.js"
import {
  runCodingAgentAlpha,
  type CodingCheckScript,
  type ScriptRunResult,
  type ScriptRunner,
} from "../src/index.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("CodingAgentAlpha", () => {
  it("accepts completion only after edit, successful check, and inspection", async () => {
    const root = await fixture("export const answer = 41\n")
    const revision = hash("export const answer = 41\n")
    const model = new ScriptedModelPort([
      toolDecision("read-1", "read_file", { path: "answer.ts" }),
      toolDecision("edit-1", "edit_file", {
        path: "answer.ts",
        expectedSha256: revision,
        oldText: "answer = 41",
        newText: "answer = 42",
      }),
      toolDecision("check-1", "run_check", { script: "test" }),
      toolDecision("inspect-1", "inspect_changes", {}),
      finalDecision("Fixed and verified."),
    ])

    const result = await runCodingAgentAlpha({
      model,
      workspaceRoot: root,
      prompt: "Fix the answer and verify it.",
      toolOptions: { scriptRunner: successfulRunner() },
    })

    expect(result).toMatchObject({
      outcome: "completion_accepted",
      gaps: [],
      evidence: {
        successfulEdits: 1,
        changedFiles: ["answer.ts"],
        lastSuccessfulCheck: "test",
      },
      attempt: { status: "completion_proposed", usage: { turns: 5, actions: 4 } },
    })
    expect(await readFile(join(root, "answer.ts"), "utf8")).toBe(
      "export const answer = 42\n",
    )
  })

  it("rejects a model final that skips validation and change inspection", async () => {
    const root = await fixture("export const answer = 41\n")
    const model = new ScriptedModelPort([
      toolDecision("read-1", "read_file", { path: "answer.ts" }),
      toolDecision("edit-1", "edit_file", {
        path: "answer.ts",
        expectedSha256: hash("export const answer = 41\n"),
        oldText: "answer = 41",
        newText: "answer = 42",
      }),
      finalDecision("Done."),
    ])

    const result = await runCodingAgentAlpha({
      model,
      workspaceRoot: root,
      prompt: "Fix the answer.",
      toolOptions: { scriptRunner: successfulRunner() },
    })

    expect(result.outcome).toBe("evidence_rejected")
    expect(result.gaps).toEqual([
      "validation_missing_after_edit",
      "change_inspection_missing_after_edit",
    ])
    expect(result.attempt.status).toBe("completion_proposed")
  })
})

function toolDecision(
  toolCallId: string,
  name: string,
  arguments_: JsonObject,
): ModelStreamEvent[] {
  return [
    {
      type: "tool_call",
      call: { toolCallId, name, arguments: arguments_ },
    },
    usage(),
    { type: "finish", reason: "tool_calls" },
  ]
}

function finalDecision(text: string): ModelStreamEvent[] {
  return [
    { type: "text_delta", delta: text },
    usage(),
    { type: "finish", reason: "stop" },
  ]
}

function usage(): ModelStreamEvent {
  return {
    type: "usage",
    usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
  }
}

function successfulRunner(): ScriptRunner {
  return {
    async run(
      _workspaceRoot: string,
      _script: CodingCheckScript,
      _signal: AbortSignal,
    ): Promise<ScriptRunResult> {
      return {
        ok: true,
        exitCode: 0,
        output: "tests passed",
        timedOut: false,
        truncated: false,
      }
    },
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

async function fixture(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-coding-agent-"))
  temporaryRoots.push(root)
  await writeFile(join(root, "answer.ts"), content, "utf8")
  return root
}
