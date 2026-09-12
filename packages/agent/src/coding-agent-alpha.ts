import { randomUUID } from "node:crypto"
import {
  NativeAttemptEngine,
  ids,
  type AttemptRunOptions,
  type AttemptRunResult,
  type LoopBudget,
  type ModelPort,
} from "../../kernel/src/index.js"
import {
  CodingPermissionPort,
  WorkspaceCodingToolPort,
  codingToolDefinitions,
  type CodingEvidenceSnapshot,
  type WorkspaceCodingToolPortOptions,
} from "./workspace-coding-tool-port.js"

const defaultBudget: LoopBudget = {
  maxTurns: 12,
  maxActions: 16,
}

const defaultSystemPrompt = [
  "You are the first-party Chaos Harness Coding Agent Alpha.",
  "Work only inside the configured workspace and keep changes narrowly scoped to the user's task.",
  "Before editing, use read_file and pass its sha256 to edit_file as expectedSha256.",
  "edit_file only replaces one unique fragment in an existing text file; read again after a stale revision.",
  "After the final edit, run one allowed validation with run_check, then call inspect_changes.",
  "Do not propose completion until the change is implemented, validation passes, and changes are inspected.",
  "Never claim success when a tool observation failed.",
].join("\n")

export type CodingEvidenceGap =
  | "no_successful_edit"
  | "no_changed_file"
  | "validation_missing_after_edit"
  | "change_inspection_missing_after_edit"

export interface CodingAgentAlphaOptions {
  model: ModelPort
  workspaceRoot: string
  prompt: string
  systemPrompt?: string
  budget?: LoopBudget
  runOptions?: AttemptRunOptions
  toolOptions?: WorkspaceCodingToolPortOptions
}

export interface CodingAgentRunResult {
  outcome: "completion_accepted" | "evidence_rejected" | "attempt_stopped"
  attempt: AttemptRunResult
  evidence: CodingEvidenceSnapshot
  gaps: readonly CodingEvidenceGap[]
}

export async function runCodingAgentAlpha(
  options: CodingAgentAlphaOptions,
): Promise<CodingAgentRunResult> {
  if (options.prompt.trim().length === 0) {
    throw new TypeError("Agent prompt must not be empty")
  }

  const tools = new WorkspaceCodingToolPort(options.workspaceRoot, options.toolOptions)
  const permissions = new CodingPermissionPort()
  const engine = new NativeAttemptEngine({ model: options.model, tools, permissions })
  const runId = randomUUID()
  const attempt = await engine.run(
    {
      attempt: {
        attemptId: ids.attempt(`coding-attempt-${runId}`),
        unitId: ids.unit(`coding-unit-${runId}`),
        unitRevision: 1,
        projectionId: ids.projection(`coding-projection-${runId}`),
      },
      messages: [
        { role: "system", content: options.systemPrompt ?? defaultSystemPrompt },
        { role: "user", content: options.prompt },
      ],
      tools: codingToolDefinitions,
      budget: options.budget ?? defaultBudget,
    },
    options.runOptions,
  )
  const evidence = tools.snapshotEvidence()
  if (attempt.status !== "completion_proposed") {
    return { outcome: "attempt_stopped", attempt, evidence, gaps: [] }
  }

  const gaps = evidenceGaps(evidence)
  return {
    outcome: gaps.length === 0 ? "completion_accepted" : "evidence_rejected",
    attempt,
    evidence,
    gaps,
  }
}

function evidenceGaps(evidence: CodingEvidenceSnapshot): CodingEvidenceGap[] {
  const gaps: CodingEvidenceGap[] = []
  if (evidence.successfulEdits === 0) {
    gaps.push("no_successful_edit")
  }
  if (evidence.changedFiles.length === 0) {
    gaps.push("no_changed_file")
  }
  if (
    evidence.lastEditSequence === 0 ||
    evidence.lastSuccessfulCheckSequence < evidence.lastEditSequence
  ) {
    gaps.push("validation_missing_after_edit")
  }
  if (
    evidence.lastEditSequence === 0 ||
    evidence.lastInspectionSequence < evidence.lastEditSequence
  ) {
    gaps.push("change_inspection_missing_after_edit")
  }
  return gaps
}
