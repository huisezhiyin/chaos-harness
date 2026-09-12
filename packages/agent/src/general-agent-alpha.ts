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
  ReadOnlyPermissionPort,
  WorkspaceReadToolPort,
  workspaceReadToolDefinition,
} from "./workspace-read-tool-port.js"

const defaultBudget: LoopBudget = {
  maxTurns: 8,
  maxActions: 8,
}

const defaultSystemPrompt = [
  "You are the first-party Chaos Harness General Agent Alpha.",
  "Use read_file whenever the answer depends on workspace file contents.",
  "Never claim that you inspected a file unless a successful tool observation proves it.",
  "Stay within the user's requested scope and give a concise final answer.",
].join("\n")

export interface GeneralAgentAlphaOptions {
  model: ModelPort
  workspaceRoot: string
  prompt: string
  systemPrompt?: string
  budget?: LoopBudget
  runOptions?: AttemptRunOptions
}

export async function runGeneralAgentAlpha(
  options: GeneralAgentAlphaOptions,
): Promise<AttemptRunResult> {
  if (options.prompt.trim().length === 0) {
    throw new TypeError("Agent prompt must not be empty")
  }

  const tools = new WorkspaceReadToolPort(options.workspaceRoot)
  const permissions = new ReadOnlyPermissionPort()
  const engine = new NativeAttemptEngine({ model: options.model, tools, permissions })
  const runId = randomUUID()

  return engine.run(
    {
      attempt: {
        attemptId: ids.attempt(`agent-attempt-${runId}`),
        unitId: ids.unit(`agent-unit-${runId}`),
        unitRevision: 1,
        projectionId: ids.projection(`agent-projection-${runId}`),
      },
      messages: [
        { role: "system", content: options.systemPrompt ?? defaultSystemPrompt },
        { role: "user", content: options.prompt },
      ],
      tools: [workspaceReadToolDefinition],
      budget: options.budget ?? defaultBudget,
    },
    options.runOptions,
  )
}
