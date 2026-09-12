import type { UnitBudget } from "./unit-budget.js"
import type { ExecutionDeadline } from "./execution-deadline.js"
import type {
  AttemptControlBoundary,
  AttemptRequest,
  AttemptRunResult,
  AttemptStopAfterTurnControl,
  AttemptStopReason,
  AttemptUsage,
  ModelDecision,
  ModelMessage,
  ModelUsage,
  ToolObservation,
  ToolProposal,
} from "./contracts.js"
import type { AttemptEngineEvent } from "./events.js"
import { ModelDecisionAssembler, ModelProtocolError } from "./model-decision-assembler.js"
import type { AttemptControlPort, ModelPort, PermissionPort, ToolPort } from "./ports.js"

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never

type PendingAttemptEngineEvent = DistributiveOmit<
  AttemptEngineEvent,
  "sequence" | "attemptId"
>

export interface NativeAttemptEngineDependencies {
  model: ModelPort
  tools: ToolPort
  permissions: PermissionPort
}

export interface AttemptRunOptions {
  deadline?: ExecutionDeadline
  unitBudget?: UnitBudget
  signal?: AbortSignal
  control?: AttemptControlPort
  /** Opt-in policy claim; the engine itself permits at most one length recovery. */
  requestLengthRecovery?: (turn: number, usage: ModelUsage) => Promise<boolean>
  evidenceClosure?: {
    permissions?: PermissionPort
    guidance?: () => string
    /** Early completion with a preserved artifact but missing evidence. */
    required?: () => boolean
  }
}

interface MutableUsage extends AttemptUsage {}

type LoopGuard = "turns" | "actions"

const loopGuardFinalizationPrompt = (guard: LoopGuard): string => [
  `The Chaos Harness ${guard} guard has been reached. This is the final wrap-up turn.`,
  "No tools are available. Summarize the verified work completed, unresolved items, and the safest next step.",
  "Do not claim success for work that is not supported by the observations already in context.",
].join("\n")

const evidenceClosurePrompt = (guard: LoopGuard | "completion" | "deadline", guidance?: string): string => [
  guard === "completion"
    ? "Chaos Harness requires bounded evidence closure before accepting this early completion."
    : `The Chaos Harness ${guard} work guard has been reached. Enter bounded evidence closure now.`,
  "Do not modify workspace files or expand the implementation. Only use the tools still exposed to validate the latest mutation, inspect the final changes, close or cancel the current tool plan, and gather missing read-only evidence.",
  "Propose completion as soon as those evidence gaps are closed. If they cannot be closed safely, report the unresolved gap honestly.",
  ...(guidance === undefined || guidance.trim().length === 0
    ? []
    : ["Current Chaos Harness evidence state:", guidance.trim()]),
].join("\n")

export class NativeAttemptEngine {
  readonly #model: ModelPort
  readonly #tools: ToolPort
  readonly #permissions: PermissionPort

  constructor(dependencies: NativeAttemptEngineDependencies) {
    this.#model = dependencies.model
    this.#tools = dependencies.tools
    this.#permissions = dependencies.permissions
  }

