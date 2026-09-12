import type { AttemptRef } from "../contracts/contracts.js"
import type { AttemptControlId, AttemptId } from "../contracts/ids.js"
import type { AttemptEngineEvent } from "./events.js"

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface ToolCall {
  toolCallId: string
  name: string
  arguments: JsonObject
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "control"; content: string; controlId: AttemptControlId }
  | { role: "assistant"; content: string; reasoning?: string; toolCalls?: ToolCall[] }
  | {
      role: "tool"
      content: string
      toolCallId: string
      toolName: string
      ok: boolean
    }

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  /** Input tokens served from a provider-side prompt/context cache. Included in inputTokens. */
  cacheReadTokens?: number
  /** Input tokens used to create a provider-side explicit cache. Included in inputTokens. */
  cacheWriteTokens?: number
  cost: number
}

export type ModelFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"

export type ModelStreamEvent =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "finish"; reason: ModelFinishReason }

interface ModelDecisionBase {
  reasoning: string
  text: string
  usage: ModelUsage
  finishReason: ModelFinishReason
}

export type ModelDecision =
  | (ModelDecisionBase & { kind: "final"; finishReason: "stop" })
  | (ModelDecisionBase & {
      kind: "tool_calls"
      finishReason: "tool_calls"
      toolCalls: ToolCall[]
    })
  | (ModelDecisionBase & {
      kind: "incomplete"
      finishReason: "length" | "content_filter" | "error"
    })

export interface ModelRequest {
  attemptId: AttemptId
  turn: number
  messages: readonly ModelMessage[]
  tools: readonly ToolDefinition[]
}

export interface ToolProposal {
  attemptId: AttemptId
  turn: number
  call: ToolCall
}

export interface ToolObservation {
  toolCallId: string
  toolName: string
  ok: boolean
  content: string
  errorCode?: string
  metadata?: JsonObject
}

export type PermissionDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }

export interface LoopBudget {
  maxTurns?: number
  maxActions?: number
  maxCost?: number
  evidenceClosure?: {
    maxTurns: number
    maxActions: number
    allowedToolNames: readonly string[]
  }
}

export interface AttemptRequest {
  attempt: AttemptRef
  messages: readonly ModelMessage[]
  tools: readonly ToolDefinition[]
  budget: LoopBudget
}

export interface AttemptUsage {
  turns: number
  actions: number
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost: number
}

export interface AttemptSteerControl {
  readonly controlId: AttemptControlId
  readonly kind: "steer"
  readonly content: string
}

export interface AttemptStopAfterTurnControl {
  readonly controlId: AttemptControlId
  readonly kind: "stop_after_turn"
  readonly reason: string
}

export interface AttemptCancelControl {
  readonly controlId: AttemptControlId
  readonly kind: "cancel"
  readonly reason: string
}

export type AttemptBoundaryControl = AttemptSteerControl | AttemptStopAfterTurnControl
export type AttemptControl = AttemptBoundaryControl | AttemptCancelControl
export type AttemptControlBoundary = "before_turn" | "after_turn" | "in_flight"

export type AttemptStopReason =
  | "deadline_exceeded"
  | "aborted"
  | "cancelled"
  | "stop_after_turn"
  | "max_turns"
  | "max_actions"
  | "max_cost"
  | "model_incomplete"
  | "model_protocol_error"
  | "model_error"

interface AttemptRunResultBase {
  attemptId: AttemptId
  usage: AttemptUsage
  messages: readonly ModelMessage[]
  events: readonly AttemptEngineEvent[]
}

export type AttemptRunResult =
  | (AttemptRunResultBase & {
      status: "completion_proposed"
      completion: string
    })
  | (AttemptRunResultBase & {
      status: "stopped" | "aborted" | "cancelled"
      stopReason: AttemptStopReason
    })
