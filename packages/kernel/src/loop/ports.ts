import type {
  AttemptBoundaryControl,
  AttemptCancelControl,
  ModelRequest,
  ModelStreamEvent,
  PermissionDecision,
  ToolObservation,
  ToolProposal,
} from "./contracts.js"

export interface AttemptControlPort {
  readonly signal: AbortSignal
  readonly cancellation: AttemptCancelControl | undefined
  drain(): readonly AttemptBoundaryControl[]
}

export interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>
}

export interface ToolPort {
  execute(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation>
}

export interface PermissionPort {
  evaluate(proposal: ToolProposal, signal: AbortSignal): Promise<PermissionDecision>
}
