import type { AttemptId } from "../contracts/ids.js"
import type {
  AttemptControl,
  AttemptControlBoundary,
  AttemptStopReason,
  ModelDecision,
  ModelStreamEvent,
  ModelUsage,
  PermissionDecision,
  ToolObservation,
  ToolProposal,
} from "./contracts.js"

interface AttemptEngineEventBase {
  sequence: number
  attemptId: AttemptId
}

export type AttemptEngineEvent =
  | (AttemptEngineEventBase & { type: "attempt_started" })
  | (AttemptEngineEventBase & {
      type: "control_processed"
      control: AttemptControl
      boundary: AttemptControlBoundary
      turn: number | null
      outcome: "applied" | "ignored"
      reason: string | null
    })
  | (AttemptEngineEventBase & { type: "turn_started"; turn: number })
  | (AttemptEngineEventBase & { type: "model_length_recovery_started"; turn: number; usage: ModelUsage })
  | (AttemptEngineEventBase & {
      type: "model_stream_event"
      turn: number
      event: ModelStreamEvent
    })
  | (AttemptEngineEventBase & {
      type: "model_decision"
      turn: number
      decision: ModelDecision
    })
  | (AttemptEngineEventBase & {
      type: "tool_proposed"
      proposal: ToolProposal
    })
  | (AttemptEngineEventBase & {
      type: "permission_evaluated"
      proposal: ToolProposal
      decision: PermissionDecision
    })
  | (AttemptEngineEventBase & {
      type: "tool_started"
      proposal: ToolProposal
    })
  | (AttemptEngineEventBase & {
      type: "tool_observed"
      proposal: ToolProposal
      observation: ToolObservation
    })
  | (AttemptEngineEventBase & {
      type: "turn_completed"
      turn: number
      usage: ModelUsage
    })
  | (AttemptEngineEventBase & {
      type: "completion_proposed"
      turn: number
      content: string
    })
  | (AttemptEngineEventBase & {
      type: "budget_reached"
      budget: "turns" | "actions"
      limit: number
      consumed: number
      action: "finalize" | "evidence_closure"
    })
  | (AttemptEngineEventBase & {
      type: "evidence_closure_started"
      trigger: "turns" | "actions" | "completion" | "deadline"
      workTurns: number
      workActions: number
    })
  | (AttemptEngineEventBase & {
      type: "budget_exceeded"
      scope?: "unit"
      budget: "turns" | "actions" | "cost"
      limit: number
      consumed: number
    })
  | (AttemptEngineEventBase & {
      type: "attempt_stopped"
      reason: AttemptStopReason
    })
  | (AttemptEngineEventBase & {
      type: "attempt_completed"
      outcome: "completion_proposed"
    })