  async run(
    request: AttemptRequest,
    options: AttemptRunOptions = {},
  ): Promise<AttemptRunResult> {
    const externalSignal = options.signal ?? new AbortController().signal
    const control = options.control ?? createInertControl()
    const events: AttemptEngineEvent[] = []
    const messages: ModelMessage[] = [...request.messages]
    const runSignal = AbortSignal.any([externalSignal, control.signal, ...(options.deadline ? [options.deadline.signal] : [])])
    const usage: MutableUsage = {
      turns: 0,
      actions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    }
    let sequence = 0
    let armedStop: AttemptStopAfterTurnControl | undefined
    let evidenceClosureStart: Pick<AttemptUsage, "turns" | "actions"> | undefined
    let closureTrigger: LoopGuard | "completion" | "deadline" = "turns"
    let lengthRecovered = false
    const reachedGuards = new Set<string>()
    const emit = (event: PendingAttemptEngineEvent): void => {
      events.push({
        ...event,
        sequence: ++sequence,
        attemptId: request.attempt.attemptId,
      } as AttemptEngineEvent)
    }
    const stopped = (reason: AttemptStopReason): AttemptRunResult => {
      emit({ type: "attempt_stopped", reason })
      return {
        status:
          reason === "aborted"
            ? "aborted"
            : reason === "cancelled"
              ? "cancelled"
              : "stopped",
        stopReason: reason,
        attemptId: request.attempt.attemptId,
        usage: { ...usage },
        messages: [...messages],
        events: [...events],
      }
    }
    const budgetStopped = (
      budget: "turns" | "actions" | "cost",
      limit: number,
      consumed: number,
      reason: AttemptStopReason,
      scope?: "unit",
    ): AttemptRunResult => {
      emit({ type: "budget_exceeded", budget, limit, consumed, ...(scope === undefined ? {} : { scope }) })
      return stopped(reason)
    }
    const budgetReached = (
      budget: LoopGuard,
      limit: number,
      consumed: number,
      action: "finalize" | "evidence_closure" = "finalize",
    ): void => {
      const key = `${budget}:${action}`
      if (reachedGuards.has(key)) return
      reachedGuards.add(key)
      emit({ type: "budget_reached", budget, limit, consumed, action })
    }
    const interrupted = (): AttemptRunResult | undefined => {
      if (options.deadline?.expired) return stopped("deadline_exceeded")
      if (externalSignal.aborted) {
        return stopped("aborted")
      }
      if (control.cancellation !== undefined) {
        emit({
          type: "control_processed",
          control: control.cancellation,
          boundary: usage.turns === 0 ? "before_turn" : "in_flight",
          turn: usage.turns === 0 ? null : usage.turns,
          outcome: "applied",
          reason: null,
        })
        return stopped("cancelled")
      }
      if (runSignal.aborted) {
        return stopped("aborted")
      }
      return undefined
    }
    const processPendingControls = (
      boundary: Exclude<AttemptControlBoundary, "in_flight">,
      turn: number,
    ): boolean => {
      let appliedSteer = false
      for (const pending of control.drain()) {
        if (pending.kind === "steer") {
          messages.push({
            role: "control",
            content: pending.content,
            controlId: pending.controlId,
          })
          emit({
            type: "control_processed",
            control: pending,
            boundary,
            turn,
            outcome: "applied",
            reason: null,
          })
          appliedSteer = true
          continue
        }

        if (armedStop === undefined) {
          armedStop = pending
          emit({
            type: "control_processed",
            control: pending,
            boundary,
            turn,
            outcome: "applied",
            reason: null,
          })
        } else {
          emit({
            type: "control_processed",
            control: pending,
            boundary,
            turn,
            outcome: "ignored",
            reason: "stop_after_turn already armed",
          })
        }
      }
      return appliedSteer
    }

    const enterDeadlineClosure = (): void => {
      if (!options.deadline?.closing || evidenceClosureStart !== undefined || request.budget.evidenceClosure === undefined) return
      evidenceClosureStart = { turns: usage.turns, actions: usage.actions }
      closureTrigger = "deadline"
      emit({ type: "evidence_closure_started", trigger: "deadline", workTurns: usage.turns, workActions: usage.actions })
    }
    emit({ type: "attempt_started" })

    while (true) {
      const beforeTurnInterruption = interrupted()
      if (beforeTurnInterruption !== undefined) {
        return beforeTurnInterruption
      }
      const closureBudget = request.budget.evidenceClosure
      enterDeadlineClosure()
      if (closureBudget !== undefined && evidenceClosureStart === undefined) {
        const reachedWorkGuard: LoopGuard | undefined =
          request.budget.maxActions !== undefined && usage.actions >= request.budget.maxActions
            ? "actions"
            : request.budget.maxTurns !== undefined && usage.turns >= request.budget.maxTurns
              ? "turns"
              : undefined
        if (reachedWorkGuard !== undefined) {
          evidenceClosureStart = { turns: usage.turns, actions: usage.actions }
          closureTrigger = reachedWorkGuard
          const limit = reachedWorkGuard === "turns"
            ? request.budget.maxTurns!
            : request.budget.maxActions!
          budgetReached(
            reachedWorkGuard,
            limit,
            reachedWorkGuard === "turns" ? usage.turns : usage.actions,
            "evidence_closure",
          )
          emit({
            type: "evidence_closure_started",
            trigger: reachedWorkGuard,
            workTurns: usage.turns,
            workActions: usage.actions,
          })
        }
      }
      if (
        closureBudget === undefined &&
        request.budget.maxTurns !== undefined &&
        usage.turns >= request.budget.maxTurns
      ) {
        return budgetStopped("turns", request.budget.maxTurns, usage.turns, "max_turns")
      }

      const turn = usage.turns + 1
      const closureTurns = evidenceClosureStart === undefined
        ? 0
        : usage.turns - evidenceClosureStart.turns
      const closureActions = evidenceClosureStart === undefined
        ? 0
        : usage.actions - evidenceClosureStart.actions
      const finalizationGuard: LoopGuard | undefined = evidenceClosureStart !== undefined
        ? closureActions >= closureBudget!.maxActions
          ? "actions"
          : closureTurns + 1 >= closureBudget!.maxTurns
            ? "turns"
            : undefined
        : closureBudget === undefined
          ? request.budget.maxActions !== undefined && usage.actions >= request.budget.maxActions
            ? "actions"
            : request.budget.maxTurns !== undefined && turn === request.budget.maxTurns
              ? "turns"
              : undefined
          : undefined
      if (finalizationGuard !== undefined) {
        const limit = evidenceClosureStart === undefined
          ? finalizationGuard === "turns"
            ? request.budget.maxTurns!
            : request.budget.maxActions!
          : finalizationGuard === "turns"
            ? closureBudget!.maxTurns
            : closureBudget!.maxActions
        const consumed = evidenceClosureStart === undefined
          ? finalizationGuard === "turns" ? turn : usage.actions
          : finalizationGuard === "turns" ? closureTurns + 1 : closureActions
        budgetReached(finalizationGuard, limit, consumed)
      }
      processPendingControls("before_turn", turn)
      if (options.unitBudget && !options.unitBudget.consume("turns")) {
        const total = options.unitBudget.snapshot()
        return budgetStopped("turns", total.maxTurns, total.turns, "max_turns", "unit")
      }
      usage.turns = turn
      emit({ type: "turn_started", turn })

      const projectedMessages: ModelMessage[] = [
        ...messages,
        ...(options.deadline === undefined ? [] : [{ role: "system" as const,
          content: `Execution time remaining: ${Math.ceil(options.deadline.remainingMs / 1000)} seconds. This hard deadline includes tools, recovery and independent verification and will not be extended. ${options.deadline.closing ? "Finish verification and diff inspection now, reuse valid evidence for unchanged artifacts, close any declared plan, then propose completion promptly. Do not add optional checks or new implementation." : `Reserve the final ${Math.ceil(options.deadline.closureWindowMs / 1000)} seconds for evidence closure.`}` }]),
        ...(finalizationGuard !== undefined
          ? [{
              role: "system" as const,
              content: evidenceClosureStart === undefined
                ? loopGuardFinalizationPrompt(finalizationGuard)
                : [
                    evidenceClosurePrompt(
                      closureTrigger,
                      options.evidenceClosure?.guidance?.(),
                    ),
                    loopGuardFinalizationPrompt(finalizationGuard),
                  ].join("\n\n"),
            }]
          : evidenceClosureStart !== undefined
            ? [{
                role: "system" as const,
                content: evidenceClosurePrompt(
                  closureTrigger,
                  options.evidenceClosure?.guidance?.(),
                ),
              }]
            : []),
      ]
      const availableTools = finalizationGuard !== undefined
        ? []
        : evidenceClosureStart === undefined
          ? request.tools
          : request.tools.filter((tool) => closureBudget!.allowedToolNames.includes(tool.name))

      const assembler = new ModelDecisionAssembler()
      try {
        const stream = this.#model.stream(
          {
            attemptId: request.attempt.attemptId,
            turn,
            messages: projectedMessages,
            tools: availableTools,
          },
          runSignal,
        )
        for await (const event of stream) {
          const streamInterruption = interrupted()
          if (streamInterruption !== undefined) {
            return streamInterruption
          }
          emit({ type: "model_stream_event", turn, event })
          assembler.push(event)
        }
      } catch (error) {
        const streamInterruption = interrupted()
        if (streamInterruption !== undefined) {
          return streamInterruption
        }
        if (error instanceof ModelProtocolError) {
          return stopped("model_protocol_error")
        }
        return stopped("model_error")
      }

      const afterStreamInterruption = interrupted()
      if (afterStreamInterruption !== undefined) {
        return afterStreamInterruption
      }

      let decision: ModelDecision
      try {
        decision = assembler.finish()
      } catch (error) {
        if (error instanceof ModelProtocolError) {
          return stopped("model_protocol_error")
        }
        throw error
      }
      emit({ type: "model_decision", turn, decision })
      addModelUsage(usage, decision.usage)

      if (request.budget.maxCost !== undefined && usage.cost > request.budget.maxCost) {
        emit({ type: "turn_completed", turn, usage: decision.usage })
        return budgetStopped("cost", request.budget.maxCost, usage.cost, "max_cost")
      }

      if (decision.kind === "incomplete") {
        emit({ type: "turn_completed", turn, usage: decision.usage })
        processPendingControls("after_turn", turn)
        if (armedStop !== undefined) return stopped("stop_after_turn")
        const nextWorkTurnAvailable = request.budget.maxTurns === undefined ||
          turn + 1 < request.budget.maxTurns + (closureBudget === undefined ? 0 : 1)
        if (decision.finishReason === "length" && !lengthRecovered &&
            finalizationGuard === undefined && evidenceClosureStart === undefined &&
            nextWorkTurnAvailable && availableTools.length > 0 &&
            (options.unitBudget === undefined || (options.unitBudget.hasCapacity("turns") && options.unitBudget.hasCapacity("actions"))) &&
            (request.budget.maxActions === undefined || usage.actions < request.budget.maxActions) &&
            (request.budget.maxCost === undefined || usage.cost < request.budget.maxCost) &&
            await options.requestLengthRecovery?.(turn, decision.usage)) {
          const recoveryInterruption = interrupted()
          if (recoveryInterruption !== undefined) return recoveryInterruption
          processPendingControls("after_turn", turn)
          if (armedStop !== undefined) return stopped("stop_after_turn")
          lengthRecovered = true
          emit({ type: "model_length_recovery_started", turn, usage: decision.usage })
          // Keep completed observations; never replay truncated text/reasoning/tools.
          messages.push({ role: "system", content: [
            "Chaos Harness observed that the last model turn hit its output length limit; its incomplete response was discarded.",
            "One bounded recovery is allowed. Use the completed observations already in context and choose one concrete, justified next tool action, or state the precise blocker.",
            "Do not restart broad investigation or repeat the previous analysis. Preserve the workspace and existing evidence; all original budgets and completion requirements still apply.",
          ].join("\n") })
          continue
        }
        return stopped("model_incomplete")
      }

      if (finalizationGuard !== undefined && decision.kind === "tool_calls") {
        emit({ type: "turn_completed", turn, usage: decision.usage })
        const limit = evidenceClosureStart === undefined
          ? finalizationGuard === "turns"
            ? request.budget.maxTurns!
            : request.budget.maxActions!
          : finalizationGuard === "turns"
            ? closureBudget!.maxTurns
            : closureBudget!.maxActions
        const consumed = evidenceClosureStart === undefined
          ? finalizationGuard === "turns" ? usage.turns : usage.actions
          : finalizationGuard === "turns"
            ? usage.turns - evidenceClosureStart.turns
            : usage.actions - evidenceClosureStart.actions
        return budgetStopped(
          finalizationGuard,
          limit,
          consumed,
          finalizationGuard === "turns" ? "max_turns" : "max_actions",
        )
      }

      if (decision.kind === "final") {
        messages.push({
          role: "assistant",
          content: decision.text,
          ...(decision.reasoning.length === 0 ? {} : { reasoning: decision.reasoning }),
        })
        emit({ type: "turn_completed", turn, usage: decision.usage })
        const steeredAfterTurn = processPendingControls("after_turn", turn)
        if (armedStop !== undefined) {
          return stopped("stop_after_turn")
        }
        if (steeredAfterTurn) {
          continue
        }
        if (closureBudget !== undefined && evidenceClosureStart === undefined && options.evidenceClosure?.required?.()) {
          evidenceClosureStart = { turns: usage.turns, actions: usage.actions }
          closureTrigger = "completion"
          emit({ type: "evidence_closure_started", trigger: "completion", workTurns: usage.turns, workActions: usage.actions })
          continue
        }
        emit({ type: "completion_proposed", turn, content: decision.text })
        emit({ type: "attempt_completed", outcome: "completion_proposed" })
        return {
          status: "completion_proposed",
          completion: decision.text,
          attemptId: request.attempt.attemptId,
          usage: { ...usage },
          messages: [...messages],
          events: [...events],
        }
      }

      messages.push({
        role: "assistant",
        content: decision.text,
        ...(decision.reasoning.length === 0 ? {} : { reasoning: decision.reasoning }),
        toolCalls: decision.toolCalls,
      })
      for (const call of decision.toolCalls) {
        const actionInterruption = interrupted()
        if (actionInterruption !== undefined) {
          return actionInterruption
        }
        // An in-flight response/tool may cross the soft boundary. Recheck every dispatch.
        enterDeadlineClosure()
        const proposal: ToolProposal = {
          attemptId: request.attempt.attemptId,
          turn,
          call,
        }
        emit({ type: "tool_proposed", proposal })
        const actionGuardReached = evidenceClosureStart === undefined
          ? request.budget.maxActions !== undefined && usage.actions >= request.budget.maxActions
          : usage.actions - evidenceClosureStart.actions >= closureBudget!.maxActions
        if (actionGuardReached) {
          const limit = evidenceClosureStart === undefined
            ? request.budget.maxActions!
            : closureBudget!.maxActions
          const consumed = evidenceClosureStart === undefined
            ? usage.actions
            : usage.actions - evidenceClosureStart.actions
          budgetReached("actions", limit, consumed)
          const observation: ToolObservation = {
            toolCallId: call.toolCallId,
            toolName: call.name,
            ok: false,
            content: evidenceClosureStart === undefined
              ? "Chaos Harness action guard reached; this action was not executed. Use the next turn to enter evidence closure."
              : "Chaos Harness evidence-closure action guard reached; this action was not executed. Use the next turn to report the remaining evidence gap honestly.",
            errorCode: "action_guard_reached",
          }
          emit({ type: "tool_observed", proposal, observation })
          messages.push(toToolMessage(observation))
          continue
        }

        if (options.unitBudget && !options.unitBudget.consume("actions")) {
          const total = options.unitBudget.snapshot()
          const observation: ToolObservation = { toolCallId: call.toolCallId, toolName: call.name, ok: false,
            errorCode: "action_guard_reached", content: "Chaos Unit total action budget exhausted; this action was not executed." }
          emit({ type: "tool_observed", proposal, observation })
          messages.push(toToolMessage(observation))
          return budgetStopped("actions", total.maxActions, total.actions, "max_actions", "unit")
        }
        usage.actions += 1

        const definition = availableTools.find((tool) => tool.name === call.name &&
          (evidenceClosureStart === undefined || closureBudget!.allowedToolNames.includes(tool.name)))
        if (definition === undefined) {
          const closureBlocked = evidenceClosureStart !== undefined && availableTools.some(tool => tool.name === call.name)
          const observation: ToolObservation = {
            toolCallId: call.toolCallId,
            toolName: call.name,
            ok: false,
            content: closureBlocked ? "This action was not executed: evidence closure permits only remaining validation and inspection tools." : `Unknown tool: ${call.name}`,
            errorCode: closureBlocked ? "permission_denied" : "unknown_tool",
          }
          emit({ type: "tool_observed", proposal, observation })
          messages.push(toToolMessage(observation))
          continue
        }

        let permission
        try {
          permission = await (
            evidenceClosureStart === undefined
              ? this.#permissions
              : options.evidenceClosure?.permissions ?? this.#permissions
          ).evaluate(proposal, runSignal)
        } catch (error) {
          const permissionInterruption = interrupted()
          if (permissionInterruption !== undefined) {
            return permissionInterruption
          }
          permission = {
            outcome: "deny" as const,
            reason: errorMessage(error),
          }
        }
        emit({ type: "permission_evaluated", proposal, decision: permission })
        const afterPermissionInterruption = interrupted()
        if (afterPermissionInterruption !== undefined) {
          return afterPermissionInterruption
        }

        if (permission.outcome === "deny") {
          const observation: ToolObservation = {
            toolCallId: call.toolCallId,
            toolName: call.name,
            ok: false,
            content: permission.reason,
            errorCode: "permission_denied",
          }
          emit({ type: "tool_observed", proposal, observation })
          messages.push(toToolMessage(observation))
          continue
        }

        emit({ type: "tool_started", proposal })
        let observation: ToolObservation
        try {
          const result = await this.#tools.execute(proposal, runSignal)
          observation = {
            ...result,
            toolCallId: call.toolCallId,
            toolName: call.name,
          }
        } catch (error) {
          const toolInterruption = interrupted()
          if (toolInterruption !== undefined) {
            return toolInterruption
          }
          observation = {
            toolCallId: call.toolCallId,
            toolName: call.name,
            ok: false,
            content: errorMessage(error),
            errorCode: "tool_error",
          }
        }
        emit({ type: "tool_observed", proposal, observation })
        messages.push(toToolMessage(observation))
        const afterToolInterruption = interrupted()
        if (afterToolInterruption !== undefined) {
          return afterToolInterruption
        }
      }

      emit({ type: "turn_completed", turn, usage: decision.usage })
      processPendingControls("after_turn", turn)
      if (armedStop !== undefined) {
        return stopped("stop_after_turn")
      }
    }
  }
}

function createInertControl(): AttemptControlPort {
  return {
    signal: new AbortController().signal,
    cancellation: undefined,
    drain: () => [],
  }
}

function addModelUsage(target: MutableUsage, source: ModelUsage): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  if (source.reasoningTokens !== undefined) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + source.reasoningTokens
  }
  if (source.cacheReadTokens !== undefined) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + source.cacheReadTokens
  }
  if (source.cacheWriteTokens !== undefined) {
    target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + source.cacheWriteTokens
  }
  target.cost += source.cost
}

function toToolMessage(observation: ToolObservation): ModelMessage {
  return {
    role: "tool",
    content: observation.content,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    ok: observation.ok,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}
