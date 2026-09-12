import type { AttemptRef } from "../contracts/contracts.js"
import type { JsonObject } from "../loop/contracts.js"

export const hostCapabilities = [
  "model_loop",
  "workspace_read",
  "workspace_mutation",
  "process_execution",
  "artifact_diff",
  "abort",
  "realtime_observation",
  "checkpoint_steer",
  "checkpoint_completion",
  "permission_interception",
] as const

export type HostCapability = (typeof hostCapabilities)[number]

export interface HostModelSelection {
  provider: string
  model: string
}

export interface HostAttemptRequest {
  attempt: AttemptRef
  workspaceRoot: string
  prompt: string
  systemPrompt?: string
  model?: HostModelSelection
  timeoutMs?: number
}

export type HostActionKind = "read" | "mutation" | "execute" | "other"
export type HostActionStatus = "completed" | "failed"

export interface HostActionObservation {
  sequence: number
  actionId: string
  name: string
  kind: HostActionKind
  status: HostActionStatus
  input: JsonObject
  exitCode?: number | null
  title?: string
  output?: string
  error?: string
}

export interface HostArtifactChange {
  path: string
  additions?: number
  deletions?: number
}

export interface HostAttemptUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface HostRuntimeIdentity {
  profile: string
  cliVersion?: string
  backendSessionId?: string
  backendRunId?: string
}

export type HostAttemptEvent =
  | { sequence: number; type: "turn_started" | "turn_finished"; turn: number }
  | { sequence: number; type: "text_delta"; delta: string }
  | {
      sequence: number
      type: "action_state"
      actionId: string
      name: string
      kind: HostActionKind
      status: "pending" | "running" | "completed" | "failed"
      input: JsonObject
      error?: string
    }
  | {
      sequence: number
      type: "permission_requested"
      permission: string
      title: string
    }
  | { sequence: number; type: "artifact_changed"; path: string }
  | { sequence: number; type: "host_error"; message: string }

export type HostFailureKind =
  | "configuration"
  | "startup"
  | "transport"
  | "provider"
  | "protocol"
  | "timeout"
  | "aborted"
  | "overloaded"
  | "unknown"

export interface HostFailure {
  kind: HostFailureKind
  message: string
  retryable: boolean
}

interface HostAttemptResultBase {
  attemptId: AttemptRef["attemptId"]
  runtime: HostRuntimeIdentity
  actions: readonly HostActionObservation[]
  artifacts: readonly HostArtifactChange[]
  usage: HostAttemptUsage
  events: readonly HostAttemptEvent[]
}

export type HostAttemptResult =
  | (HostAttemptResultBase & {
      status: "completion_proposed"
      completion: string
    })
  | (HostAttemptResultBase & {
      status: "failed" | "aborted"
      failure: HostFailure
    })

export const emptyHostAttemptUsage = (): HostAttemptUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
})
