import type { AttemptRunResult, AttemptProgressState, ToolProposal } from "../../../kernel/src/index.js"

export interface AttemptStopMetadata {
  kind: "controller_progress" | "budget" | "model" | "interruption"
  stopReason: string
  budgetScope?: "unit"
  failureCode?: NonNullable<AttemptProgressState["failureCode"]>
}

export function attemptStopMetadata(result: AttemptRunResult | undefined,
  failureCode?: AttemptProgressState["failureCode"]): AttemptStopMetadata | undefined {
  if (result?.status === "completion_proposed") return undefined
  const stopReason = result?.stopReason ?? "aborted"
  if (stopReason === "stop_after_turn" && failureCode !== undefined) {
    return { kind: "controller_progress", stopReason, failureCode }
  }
  return { stopReason, ...(result?.events.some(e => e.type === "budget_exceeded" && e.scope === "unit") ? { budgetScope: "unit" as const } : {}), kind: ["max_turns", "max_actions", "max_cost", "budget_exhausted"].includes(stopReason)
    ? "budget" : ["model_incomplete", "model_error", "model_protocol_error"].includes(stopReason) ? "model" : "interruption" }
}

export type ActionDisposition = "host_observed" | "host_forwarded_unobserved" | "controller_blocked" |
  "workspace_preflight_rejected" | "budget_blocked" | "permission_blocked" | "unknown_tool" | "not_dispatched"
export interface ActionAccounting {
  proposed: number
  hostForwarded: number
  hostObserved: number
  controllerBlocked: number
  workspaceRejected: number
  budgetBlocked: number
  permissionBlocked: number
  unknownTool: number
  notDispatched: number
}
export const actionKey = (proposal: ToolProposal) => JSON.stringify([proposal.turn, proposal.call.toolCallId])

// Use complete model decisions, including calls never reached by the kernel.
// Arguments, outputs, call IDs and model reasoning never leave this projection.
export function accountActions(result: AttemptRunResult | undefined, dispositions: ReadonlyMap<string, ActionDisposition>, registered: ReadonlySet<string>) {
  const actions: { ordinal: number; turn: number; action: string; disposition: ActionDisposition }[] = []
  const observationCodes = new Map<string, string | undefined>()
  for (const event of result?.events ?? []) {
    if (event.type === "tool_observed") observationCodes.set(actionKey(event.proposal), event.observation.errorCode)
  }
  for (const event of result?.events ?? []) {
    if (event.type !== "model_decision" || event.decision.kind !== "tool_calls") continue
    for (const call of event.decision.toolCalls) {
      const key = JSON.stringify([event.turn, call.toolCallId])
      const code = observationCodes.get(key)
      const disposition = dispositions.get(key) ?? (code === "action_guard_reached" ? "budget_blocked" :
        code === "permission_denied" ? "permission_blocked" : code === "unknown_tool" ? "unknown_tool" : "not_dispatched")
      actions.push({ ordinal: actions.length + 1, turn: event.turn,
        action: registered.has(call.name) ? call.name : "unregistered_tool", disposition })
    }
  }
  const count = (d: ActionDisposition) => actions.filter(a => a.disposition === d).length
  const accounting: ActionAccounting = { proposed: actions.length,
    hostObserved: count("host_observed"), hostForwarded: count("host_observed") + count("host_forwarded_unobserved"),
    controllerBlocked: count("controller_blocked"), workspaceRejected: count("workspace_preflight_rejected"),
    budgetBlocked: count("budget_blocked"), permissionBlocked: count("permission_blocked"),
    unknownTool: count("unknown_tool"), notDispatched: count("not_dispatched") }
  return { actions, accounting }
}
