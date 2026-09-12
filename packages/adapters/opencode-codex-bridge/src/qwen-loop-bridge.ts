import { isVerificationFailureCode, verificationFailureCode, type VerificationFailureCode } from "./verification-failure.js"
import { UnitBudget, type UnitBudgetLimits, type UnitBudgetSnapshot } from "../../../kernel/src/loop/unit-budget.js"
import { withModelTiming, type ModelTimingEvent } from "./model-timing.js"
import { accountActions, actionKey, attemptStopMetadata, type ActionDisposition, type ActionAccounting, type AttemptStopMetadata } from "./attempt-diagnostics.js"
import type { ExecutionDeadline } from "../../../kernel/src/loop/execution-deadline.js"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
  AttemptController,
  advanceAttemptProgress,
  initialAttemptProgress,
  validateProgressPolicy,
  NativeAttemptEngine,
  type AttemptRef,
  type AttemptRunResult,
  type JsonObject,
  type LoopBudget,
  type ModelPort,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type PermissionPort,
  type ToolCall,
  type ToolDefinition,
  type ToolObservation,
  type ToolPort,
  type ToolProposal,
  type AttemptProgressPolicy,
  type AttemptProgressState,
  type ProgressDecision,
  type RecoveryStrategy,
} from "../../../kernel/src/index.js"
import {
  DailyUnitRuntime,
  evaluateDailyEvidenceClosureAction,
  inferDailyMutationIntent,
  type DailyExternalVerificationVerdict,
  type DailyRuntimeCompletionDecision,
  type DailyRuntimeJournalEvent,
  type DailyWorkspaceArtifactProgress,
  type DailyWorkspaceArtifactState,
  type DailyCancellationReason,
} from "./daily-runtime.js"
import { parseLocalFeedback, parseFeedbackSubmission, feedbackAcknowledgement, type LocalFeedback } from "./feedback.js"
import { captureGitWorkspaceArtifactState, GitArtifactStateError } from "./git-artifact-state.js"
import { progressSignatures } from "./progress-signatures.js"
import { diagnoseWorkspaceAction, workspaceBoundaryGuidance, type WorkspaceBoundaryDiagnostic } from "./workspace-action-boundary.js"
import { HOST_PERMISSION_REJECTED, HOST_TOOL_ERROR, MAX_TERMINAL_OBSERVATIONS,
  MAX_TERMINAL_OBSERVATION_BYTES } from "./opencode-terminal-observations.js"
import {
  decodeOpenCodeToolObservation,
  OpenCodeObservationEnvelopeError,
} from "./opencode-observation-envelope.js"
import type { QwenProfile } from "./qwen.js"
import { chatIdentity, createProfileChatModel, type BackendIdentity } from "./model-profiles.js"
import { summarizeModelFailure, modelFailureDescription, type ModelFailureSummary } from "./model-failure.js"

export const QWEN_LOOP_PROVIDER = "chaos-qwen"
export const QWEN_LOOP_MODEL_ID = "code-agent"
export const QWEN_LOOP_METADATA_MODEL_ID = "metadata"
export const QWEN_LOOP_MODEL = `${QWEN_LOOP_PROVIDER}/${QWEN_LOOP_MODEL_ID}`
export const QWEN_LOOP_SMALL_MODEL = `${QWEN_LOOP_PROVIDER}/${QWEN_LOOP_METADATA_MODEL_ID}`
export const QWEN_LOOP_BRIDGE_HOST = "127.0.0.1"

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_PROJECTION_CHARS = 96_000
const DEFAULT_MAX_TOOL_OBSERVATION_CHARS = 96_000
const DEFAULT_COMPLETION_VERIFIER_TIMEOUT_MS = 30_000

export interface QwenAttemptJournalEvent {
  event: ModelTimingEvent["event"] | "host_terminal_observation_received" | "host_observation_received" | "delivery_readiness_checked" | "action_accounted" | "attempt_started" | "action_proposed" | "action_observed" | "mutation_progress_checked" | "evidence_closure_started" | "attempt_finished" | "attempt_progress_observed" | "attempt_stuck_detected" | "attempt_control_decided" | "model_length_recovery_started"
  hostTerminalError?: typeof HOST_PERMISSION_REJECTED | typeof HOST_TOOL_ERROR
  attemptId: string
  model: string
  missionId: string
  unitId: string
  unitRevision: number
  primaryStop?: AttemptStopMetadata
  unitBudget?: UnitBudgetSnapshot
  contextContinuationCount?: number
  pathCorrectionCount?: number
  workspaceBoundary?: WorkspaceBoundaryDiagnostic
  workspaceRejectionLimitReached?: boolean
  actionAccounting?: ActionAccounting
  ordinal?: number
  disposition?: ActionDisposition
  goalSha256?: string
  toolCount?: number
  turn?: number
  timing?: ModelTimingEvent
  hostRoundTripMs?: number
  observationProcessingMs?: number
  readiness?: { passed: boolean; elapsedMs: number }
  action?: string
  ok?: boolean
  observationSource?: "workspace_preflight"
  terminalState?: AttemptRunResult["status"]
  stopReason?: string
  turns?: number
  actions?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  closureTrigger?: "turns" | "actions" | "completion" | "deadline"
  workTurns?: number
  workActions?: number
  artifactProgress?: DailyWorkspaceArtifactProgress
  intervention?: "none" | "steer"
  phase?: AttemptProgressState["phase"]
  progressLevel?: AttemptProgressState["level"]
  failureCode?: AttemptProgressState["failureCode"]
  controlDecision?: ProgressDecision["kind"]
  investigationExtensionCount?: number
  noArtifactDeadlineAction?: number
  extensionReason?: "new_evidence" | "novel_observations"
  strategyId?: RecoveryStrategy
  usageAvailable?: boolean
  modelFailure?: ModelFailureSummary
  modelTermination?: {
    finishReason: "length" | "content_filter" | "error"
    turn: number
    inputTokens: number
    outputTokens: number
    reasoningTokens?: number
  }
}

export type QwenLoopJournalEvent = (QwenAttemptJournalEvent | DailyRuntimeJournalEvent | ({
  event: "feedback_recorded"
  binding: "mission" | "unbound"
  attemptId?: string
  missionId?: string
  unitId?: string
  unitRevision?: number
} & LocalFeedback)) & Partial<BackendIdentity> & { primaryStop?: AttemptStopMetadata; cleanupReason?: DailyCancellationReason }

export interface OpenCodeQwenLoopBridgeOptions {
  workspaceRoot: string
  profile: QwenProfile
  recordEvent?: (event: QwenLoopJournalEvent) => Promise<void>
  maxBodyBytes?: number
  maxProjectionChars?: number
  maxToolObservationChars?: number
  modelFactory?: (profile: QwenProfile) => ModelPort
  createAttemptId?: () => string
  observationToken?: string
  completionVerifier?: QwenCompletionVerifier
  completionVerificationOrder?: "artifact-first"
  completionVerifierTimeoutMs?: number
  workspaceArtifactProbe?: QwenWorkspaceArtifactProbe
  unitBudget?: UnitBudgetLimits
  noArtifactContinuation?: { maxAdditionalActions: number }
  workspacePathRecovery?: { maxAdditionalActions: number }
  deliveryReadiness?: { afterActions: number; probe: QwenCompletionVerifier; timeoutMs?: number }
  attemptBudget?: LoopBudget
  deadline?: ExecutionDeadline
  mutationProgressSteer?: QwenMutationProgressSteerPolicy
  progressPolicy?: AttemptProgressPolicy
  workspaceBoundary?: "root-only"
  modelLengthRecovery?: "once-per-unit"
}

export interface QwenMutationProgressSteerPolicy {
  afterActions: number
}

export interface QwenWorkspaceArtifactProbe {
  capture(workspaceRoot: string): Promise<DailyWorkspaceArtifactState>
}

export interface QwenCompletionVerifierContext {
  missionId: string
  unitId: string
  unitRevision: number
  attemptId: string
  workspaceRoot: string
  goal: string
  completion: string
  signal: AbortSignal
}

export interface QwenCompletionVerifier {
  id: string
  verify(context: QwenCompletionVerifierContext): Promise<{
    failureCode?: VerificationFailureCode
    passed: boolean
    guidance?: string
  }>
}

export interface OpenCodeQwenLoopBridge {
  baseUrl: string
  apiKey: string
  observationToken: string
  close(terminalObservations?: readonly string[]): Promise<void>
}

export interface OpenCodeQwenLoopConfig {
  model: typeof QWEN_LOOP_MODEL
  small_model: typeof QWEN_LOOP_SMALL_MODEL
  enabled_providers: readonly [typeof QWEN_LOOP_PROVIDER]
  plugin?: readonly [string]
  autoupdate: false
  share: "disabled"
  provider: Record<string, unknown>
  command: Record<string, { template: string; description: string }>
}

interface ParsedChatRequest {
  model: string
  stream: boolean
  messages: readonly WireMessage[]
  tools: readonly ToolDefinition[]
}

interface WireMessage {
  role: string
  content: unknown
  toolCallId?: string
}

interface DriverToolCall {
  type: "tool_call"
  call: ToolCall
  attemptId: string
  turn: number
}

interface DriverReasoningDelta {
  type: "reasoning_delta"
  attemptId: string
  turn: number
  delta: string
}

interface DriverUsage {
  type: "usage"
  attemptId: string
  turn: number
  usage: ModelUsage
}

interface DriverTerminal {
  type: "terminal"
  attemptId: string
  result: AttemptRunResult
}

type DriverEvent = DriverReasoningDelta | DriverUsage | DriverToolCall | DriverTerminal

interface ActiveQwenUnit {
  modelProfile: QwenProfile
  runtime: DailyUnitRuntime
  driver: QwenAttemptDriver
  goal: string
  tools: readonly ToolDefinition[]
  lifetime: AbortController
}

type PendingQwenUnit = Omit<ActiveQwenUnit, "driver" | "lifetime"> & { primaryStop?: AttemptStopMetadata }

interface CompletionStreamState {
  id: string
  created: number
  model: string
}

interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
  completion_tokens_details?: { reasoning_tokens: number }
}

interface PendingObservation {
  proposal: ToolProposal
  resolve(observation: ToolObservation): void
  reject(error: unknown): void
}

class QwenLoopBridgeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "QwenLoopBridgeError"
  }
}

class DriverEventQueue {
  readonly #events: DriverEvent[] = []
  readonly #waiters: Array<{
    resolve(event: DriverEvent): void
    reject(error: unknown): void
  }> = []
  #closed: unknown

  push(event: DriverEvent): void {
    if (this.#closed !== undefined) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter.resolve(event)
    else this.#events.push(event)
  }

  async shift(): Promise<DriverEvent> {
    const event = this.#events.shift()
    if (event !== undefined) return event
    if (this.#closed !== undefined) throw this.#closed
    return await new Promise<DriverEvent>((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  close(reason: unknown): void {
    if (this.#closed !== undefined) return
    this.#closed = reason
    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason)
  }
}

class OpenCodeRelayToolPort implements ToolPort {
  #pending: PendingObservation | undefined

  constructor(
    private readonly queue: DriverEventQueue,
    private readonly attemptId: string,
    private readonly preflight?: (proposal: ToolProposal) => Promise<ToolObservation | undefined>,
  ) {}

  get pendingCallId(): string | undefined {
    return this.#pending?.proposal.call.toolCallId
  }

  get pendingToolName(): string | undefined {
    return this.#pending?.proposal.call.name
  }

  get pendingProposal(): ToolProposal | undefined {
    return this.#pending?.proposal
  }

  async execute(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    if (this.#pending !== undefined) {
      throw new Error("Chaos tool relay already has a pending Action")
    }
    if (signal.aborted) throw signal.reason
    const rejected = await this.preflight?.(proposal)
    if (signal.aborted) throw signal.reason
    if (rejected) return rejected
    return await new Promise<ToolObservation>((resolve, reject) => {
      const abort = (): void => {
        if (this.#pending?.proposal.call.toolCallId !== proposal.call.toolCallId) return
        this.#pending = undefined
        reject(signal.reason)
      }
      this.#pending = {
        proposal,
        resolve: (observation) => {
          signal.removeEventListener("abort", abort)
          this.#pending = undefined
          resolve(observation)
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort)
          this.#pending = undefined
          reject(error)
        },
      }
      signal.addEventListener("abort", abort, { once: true })
      this.queue.push({
        type: "tool_call",
        call: proposal.call,
        attemptId: this.attemptId,
        turn: proposal.turn,
      })
    })
  }

  observe(observation: ToolObservation): void {
    const pending = this.#pending
    if (pending === undefined) {
      throw new QwenLoopBridgeError(409, "No Chaos Action is waiting for an observation", "observation_without_action")
    }
    if (observation.toolCallId !== pending.proposal.call.toolCallId) {
      throw new QwenLoopBridgeError(409, "Tool observation does not match the pending Chaos Action", "observation_mismatch")
    }
    pending.resolve({ ...observation, toolName: pending.proposal.call.name })
  }

  close(reason: unknown): void {
    this.#pending?.reject(reason)
    this.#pending = undefined
  }
}

class AllowRegisteredToolPermissionPort implements PermissionPort {
  constructor(private readonly names: ReadonlySet<string>) {}

  async evaluate(proposal: ToolProposal): Promise<{ outcome: "allow" } | { outcome: "deny"; reason: string }> {
    return this.names.has(proposal.call.name)
      ? { outcome: "allow" }
      : { outcome: "deny", reason: `Tool is not registered by the OpenCode host: ${proposal.call.name}` }
  }
}

class DailyEvidenceClosurePermissionPort implements PermissionPort {
  constructor(private readonly names: ReadonlySet<string>) {}

  async evaluate(proposal: ToolProposal): Promise<{ outcome: "allow" } | { outcome: "deny"; reason: string }> {
    if (!this.names.has(proposal.call.name)) {
      return { outcome: "deny", reason: `Tool is not registered by the OpenCode host: ${proposal.call.name}` }
    }
    return evaluateDailyEvidenceClosureAction(proposal.call)
  }
}

class ReasoningRelayModelPort implements ModelPort {
  constructor(
    private readonly delegate: ModelPort,
    private readonly queue: DriverEventQueue,
    private readonly attemptId: string,
    private readonly failed: (failure: ModelFailureSummary) => void,
  ) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    try {
      for await (const event of this.delegate.stream(request, signal)) {
        if (event.type === "reasoning_delta") {
          this.queue.push({
            type: "reasoning_delta",
            attemptId: this.attemptId,
            turn: request.turn,
            delta: event.delta,
          })
        } else if (event.type === "usage") {
          this.queue.push({
            type: "usage",
            attemptId: this.attemptId,
            turn: request.turn,
            usage: event.usage,
          })
        }
        yield event
      }
    } catch (error) {
      if (!signal.aborted) this.failed(summarizeModelFailure(error))
      throw error
    }
  }
}

class QwenAttemptDriver {
  readonly attemptId: string
  readonly #abort = new AbortController()
  #hostForwardedAt: number | undefined
  readonly #controller = new AttemptController()
  readonly #queue = new DriverEventQueue()
  readonly #relay: OpenCodeRelayToolPort
  readonly #completion: Promise<AttemptRunResult>
  #terminalDelivered = false
  #observedActions = 0
  #mutationProgressChecked = false
  #progress = initialAttemptProgress()
  readonly #progressPolicy: AttemptProgressPolicy | undefined
  readonly #budget: LoopBudget | undefined
  readonly #deadline: ExecutionDeadline | undefined
  readonly #runtime: DailyUnitRuntime
  #closureEntered = false
  #pathCorrectionDeadline?: number
  readonly #claimPathCorrection: (() => boolean) | undefined
  #modelFailure: ModelFailureSummary | undefined
  readonly actionDispositions = new Map<string, ActionDisposition>()
  readonly registeredTools: ReadonlySet<string>
  readonly unitBudget: UnitBudget | undefined
  readonly #continuationActions: number | undefined
  readonly #claimContextContinuation: (() => boolean) | undefined
  readonly strategy: RecoveryStrategy

  constructor(options: {
    attempt: AttemptRef
    model: ModelPort
    goal: string
    tools: readonly ToolDefinition[]
    workspaceRoot: string
    runtime: DailyUnitRuntime
    recoveryPrompt?: string
    budget?: LoopBudget
    deadline?: ExecutionDeadline
    progressPolicy?: AttemptProgressPolicy
    strategy?: RecoveryStrategy
    workspaceBoundary?: "root-only"
    recordEvent?: (event: QwenLoopJournalEvent) => Promise<void>
    modelName?: string
    unitBudget?: UnitBudget
    continuationActions?: number
    claimContextContinuation?: () => boolean
    pathCorrectionActions?: number
    claimPathCorrection?: () => boolean
    claimLengthRecovery?: () => boolean
  }) {
    this.unitBudget = options.unitBudget
    this.#continuationActions = options.continuationActions
    this.#claimContextContinuation = options.claimContextContinuation
    this.#claimPathCorrection = options.claimPathCorrection
    this.registeredTools = new Set(options.tools.map(tool => tool.name))
    this.attemptId = options.attempt.attemptId
    this.#runtime = options.runtime
    this.#progressPolicy = options.progressPolicy
    this.#budget = options.budget
    this.#deadline = options.deadline
    this.strategy = options.strategy ?? "initial"
    this.#closureEntered = this.strategy === "evidence-only"
    let boundaryRejections = 0
    this.#relay = new OpenCodeRelayToolPort(this.#queue, options.attempt.attemptId,
      options.workspaceBoundary === undefined ? undefined : async proposal => {
        const diagnostic = await diagnoseWorkspaceAction(options.workspaceRoot, proposal.call)
        if (boundaryRejections < 2 && diagnostic === undefined) return undefined
        boundaryRejections++
        if (boundaryRejections === 1 && ["write", "edit"].includes(proposal.call.name) &&
            this.tracksProgress && this.#progress.artifact === "unchanged" && options.pathCorrectionActions !== undefined) {
          // Fixed distance from the rejection, not a renewable window from every later read.
          this.#pathCorrectionDeadline = this.#progress.workActions + options.pathCorrectionActions
        }
        this.actionDispositions.set(actionKey(proposal), "workspace_preflight_rejected")
        const observation: ToolObservation = {
          toolCallId: proposal.call.toolCallId, toolName: proposal.call.name, ok: false,
          errorCode: "workspace_boundary",
          content: workspaceBoundaryGuidance(options.workspaceRoot, boundaryRejections >= 2, diagnostic),
        }
        options.runtime.recordAction(proposal, observation)
        await options.recordEvent?.({
          event: "action_observed", attemptId: this.attemptId, model: options.modelName ?? "unknown",
          missionId: options.runtime.missionId, unitId: options.runtime.unitId, unitRevision: options.runtime.unitRevision,
          action: proposal.call.name, ok: false, observationSource: "workspace_preflight",
          ...(diagnostic === undefined ? {} : { workspaceBoundary: diagnostic }),
          workspaceRejectionLimitReached: boundaryRejections >= 2,
        })
        if (boundaryRejections === 2) this.#controller.stopAfterTurn("Workspace path rejection limit reached")
        return observation
      })
    const registered = new AllowRegisteredToolPermissionPort(new Set(options.tools.map((tool) => tool.name)))
    const engine = new NativeAttemptEngine({
      model: new ReasoningRelayModelPort(options.recordEvent === undefined ? options.model : withModelTiming(options.model, async timing => {
        await options.recordEvent!({ event: timing.event, turn: timing.turn, timing,
          attemptId: this.attemptId, model: options.modelName ?? "unknown", missionId: options.runtime.missionId,
          unitId: options.runtime.unitId, unitRevision: options.runtime.unitRevision })
      }), this.#queue, options.attempt.attemptId, failure => { this.#modelFailure = failure }),
      tools: this.#relay,
      permissions: {
        evaluate: async (proposal) => {
          if (this.#progress.failureCode !== undefined) {
            this.actionDispositions.set(actionKey(proposal), "controller_blocked")
            return { outcome: "deny", reason: "Chaos Harness stopped this unproductive strategy; remaining batch actions were not executed." }
          }
          if (this.strategy === "evidence-only" || options.deadline?.closing) return evaluateDailyEvidenceClosureAction(proposal.call)
          return registered.evaluate(proposal)
        },
      },
    })
    this.#completion = engine.run({
      attempt: options.attempt,
      messages: [
        {
          role: "system",
          content: [qwenSystemPrompt(options.workspaceRoot, options.workspaceBoundary), options.recoveryPrompt,
            ...(options.unitBudget === undefined ? [] : [
              `Chaos Unit total remaining allowance: ${options.unitBudget.snapshot().remainingTurns} model turns and ${options.unitBudget.snapshot().remainingActions} charged actions, including recovery, length continuation and evidence closure. Attempt limits do not renew this total.`,
            ]),
          ]
            .filter((item): item is string => item !== undefined)
            .join("\n\n"),
        },
        { role: "user", content: options.goal },
      ],
      tools: this.strategy === "evidence-only"
        ? options.tools.filter((tool) => options.budget?.evidenceClosure?.allowedToolNames.includes(tool.name)) : options.tools,
      budget: this.strategy === "evidence-only" ? {
        maxTurns: options.budget!.evidenceClosure!.maxTurns,
        maxActions: options.budget!.evidenceClosure!.maxActions,
        ...(options.budget?.maxCost === undefined ? {} : { maxCost: options.budget.maxCost }),
      } : { ...options.budget },
    }, {
      signal: this.#abort.signal,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      control: this.#controller,
      ...(options.unitBudget === undefined ? {} : { unitBudget: options.unitBudget }),
      ...(options.claimLengthRecovery === undefined || this.strategy === "evidence-only" ? {} : {
        requestLengthRecovery: async (turn: number, usage: ModelUsage) => {
          if (!options.claimLengthRecovery!()) return false
          await options.recordEvent?.({
            event: "model_length_recovery_started", attemptId: this.attemptId,
            model: options.modelName ?? "unknown", missionId: options.runtime.missionId,
            unitId: options.runtime.unitId, unitRevision: options.runtime.unitRevision,
            turn, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
          })
          return true
        },
      }),
      ...(options.budget?.evidenceClosure === undefined
        ? {}
        : {
            evidenceClosure: {
              permissions: new DailyEvidenceClosurePermissionPort(new Set(options.tools.map((tool) => tool.name))),
              guidance: () => options.runtime.evidenceClosureGuidance(),
              ...(options.progressPolicy === undefined ? {} : {
                required: () => {
                  const required = options.runtime.needsEvidenceClosure()
                  if (required) this.#closureEntered = true
                  return required
                },
              }),
            },
          }),
    }).then((result) => {
      this.#queue.push({ type: "terminal", attemptId: this.attemptId, result })
      return result
    }).catch((error: unknown) => {
      this.#queue.close(error)
      throw error
    })
  }

  get pendingCallId(): string | undefined {
    return this.#relay.pendingCallId
  }

  get pendingToolName(): string | undefined {
    return this.#relay.pendingToolName
  }

  get pendingProposal(): ToolProposal | undefined {
    return this.#relay.pendingProposal
  }

  markHostForwarded(): void {
    this.#hostForwardedAt = performance.now()
    const proposal = this.#relay.pendingProposal
    if (proposal) this.actionDispositions.set(actionKey(proposal), "host_forwarded_unobserved")
  }

  observe(observation: ToolObservation): void {
    this.#hostForwardedAt = undefined
    const proposal = this.#relay.pendingProposal
    this.#relay.observe(observation)
    if (proposal) this.actionDispositions.set(actionKey(proposal), "host_observed")
  }

  claimMutationProgressCheck(afterActions: number): number | undefined {
    this.#observedActions += 1
    if (this.#mutationProgressChecked || this.#observedActions < afterActions) return undefined
    this.#mutationProgressChecked = true
    return this.#observedActions
  }

  steer(content: string): void {
    this.#controller.steer(content)
  }

  get progressFailure(): AttemptProgressState["failureCode"] { return this.#progress.failureCode }
  get hostRoundTripMs(): number | undefined { return this.#hostForwardedAt === undefined ? undefined : Math.max(0, Math.round(performance.now() - this.#hostForwardedAt)) }
  get modelFailure(): ModelFailureSummary | undefined { return this.#modelFailure }

  get tracksProgress(): boolean {
    return this.#progressPolicy !== undefined && !this.#closureEntered && !this.#deadline?.closing && this.#progress.failureCode === undefined
  }

  trackProgress(proposal: ToolProposal, observation: ToolObservation, artifact: DailyWorkspaceArtifactState | undefined): {
    state: AttemptProgressState; decision: ProgressDecision
  } | undefined {
    if (!this.tracksProgress) return undefined
    const workActions = this.#progress.workActions + 1
    const exhausted = (this.unitBudget !== undefined && (!this.unitBudget.hasCapacity("turns") || !this.unitBudget.hasCapacity("actions"))) || (this.#budget?.maxActions !== undefined && workActions >= this.#budget.maxActions) ||
      (this.#budget?.maxTurns !== undefined && proposal.turn >= this.#budget.maxTurns)
    let result = advanceAttemptProgress(this.#progress, {
      ...progressSignatures(proposal, observation),
      observationSucceeded: observation.ok,
      phase: this.#runtime.progressPhase(), workActions, workTurns: proposal.turn,
      workBudgetExhausted: exhausted,
      mutationExpected: this.#runtime.requiresWorkspaceArtifactBinding(),
      artifact: artifact === undefined ? "not_required" : this.#runtime.assessWorkspaceArtifactProgress(artifact),
      ...(artifact?.available ? { artifactDigest: artifact.digest } : {}),
      evidenceDigests: this.#runtime.progressEvidenceDigests(),
    }, this.#progressPolicy!)
    if (result.decision.kind === "recover" && result.decision.reason === "no_artifact_after_steer" &&
        result.state.artifact === "unchanged" && !exhausted && this.#pathCorrectionDeadline !== undefined &&
        workActions < this.#pathCorrectionDeadline && this.unitBudget?.hasCapacity("turns") &&
        this.unitBudget.hasCapacity("actions") && this.#claimPathCorrection?.()) {
      const untilWorkAction = Math.min(this.#pathCorrectionDeadline, this.#budget!.maxActions!,
        workActions + this.unitBudget.snapshot().remainingActions)
      const state = { ...result.state, pathCorrectionCount: 1, noArtifactDeadlineAction: untilWorkAction }
      delete state.failureCode
      result = { state, decision: { kind: "correct_path", reason: "workspace_boundary", untilWorkAction } }
    }
    if (result.decision.kind === "recover" && result.decision.reason === "no_artifact_after_steer" &&
        result.state.artifact === "unchanged" && !exhausted && this.#continuationActions !== undefined &&
        this.unitBudget?.hasCapacity("turns") && this.unitBudget.hasCapacity("actions") &&
        this.#claimContextContinuation?.()) {
      const untilWorkAction = Math.min(workActions + this.#continuationActions,
        this.#budget!.maxActions!, workActions + this.unitBudget.snapshot().remainingActions)
      const state = { ...result.state, contextContinuationCount: 1, noArtifactDeadlineAction: untilWorkAction }
      delete state.failureCode
      result = { state, decision: { kind: "continue_context", reason: "no_artifact_after_steer", untilWorkAction } }
    }
    this.#progress = result.state
    this.#runtime.recordProgress(result.state)
    if (exhausted) this.#closureEntered = true
    if (result.decision.kind === "steer") {
      this.steer(mutationProgressSteerPrompt(result.state.artifact === "unavailable" ? "unavailable" : "unchanged", workActions))
    } else if (result.decision.kind === "extend") {
      this.steer([
        "Chaos Harness granted one bounded investigation extension in this same Attempt.",
        `The no-artifact checkpoint is now at work action ${result.decision.untilWorkAction}; work/turn budgets are unchanged and this extension cannot renew.`,
        "New evidence or distinct successful observations were observed; this is not proof that the diagnosis is correct or the task is complete.",
        "Use your existing findings. Finish only the necessary diagnostic, then implement and validate the smallest justified in-scope fix, or state the exact blocker. Do not edit merely to satisfy the progress detector.",
      ].join("\n"))
    } else if (result.decision.kind === "continue_context") {
      const remaining = this.unitBudget!.snapshot()
      this.steer([
        "Chaos Harness permits one bounded continuation with your completed observations retained in this same Attempt.",
        `The no-artifact checkpoint is at work action ${result.decision.untilWorkAction}. Remaining Unit allowance: ${remaining.remainingTurns} model turns, ${remaining.remainingActions} charged actions, including any recovery and evidence closure.`,
        "Use the source evidence already in context to choose the smallest justified in-scope fix and validate it, or report the precise unresolved blocker. Avoid rereading material whose relevant contents are already present; reread if freshness or missing context requires it.",
        "This allowance cannot renew and does not prove correctness. Do not edit merely to satisfy the progress detector. All permissions and independent acceptance requirements remain in force.",
      ].join("\n"))
    } else if (result.decision.kind === "correct_path") {
      this.steer([
        "Chaos Harness reserved one bounded path-correction opportunity after the first rejected mutation.",
        `The no-artifact checkpoint is now at work action ${result.decision.untilWorkAction}; the Unit and Attempt hard budgets are unchanged.`,
        "Use the preflight reason and authorized workspace root to submit a corrected in-scope path. Do not broaden permissions or retry an external path. A second path rejection still stops this Attempt.",
        "This opportunity cannot renew. A successful tool call is not acceptance: validate and inspect a real artifact and satisfy the independent verifier.",
      ].join("\n"))
    } else if (result.decision.kind === "recover") {
      this.#controller.stopAfterTurn(`progress:${result.decision.reason}`)
    }
    return result
  }

  async next(): Promise<DriverEvent> {
    if (this.#terminalDelivered) {
      throw new QwenLoopBridgeError(409, "Chaos Attempt has already reached a terminal state", "attempt_terminal")
    }
    const event = await this.#queue.shift()
    if (event.type === "terminal") this.#terminalDelivered = true
    return event
  }

  close(reason: unknown): void {
    if (!this.#abort.signal.aborted) this.#abort.abort(reason)
    this.#relay.close(reason)
    this.#queue.close(reason)
    void this.#completion.catch(() => undefined)
  }

  async settledResult(): Promise<AttemptRunResult | undefined> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.#completion.catch(() => undefined),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }
}

export async function startOpenCodeQwenLoopBridge(
  options: OpenCodeQwenLoopBridgeOptions,
): Promise<OpenCodeQwenLoopBridge> {
  validateOptions(options)
  if (options.deadline && !options.attemptBudget?.evidenceClosure) throw new TypeError("Execution deadline requires bounded evidence closure")
  const selected = Object.freeze({ ...options.profile,
    ...(options.profile.access ? { access: Object.freeze({ ...options.profile.access }) } : {}),
  })
  const recorder = options.recordEvent
  const identity = Object.freeze(chatIdentity(selected))
  options = { ...options, profile: selected,
    ...(recorder ? { recordEvent: async event => recorder({ ...event, ...identity }) } : {}),
  }
  if (options.progressPolicy !== undefined) options = {
    ...options,
    progressPolicy: Object.freeze({ ...options.progressPolicy }),
    attemptBudget: {
      ...options.attemptBudget!,
      evidenceClosure: {
        ...options.attemptBudget!.evidenceClosure!,
        allowedToolNames: [...options.attemptBudget!.evidenceClosure!.allowedToolNames],
      },
    },
  }
  options = { ...options,
    ...(options.unitBudget === undefined ? {} : { unitBudget: Object.freeze({ ...options.unitBudget }) }),
    ...(options.noArtifactContinuation === undefined ? {} : { noArtifactContinuation: Object.freeze({ ...options.noArtifactContinuation }) }),
    ...(options.workspacePathRecovery === undefined ? {} : { workspacePathRecovery: Object.freeze({ ...options.workspacePathRecovery }) }),
    ...(options.deliveryReadiness === undefined ? {} : { deliveryReadiness: Object.freeze({ ...options.deliveryReadiness, probe: Object.freeze({ ...options.deliveryReadiness.probe }) }) }),
  }
  const apiKey = randomBytes(32).toString("base64url")
  const observationToken = options.observationToken ?? randomBytes(32).toString("base64url")
  const modelFactory = options.modelFactory ?? createProfileChatModel
  const workspaceArtifactProbe = options.workspaceArtifactProbe ?? {
    capture: captureGitWorkspaceArtifactState,
  }
  let active: ActiveQwenUnit | undefined
  let pending: PendingQwenUnit | undefined
  let closing = false
  let closePromise: Promise<void> | undefined
  let feedbackTarget: DailyUnitRuntime | undefined
  let feedbackAttemptId: string | undefined
  // Keep only request digests and sanitized failures, never prompts/tool output.
  // A host retry must not re-admit a terminal request or obscure its root cause.
  const terminalRequests = new Map<string, QwenLoopBridgeError>()
  const terminalRecords = new WeakMap<QwenAttemptDriver, Promise<void>>()
  const cancellations = new Map<ActiveQwenUnit, Promise<void>>()
  const lengthRecoveredUnits = new WeakSet<DailyUnitRuntime>()
  const unitBudgets = new WeakMap<DailyUnitRuntime, UnitBudget>()
  const continuedUnits = new WeakSet<DailyUnitRuntime>()
  const pathCorrectedUnits = new WeakSet<DailyUnitRuntime>()
  const readinessCheckedUnits = new WeakSet<DailyUnitRuntime>()
  const unitOptions = (runtime: DailyUnitRuntime) => {
    if (options.unitBudget === undefined) return {}
    let unitBudget = unitBudgets.get(runtime)
    if (!unitBudget) { unitBudget = new UnitBudget(options.unitBudget); unitBudgets.set(runtime, unitBudget) }
    return { unitBudget, ...(options.workspacePathRecovery === undefined ? {} : {
      pathCorrectionActions: options.workspacePathRecovery.maxAdditionalActions,
      claimPathCorrection: () => {
        if (pathCorrectedUnits.has(runtime)) return false
        pathCorrectedUnits.add(runtime)
        return true
      },
    }), ...(options.noArtifactContinuation === undefined ? {} : {
      continuationActions: options.noArtifactContinuation.maxAdditionalActions,
      claimContextContinuation: () => {
        if (continuedUnits.has(runtime)) return false
        continuedUnits.add(runtime)
        return true
      },
    }) }
  }
  const lengthRecoveryOptions = (runtime: DailyUnitRuntime) => options.modelLengthRecovery === undefined ? {} : {
    claimLengthRecovery: () => {
      if (lengthRecoveredUnits.has(runtime)) return false
      lengthRecoveredUnits.add(runtime)
      return true
    },
  }
  const recordTerminal = (current: ActiveQwenUnit, driver: QwenAttemptDriver, result: AttemptRunResult | undefined): Promise<void> => {
    feedbackAttemptId = driver.attemptId
    const existing = terminalRecords.get(driver)
    if (existing) return existing
    const recorded = Promise.resolve().then(async () => {
      const evidenceClosure = result?.events.find(event => event.type === "evidence_closure_started")
      const usageAvailable = result?.events.some(event => event.type === "model_stream_event" && event.event.type === "usage") === true
      const lastDecision = result?.events.filter(event => event.type === "model_decision").at(-1)
      // A complete protocol stream can still end without a usable model decision.
      // Persist only its terminal enum and usage, never the decision's content.
      const incomplete = result?.status === "stopped" && result.stopReason === "model_incomplete"
        ? lastDecision : undefined
      const modelTermination = incomplete?.decision.kind !== "incomplete" ? undefined : {
        finishReason: incomplete.decision.finishReason,
        turn: incomplete.turn,
        inputTokens: incomplete.decision.usage.inputTokens,
        outputTokens: incomplete.decision.usage.outputTokens,
        ...(incomplete.decision.usage.reasoningTokens === undefined ? {} : {
          reasoningTokens: incomplete.decision.usage.reasoningTokens,
        }),
      }
      const identity = { attemptId: driver.attemptId, model: options.profile.model, missionId: current.runtime.missionId,
        unitId: current.runtime.unitId, unitRevision: current.runtime.unitRevision }
      const ledger = accountActions(result, driver.actionDispositions, driver.registeredTools)
      const primaryStop = attemptStopMetadata(result, driver.progressFailure)
      for (const action of ledger.actions) await options.recordEvent?.({
        event: "action_accounted", ...identity, ...action,
        ...(action.disposition === "controller_blocked" && driver.progressFailure !== undefined ? { failureCode: driver.progressFailure } : {}),
      })
      if (evidenceClosure) await options.recordEvent?.({ event: "evidence_closure_started", ...identity,
        closureTrigger: evidenceClosure.trigger, workTurns: evidenceClosure.workTurns, workActions: evidenceClosure.workActions })
      await options.recordEvent?.({ event: "attempt_finished", ...identity,
        terminalState: result?.status ?? "aborted", usageAvailable,
        ...(result === undefined ? {} : { actionAccounting: ledger.accounting }),
        ...(primaryStop === undefined ? {} : { primaryStop }),
        ...(driver.unitBudget === undefined ? {} : { unitBudget: driver.unitBudget.snapshot() }),
        ...(driver.modelFailure ? { modelFailure: driver.modelFailure } : {}),
        ...(modelTermination ? { modelTermination } : {}),
        ...(result?.status === "completion_proposed" ? {} : { stopReason: result?.stopReason ?? "aborted" }),
        ...(result === undefined ? {} : { turns: result.usage.turns, actions: result.usage.actions }),
        ...(!result || !usageAvailable ? {} : {
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          ...(result.usage.reasoningTokens === undefined ? {} : { reasoningTokens: result.usage.reasoningTokens }),
          ...(result.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: result.usage.cacheReadTokens }),
          ...(result.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: result.usage.cacheWriteTokens }),
        }),
      })
    })
    terminalRecords.set(driver, recorded)
    return recorded
  }
  const cancelActive = (current: ActiveQwenUnit, reason: DailyCancellationReason): Promise<void> => {
    const existing = cancellations.get(current)
    if (existing) return existing
    current.lifetime.abort(new Error(reason))
    const driver = current.driver
    driver.close(new Error(reason))
    if (active === current) active = undefined
    const cancelled = Promise.resolve().then(async () => {
      await recordTerminal(current, driver, await driver.settledResult())
      await recordJournalEvents(options.recordEvent, current.runtime.cancel(reason))
    })
    cancellations.set(current, cancelled)
    // Retain the promise for close() to observe failures, without an unhandled rejection.
    void cancelled.catch(() => undefined)
    return cancelled
  }
  const assertCurrentLifetime = (current: ActiveQwenUnit): void => {
    if (options.deadline?.expired) throw new QwenLoopBridgeError(409, "Execution deadline exceeded", "deadline_exceeded")
    current.lifetime.signal.throwIfAborted()
  }
  const deadlineReached = (): void => {
    if (active) void cancelActive(active, "deadline_exceeded")
  }
  const recordFeedback = async (feedback: LocalFeedback): Promise<void> => {
    const runtime = active?.runtime ?? pending?.runtime ?? feedbackTarget
    const attemptId = active?.driver.attemptId ?? feedbackAttemptId
    await options.recordEvent?.({ event: "feedback_recorded", ...feedback,
      ...(runtime && attemptId ? { attemptId } : {}),
      ...(runtime ? { binding: "mission", missionId: runtime.missionId, unitId: runtime.unitId, unitRevision: runtime.unitRevision }
        : { binding: "unbound" }),
    })
  }

  const server = createServer(async (request, response) => {
    let completionStream: CompletionStreamState | undefined
    let requestUnit: ActiveQwenUnit | undefined
    try {
      requireAuthorization(request, apiKey)
      if (closing) throw new QwenLoopBridgeError(503, "Chaos bridge is closing", "bridge_closing")
      const url = new URL(request.url ?? "/", `http://${QWEN_LOOP_BRIDGE_HOST}`)
      if (request.method === "POST" && url.pathname === "/v1/feedback") {
        let feedback: LocalFeedback
        try { feedback = parseFeedbackSubmission(await readJsonBody(request, 1_024)) }
        catch { throw new QwenLoopBridgeError(400, "Expected a feedback score from 0 to 3", "invalid_feedback") }
        await recordFeedback(feedback)
        sendJson(response, 200, { recorded: true })
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [modelDescriptor(QWEN_LOOP_MODEL_ID), modelDescriptor(QWEN_LOOP_METADATA_MODEL_ID)],
        })
        return
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        throw new QwenLoopBridgeError(404, "Route not found", "route_not_found")
      }
      if (options.deadline?.expired) throw new QwenLoopBridgeError(409, "Execution deadline exceeded", "deadline_exceeded")
      const chat = parseChatRequest(await readJsonBody(
        request,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ))
      if (chat.model === QWEN_LOOP_METADATA_MODEL_ID) {
        sendTextCompletion(response, chat, metadataTitle(chat.messages), zeroUsage())
        return
      }
      if (chat.model !== QWEN_LOOP_MODEL_ID) {
        throw new QwenLoopBridgeError(400, "Unknown bridge model", "unknown_model")
      }

      const wireObservation = findLatestToolObservation(chat.messages)
      const latestUser = [...chat.messages].reverse().find(message => message.role === "user")
      const feedback = wireObservation === undefined ? parseLocalFeedback(readContentText(latestUser?.content)) : undefined
      if (feedback) {
        await recordFeedback(feedback)
        sendTextCompletion(response, chat, feedbackAcknowledgement(feedback), zeroUsage())
        return
      }
      if (wireObservation === undefined && /^\/chaos-feedback(?:\s|$)/.test(readContentText(latestUser?.content).trim())) {
        throw new QwenLoopBridgeError(400, "Feedback score must be 0, 1, 2, or 3", "invalid_feedback")
      }
      const requestProfile = bindHostClient(options.profile, request)
      const requestDigest = await sha256(JSON.stringify([requestProfile.hostUserAgent, chat]))
      const terminalError = terminalRequests.get(requestDigest)
      if (terminalError) throw terminalError
      const boundProfile = active?.modelProfile ?? pending?.modelProfile
      if (boundProfile && boundProfile.hostUserAgent !== requestProfile.hostUserAgent) {
        throw new QwenLoopBridgeError(409, "Host client identity changed during the current Unit", "host_identity_changed")
      }
      if (active === undefined) {
        await Promise.all(cancellations.values())
        if (closing || request.aborted || response.destroyed) return
        if (active !== undefined) throw new QwenLoopBridgeError(409, "Chaos Attempt is already active", "attempt_busy")
        if (wireObservation !== undefined) {
          throw new QwenLoopBridgeError(409, "Tool observation has no active Chaos Attempt", "observation_without_attempt")
        }
        if (chat.tools.length === 0) {
          throw new QwenLoopBridgeError(400, "OpenCode did not provide any host tools", "missing_tools")
        }
        const attemptId = nextAttemptId(options.createAttemptId)
        const goal = projectConversation(chat.messages, options.maxProjectionChars ?? DEFAULT_MAX_PROJECTION_CHARS)
        let runtime: DailyUnitRuntime
        if (pending !== undefined) {
          runtime = pending.runtime
        } else {
          const mutationExpected = inferDailyMutationIntent(goal)
          let artifactBaseline: DailyWorkspaceArtifactState | undefined
          if (mutationExpected) {
            try {
              artifactBaseline = await workspaceArtifactProbe.capture(options.workspaceRoot)
            } catch (error) {
              const detail = error instanceof GitArtifactStateError && error.reason === "untracked_bytes_limit"
                ? " Untracked file content exceeds the 32 MiB capture limit."
                : error instanceof GitArtifactStateError && error.reason === "changed_path_limit"
                  ? " Changed paths exceed the 4096-path capture limit."
                  : ""
              throw new QwenLoopBridgeError(
                500,
                `Chaos Harness could not bind the initial Git workspace artifact state.${detail}`,
                "artifact_baseline_unavailable",
              )
            }
            if (!artifactBaseline.available) {
              throw new QwenLoopBridgeError(
                500,
                "Chaos Harness could not bind the initial Git workspace artifact state",
                "artifact_baseline_unavailable",
              )
            }
          }
          if (closing || request.aborted || response.destroyed) return
          if (active !== undefined) throw new QwenLoopBridgeError(409, "Chaos Attempt is already active", "attempt_busy")
          runtime = new DailyUnitRuntime({
            workspaceRoot: options.workspaceRoot,
            goal,
            seed: attemptId,
            mutationExpected,
            externalVerificationRequired: options.completionVerifier !== undefined,
            progressControlEnabled: options.progressPolicy !== undefined,
            ...(options.attemptBudget === undefined ? {} : { recoveryBudget: options.attemptBudget }),
            ...(artifactBaseline === undefined ? {} : { artifactBaseline }),
          })
        }
        const attemptStart = pending === undefined
          ? runtime.beginAttempt(attemptId)
          : runtime.resumeAfterUserCheckpoint(attemptId, goal)
        const modelProfile = pending?.modelProfile ?? requestProfile
        pending = undefined
        active = {
          modelProfile,
          lifetime: new AbortController(),
          runtime,
          goal,
          tools: chat.tools,
          driver: new QwenAttemptDriver({
            attempt: attemptStart.attempt,
            model: modelFactory(modelProfile),
            goal,
            tools: chat.tools,
            workspaceRoot: options.workspaceRoot,
            runtime,
            ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
            ...lengthRecoveryOptions(runtime),
            ...unitOptions(runtime),
            ...(options.workspaceBoundary === undefined ? {} : { workspaceBoundary: options.workspaceBoundary }),
            ...(options.recordEvent === undefined ? {} : { recordEvent: options.recordEvent }),
            modelName: options.profile.model,
            ...(options.progressPolicy === undefined ? {} : { progressPolicy: options.progressPolicy }),
            ...(attemptStart.strategy === undefined ? {} : { strategy: attemptStart.strategy }),
            ...(attemptStart.recoveryPrompt === undefined ? {} : { recoveryPrompt: attemptStart.recoveryPrompt }),
            ...(options.attemptBudget === undefined
              ? {}
              : { budget: options.attemptBudget }),
          }),
        }
        requestUnit = active
        feedbackTarget = runtime
        await recordJournalEvents(options.recordEvent, attemptStart.journalEvents)
        await options.recordEvent?.({
          event: "attempt_started",
          attemptId,
          model: options.profile.model,
          missionId: runtime.missionId,
          unitId: runtime.unitId,
          unitRevision: runtime.unitRevision,
          goalSha256: await sha256(goal),
          toolCount: chat.tools.length,
        })
      } else {
        if (wireObservation === undefined) {
          throw new QwenLoopBridgeError(409, "Chaos Attempt is waiting for its OpenCode tool observation", "attempt_busy")
        }
        if (wireObservation.toolCallId !== active.driver.pendingCallId) {
          throw new QwenLoopBridgeError(409, "Tool observation does not match the pending Chaos Action", "observation_mismatch")
        }
        const observation = toKernelObservation(
          wireObservation,
          active.driver.pendingToolName ?? "unknown",
          options.maxToolObservationChars ?? DEFAULT_MAX_TOOL_OBSERVATION_CHARS,
          observationToken,
        )
        const proposal = active.driver.pendingProposal
        if (proposal === undefined) {
          throw new QwenLoopBridgeError(409, "No Chaos Action is waiting for an observation", "observation_without_action")
        }
        const observationReceivedAt = performance.now()
        const hostRoundTripMs = active.driver.hostRoundTripMs
        await options.recordEvent?.({ event: "host_observation_received", attemptId: active.driver.attemptId,
          model: options.profile.model, missionId: active.runtime.missionId, unitId: active.runtime.unitId,
          unitRevision: active.runtime.unitRevision, turn: proposal.turn, action: proposal.call.name,
          ...(hostRoundTripMs === undefined ? {} : { hostRoundTripMs }),
        })
        let mutationProgress: {
          workActions: number
          artifactProgress: DailyWorkspaceArtifactProgress
          intervention: "none" | "steer"
        } | undefined
        if (
          options.mutationProgressSteer !== undefined &&
          active.runtime.requiresWorkspaceArtifactBinding()
        ) {
          const workActions = active.driver.claimMutationProgressCheck(
            options.mutationProgressSteer.afterActions,
          )
          if (workActions !== undefined) {
            let artifactProgress: DailyWorkspaceArtifactProgress
            try {
              artifactProgress = active.runtime.assessWorkspaceArtifactProgress(
                await workspaceArtifactProbe.capture(options.workspaceRoot),
              )
            } catch {
              artifactProgress = "unavailable"
            }
            let intervention: "none" | "steer" = "none"
            if (artifactProgress === "unchanged" || artifactProgress === "unavailable") {
              intervention = "steer"
              active.driver.steer(mutationProgressSteerPrompt(artifactProgress, workActions))
            }
            mutationProgress = { workActions, artifactProgress, intervention }
          }
        }
        active.runtime.recordAction(proposal, observation)
        let trajectory: ReturnType<QwenAttemptDriver["trackProgress"]>
        if (active.driver.tracksProgress) {
          let artifact: DailyWorkspaceArtifactState | undefined
          if (active.runtime.requiresWorkspaceArtifactBinding()) {
            try { artifact = await workspaceArtifactProbe.capture(options.workspaceRoot) }
            catch { artifact = { available: false } }
            active.runtime.recordWorkspaceArtifactState(artifact)
          }
          // Hash the full authenticated observation, not its model-context truncation.
          // A shared prefix in large outputs must not manufacture a repeated cycle.
          trajectory = active.driver.trackProgress(proposal,
            toKernelObservation(wireObservation, proposal.call.name, Number.MAX_SAFE_INTEGER, observationToken), artifact)
        }
        const readiness = options.deliveryReadiness
        if (readiness !== undefined && trajectory !== undefined &&
            trajectory.state.artifact === "advanced" && trajectory.state.workActions >= readiness.afterActions &&
            active.driver.tracksProgress && active.driver.unitBudget?.hasCapacity("turns") &&
            active.driver.unitBudget.hasCapacity("actions") && !readinessCheckedUnits.has(active.runtime)) {
          readinessCheckedUnits.add(active.runtime)
          const started = performance.now()
          const verdict = await runCompletionVerifier(readiness.probe, {
            missionId: active.runtime.missionId, unitId: active.runtime.unitId, unitRevision: active.runtime.unitRevision,
            attemptId: active.driver.attemptId, workspaceRoot: options.workspaceRoot, goal: active.goal, completion: "",
          }, readiness.timeoutMs ?? 5_000, active.lifetime.signal)
          active.lifetime.signal.throwIfAborted()
          await options.recordEvent?.({ event: "delivery_readiness_checked", attemptId: active.driver.attemptId,
            model: options.profile.model, missionId: active.runtime.missionId, unitId: active.runtime.unitId,
            unitRevision: active.runtime.unitRevision, turn: proposal.turn, workActions: trajectory.state.workActions,
            readiness: { passed: verdict.passed === true, elapsedMs: Math.max(0, Math.round(performance.now() - started)) },
          })
          if (verdict.passed !== true) active.driver.steer([
            "Chaos Harness early delivery check found an unresolved public-task requirement or could not verify readiness.",
            "Address the remaining delivery gaps within the current work budget. Preserve pre-existing user changes. This feedback does not authorize extra scope or relax any permission.",
            typeof verdict.guidance === "string" ? verdict.guidance.slice(0, 4_000) : "Review the public task requirements, changed-file scope and regression tests.",
            "This check is not completion acceptance. After any repair, run validation, inspect the final diff and close the plan before proposing completion for independent verification.",
          ].join("\n"))
        }
        // Record state and queue controls before releasing the tool promise to the Loop.
        active.driver.observe(observation)
        await options.recordEvent?.({
          event: "action_observed",
          attemptId: active.driver.attemptId,
          model: options.profile.model,
          missionId: active.runtime.missionId,
          unitId: active.runtime.unitId,
          unitRevision: active.runtime.unitRevision,
          action: observation.toolName,
          ok: observation.ok,
          observationProcessingMs: Math.max(0, Math.round(performance.now() - observationReceivedAt)),
        })
        if (mutationProgress !== undefined) {
          await options.recordEvent?.({
            event: "mutation_progress_checked",
            attemptId: active.driver.attemptId,
            model: options.profile.model,
            missionId: active.runtime.missionId,
            unitId: active.runtime.unitId,
            unitRevision: active.runtime.unitRevision,
            workActions: mutationProgress.workActions,
            artifactProgress: mutationProgress.artifactProgress,
            intervention: mutationProgress.intervention,
          })
        }
        if (trajectory !== undefined) {
          const summary = {
            attemptId: active.driver.attemptId, model: options.profile.model,
            missionId: active.runtime.missionId, unitId: active.runtime.unitId, unitRevision: active.runtime.unitRevision,
            phase: trajectory.state.phase, progressLevel: trajectory.state.level,
            workTurns: trajectory.state.workTurns, workActions: trajectory.state.workActions,
            artifactProgress: trajectory.state.artifact, strategyId: active.driver.strategy,
            controlDecision: trajectory.decision.kind,
            investigationExtensionCount: trajectory.state.investigationExtensionCount,
            contextContinuationCount: trajectory.state.contextContinuationCount,
            pathCorrectionCount: trajectory.state.pathCorrectionCount,
            ...(active.driver.unitBudget === undefined ? {} : { unitBudget: active.driver.unitBudget.snapshot() }),
            ...(trajectory.state.noArtifactDeadlineAction === undefined ? {} : { noArtifactDeadlineAction: trajectory.state.noArtifactDeadlineAction }),
            ...(trajectory.decision.kind === "extend" ? { extensionReason: trajectory.decision.reason } : {}),
            ...(trajectory.state.failureCode === undefined ? {} : { failureCode: trajectory.state.failureCode }),
          }
          await options.recordEvent?.({ event: "attempt_progress_observed", ...summary })
          if (trajectory.decision.kind === "recover") await options.recordEvent?.({ event: "attempt_stuck_detected", ...summary })
          if (trajectory.decision.kind !== "continue") await options.recordEvent?.({ event: "attempt_control_decided", ...summary })
        }
      }

      const current = active
      requestUnit = current
      const disconnect = (): void => {
        void cancelActive(current, "request_disconnected")
      }
      request.once("aborted", disconnect)
      response.once("close", () => {
        if (!response.writableEnded) disconnect()
      })
      let event: DriverToolCall | DriverTerminal
      let completionDecision: DailyRuntimeCompletionDecision | undefined
      const bufferedReasoning: string[] = []
      let turnUsage: ModelUsage | undefined
      try {
        while (true) {
          const next = await current.driver.next()
          if (next.type !== "reasoning_delta") {
            if (next.type === "usage") {
              turnUsage = sumModelUsage(turnUsage, next.usage)
              continue
            }
            if (next.type === "tool_call") {
              event = next
              break
            }

            await recordTerminal(current, current.driver, next.result)
            assertCurrentLifetime(current)
            const progressInterrupted = next.result.status === "stopped" && next.result.stopReason === "stop_after_turn" && current.driver.progressFailure !== undefined
            if (next.result.status !== "completion_proposed" && !progressInterrupted) {
              event = next
              break
            }

            if (current.runtime.requiresWorkspaceArtifactBinding()) {
              try {
                current.runtime.recordWorkspaceArtifactState(
                  await workspaceArtifactProbe.capture(options.workspaceRoot),
                )
              } catch {
                current.runtime.recordWorkspaceArtifactState({ available: false })
              }
            }

            assertCurrentLifetime(current)
            const externalVerification =
              options.completionVerifier === undefined ||
              progressInterrupted ||
              !current.runtime.isReadyForExternalVerification(options.completionVerificationOrder)
              ? undefined
              : await runCompletionVerifier(
                  options.completionVerifier,
                  {
                    missionId: current.runtime.missionId,
                    unitId: current.runtime.unitId,
                    unitRevision: current.runtime.unitRevision,
                    attemptId: next.attemptId,
                    workspaceRoot: options.workspaceRoot,
                    goal: current.goal,
                    completion: next.result.status === "completion_proposed" ? next.result.completion : "",
                },
                  options.completionVerifierTimeoutMs ?? DEFAULT_COMPLETION_VERIFIER_TIMEOUT_MS,
                  current.lifetime.signal,
                )
            assertCurrentLifetime(current)
            completionDecision = current.runtime.completeAttempt(
              next.attemptId,
              () => nextAttemptId(options.createAttemptId),
              externalVerification,
              new Date().toISOString(),
              progressInterrupted,
            )
            await recordJournalEvents(options.recordEvent, completionDecision.journalEvents)
            assertCurrentLifetime(current)
            if (completionDecision.outcome !== "restart_required") {
              event = next
              break
            }

            const recovery = completionDecision.recovery!
            current.driver = new QwenAttemptDriver({
              attempt: recovery.attempt,
              model: modelFactory(current.modelProfile),
              goal: current.goal,
              tools: current.tools,
              workspaceRoot: options.workspaceRoot,
              runtime: current.runtime,
              ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
              ...lengthRecoveryOptions(current.runtime),
              ...unitOptions(current.runtime),
              ...(options.workspaceBoundary === undefined ? {} : { workspaceBoundary: options.workspaceBoundary }),
              ...(options.recordEvent === undefined ? {} : { recordEvent: options.recordEvent }),
              modelName: options.profile.model,
              ...(options.progressPolicy === undefined ? {} : { progressPolicy: options.progressPolicy }),
              ...(recovery.strategy === undefined ? {} : { strategy: recovery.strategy }),
              ...(options.attemptBudget === undefined
                ? {}
                : { budget: options.attemptBudget }),
              ...(recovery.recoveryPrompt === undefined
                ? {}
                : { recoveryPrompt: recovery.recoveryPrompt }),
            })
            await options.recordEvent?.({
              event: "attempt_started",
              attemptId: recovery.attempt.attemptId,
              model: options.profile.model,
              missionId: current.runtime.missionId,
              unitId: current.runtime.unitId,
              unitRevision: current.runtime.unitRevision,
              goalSha256: await sha256(current.goal),
              toolCount: current.tools.length,
            })
            continue
          }
          if (chat.stream) {
            completionStream ??= startCompletionStream(response, chat.model)
            writeReasoningDelta(response, completionStream, next.delta)
          } else {
            bufferedReasoning.push(next.delta)
          }
        }
      } finally {
        request.off("aborted", disconnect)
      }
      if (response.destroyed) {
        if (active === current) active = undefined
        return
      }
      if (event.type === "tool_call") {
        await options.recordEvent?.({
          event: "action_proposed",
          attemptId: event.attemptId,
          model: options.profile.model,
          missionId: current.runtime.missionId,
          unitId: current.runtime.unitId,
          unitRevision: current.runtime.unitRevision,
          turn: event.turn,
          action: event.call.name,
        })
        assertCurrentLifetime(current)
        sendToolCall(
          response,
          chat,
          event.call,
          toWireUsage(turnUsage),
          bufferedReasoning.join(""),
          completionStream,
        )
        current.driver.markHostForwarded()
        return
      }

      const primaryStop = attemptStopMetadata(event.result, current.driver.progressFailure)
      pending = completionDecision?.outcome === "verification_pending"
        ? { runtime: current.runtime, goal: current.goal, tools: current.tools, modelProfile: current.modelProfile,
            ...(primaryStop === undefined ? {} : { primaryStop }) }
        : undefined
      active = undefined
      if (event.result.status === "stopped" && event.result.stopReason === "stop_after_turn" && completionDecision?.outcome === "verification_pending") {
        sendTextCompletion(response, chat,
          verificationPendingCompletion("Harness interrupted the unproductive strategy. The Agent did not propose completion.", completionDecision.failedRequirements),
          toWireUsage(turnUsage), bufferedReasoning.join(""), completionStream)
        return
      }
      if (event.result.status !== "completion_proposed") {
        await recordJournalEvents(options.recordEvent, current.runtime.cancel("attempt_stopped"))
        const failure = new QwenLoopBridgeError(
          event.result.status === "aborted" ? 499 : 422,
          `Chaos Attempt stopped: ${event.result.stopReason}${modelFailureDescription(current.driver.modelFailure)}`,
          `attempt_${event.result.stopReason}`,
        )
        terminalRequests.set(requestDigest, failure)
        if (terminalRequests.size > 64) terminalRequests.delete(terminalRequests.keys().next().value!)
        throw failure
      }
      sendTextCompletion(
        response,
        chat,
        completionDecision?.outcome === "verification_pending"
          ? verificationPendingCompletion(event.result.completion, completionDecision.failedRequirements)
          : event.result.completion,
        toWireUsage(turnUsage),
        bufferedReasoning.join(""),
        completionStream,
      )
    } catch (error) {
      if (requestUnit && !cancellations.has(requestUnit)) await cancelActive(requestUnit, options.deadline?.expired ? "deadline_exceeded" : "bridge_error")
      if (response.destroyed || response.writableEnded) return
      const statusCode = error instanceof QwenLoopBridgeError ? error.statusCode : 500
      const message = error instanceof QwenLoopBridgeError ? error.message : "Chaos Qwen Loop bridge failed"
      const code = error instanceof QwenLoopBridgeError ? error.code : "bridge_failure"
      if (response.headersSent) {
        writeSse(response, { error: { message, type: "chaos_harness_error", code } })
        response.end("data: [DONE]\n\n")
      } else {
        sendError(response, statusCode, message, code)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, QWEN_LOOP_BRIDGE_HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  options.deadline?.signal.addEventListener("abort", deadlineReached, { once: true })
  return {
    baseUrl: `http://${QWEN_LOOP_BRIDGE_HOST}:${address.port}/v1`,
    apiKey,
    observationToken,
    close(terminalObservations = []) {
      closePromise ??= (async () => {
        closing = true
        try {
          const proposal = active?.driver.pendingProposal
          if (active && proposal && active.driver.actionDispositions.get(actionKey(proposal)) === "host_forwarded_unobserved") {
            for (const encoded of terminalObservations.slice(0, MAX_TERMINAL_OBSERVATIONS)) {
              if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_TERMINAL_OBSERVATION_BYTES) continue
              let observation: { ok: boolean; content: string } | undefined
              try { observation = decodeOpenCodeToolObservation(encoded, observationToken, proposal.call.toolCallId) } catch { continue }
              if (!observation || observation.ok || ![HOST_PERMISSION_REJECTED, HOST_TOOL_ERROR].includes(observation.content)) continue
              await options.recordEvent?.({ event: "host_terminal_observation_received", attemptId: active.driver.attemptId,
                model: options.profile.model, missionId: active.runtime.missionId, unitId: active.runtime.unitId,
                unitRevision: active.runtime.unitRevision, turn: proposal.turn, action: proposal.call.name, ok: false,
                hostTerminalError: observation.content as typeof HOST_PERMISSION_REJECTED | typeof HOST_TOOL_ERROR })
              // Deliberately do not resolve the relay: Host termination cannot start another model turn.
              break
            }
          }
          if (active) await cancelActive(active, options.deadline?.expired ? "deadline_exceeded" : "host_exit")
          if (pending) {
            for (const event of pending.runtime.cancel(options.deadline?.expired ? "deadline_exceeded" : "host_exit")) {
              await options.recordEvent?.({ ...event,
                ...(event.event === "mission_finished" ? {
                  cleanupReason: "host_exit" as const,
                  ...(pending.primaryStop === undefined ? {} : { primaryStop: pending.primaryStop }),
                } : {}),
              })
            }
            pending = undefined
          }
          await Promise.all(cancellations.values())
        } finally {
          options.deadline?.signal.removeEventListener("abort", deadlineReached)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error))
            server.closeAllConnections()
          })
        }
      })()
      return closePromise
    },
  }
}

export function createOpenCodeQwenLoopConfig(
  baseUrl: string,
  apiKey: string,
  observationPluginPath?: string,
  profile?: QwenProfile,
): OpenCodeQwenLoopConfig {
  return {
    model: QWEN_LOOP_MODEL,
    small_model: QWEN_LOOP_SMALL_MODEL,
    enabled_providers: [QWEN_LOOP_PROVIDER],
    ...(observationPluginPath === undefined ? {} : { plugin: [observationPluginPath] as const }),
    autoupdate: false,
    share: "disabled",
    command: { "chaos-feedback": { template: "/chaos-feedback $ARGUMENTS", description: "本地反馈：1 差 / 2 一般 / 3 好 / 0 跳过，不调用模型" } },
    provider: {
      [QWEN_LOOP_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: profile ? `Chaos Harness / ${profile.access?.provider ?? "dashscope"}` : "Chaos Harness / Qwen Loop",
        options: { baseURL: baseUrl, apiKey },
        models: {
          [QWEN_LOOP_MODEL_ID]: {
            name: profile ? `${profile.access?.displayName ?? profile.model} / Chaos Harness` : "Qwen Code Agent controlled by Chaos Harness",
            tool_call: true,
            limit: { context: profile?.access?.contextTokens ?? 1_000_000, output: profile?.access?.maxOutputTokens ?? 32_768 },
          },
          [QWEN_LOOP_METADATA_MODEL_ID]: {
            name: "Chaos Harness Local Metadata",
            tool_call: false,
            limit: { context: 16_000, output: 128 },
          },
        },
      },
    },
  }
}

function nextAttemptId(factory?: () => string): string {
  const attemptId = factory?.() ?? `qwen-attempt-${randomUUID()}`
  if (typeof attemptId !== "string" || attemptId.trim().length === 0) {
    throw new QwenLoopBridgeError(500, "Chaos Attempt id factory returned an invalid id", "invalid_attempt_id")
  }
  return attemptId
}

function mutationProgressSteerPrompt(
  progress: Exclude<DailyWorkspaceArtifactProgress, "advanced" | "not_required">,
  workActions: number,
): string {
  const observation = progress === "unavailable"
    ? "Chaos Harness could not verify a durable workspace artifact at this checkpoint."
    : "Chaos Harness found no durable workspace artifact relative to the admitted Unit baseline."
  return [
    `Chaos Harness mutation progress intervention after ${String(workActions)} work actions.`,
    observation,
    "Stop expanding read-only investigation. If the diagnosis is sufficient, implement the smallest task-scoped change now, then validate and inspect it.",
    "If implementation is genuinely blocked, state the exact blocker instead of claiming completion.",
  ].join("\n")
}

async function recordJournalEvents(
  recorder: OpenCodeQwenLoopBridgeOptions["recordEvent"],
  events: readonly DailyRuntimeJournalEvent[],
): Promise<void> {
  if (recorder === undefined) return
  for (const event of events) await recorder(event)
}

function verificationPendingCompletion(
  completion: string,
  failedRequirements: readonly string[],
): string {
  return [
    "CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE.",
    "The Agent used its automatic clean recovery, but the completion evidence still failed:",
    ...failedRequirements.map((requirement) => `- ${requirement}`),
    "",
    "The next user message can add checkpoint direction and continue this same ChaosUnit. Do not rerun the launcher to bypass this checkpoint.",
    "",
    "Agent completion proposal (not accepted):",
    completion.trim(),
  ].join("\n")
}

function qwenSystemPrompt(workspaceRoot: string, boundary?: "root-only"): string {
  return [
    "You are the coding model inside the Chaos Harness NativeAttemptEngine.",
    `The exact Git worktree root for this Attempt is ${JSON.stringify(workspaceRoot)}.`,
    "Resolve relative workspace paths against that root and do not guess or reuse a path from another checkout.",
    ...(boundary === "root-only" ? [
      "This task is restricted to the workspace. Reproductions, temporary consumers and generated files must also stay inside the user's permitted task scope, including paths inside shell commands; a valid workdir does not authorize external paths.",
      "Use a task-local temporary directory if needed, not /tmp, /var/tmp, a system temporary directory or a sibling checkout. Preserve regression tests and user changes; remove only temporary files you created for this task before final validation and inspection.",
      "A native permission rejection stops this run. Do not retry the rejected action or seek another route around the permission boundary.",
    ] : []),
    "Use the OpenCode host tools supplied for this Attempt to inspect, edit, validate, and review the workspace.",
    "Keep work narrowly scoped to the user's current goal.",
    "Do not claim a tool ran unless its observation says it succeeded.",
    "Before proposing completion after a mutation, run relevant validation and inspect the resulting changes.",
    "If Chaos Harness announces evidence closure, stop mutating the workspace and use only the remaining validation, inspection, read-only, and todowrite tools.",
    "Treat final output as a completion proposal: Chaos Harness will verify the evidence and may start a clean recovery Attempt.",
    "If you use todowrite, close or explicitly cancel every item before proposing completion.",
    "Do not commit, push, deploy, perform external writes, or expand scope unless the user explicitly requested it.",
  ].join("\n")
}

function validateOptions(options: OpenCodeQwenLoopBridgeOptions): void {
  if (options.deliveryReadiness !== undefined) {
    const { afterActions, timeoutMs, probe } = options.deliveryReadiness
    if (!Number.isSafeInteger(afterActions) || afterActions < 1 ||
        afterActions >= (options.attemptBudget?.maxActions ?? 0) ||
        !options.progressPolicy || !options.unitBudget ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(probe.id) ||
        (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))) {
      throw new TypeError("Delivery readiness requires a bounded work checkpoint, named probe, progress policy and Unit budget")
    }
  }
  if (options.workspacePathRecovery !== undefined) {
    const additional = options.workspacePathRecovery.maxAdditionalActions
    if (!Number.isSafeInteger(additional) || additional < 1 ||
        !Number.isSafeInteger(additional + (options.attemptBudget?.maxActions ?? 0)) ||
        options.workspaceBoundary !== "root-only" || !options.unitBudget || !options.progressPolicy) {
      throw new TypeError("Path correction requires positive safe actions, root-only boundary, progress policy and explicit Unit budget")
    }
  }
  if (options.completionVerificationOrder !== undefined &&
      (options.completionVerificationOrder !== "artifact-first" || !options.completionVerifier || !options.progressPolicy)) {
    throw new TypeError("Artifact-first verification requires a completion verifier and progress policy")
  }
  if (options.unitBudget !== undefined) new UnitBudget(options.unitBudget)
  if (options.noArtifactContinuation !== undefined) {
    const additional = options.noArtifactContinuation.maxAdditionalActions
    if (!Number.isSafeInteger(additional) || additional < 1 ||
        !Number.isSafeInteger(additional + (options.attemptBudget?.maxActions ?? 0))) {
      throw new TypeError("Context continuation requires positive safe additional actions")
    }
    if (!options.unitBudget || !options.progressPolicy) throw new TypeError("Context continuation requires explicit Unit budget and progress policy")
  }
  if (options.modelLengthRecovery !== undefined && (options.modelLengthRecovery !== "once-per-unit" ||
      options.attemptBudget?.maxTurns === undefined || options.attemptBudget?.maxActions === undefined)) {
    throw new TypeError("Model length recovery requires once-per-unit and bounded turns/actions")
  }
  if (options.workspaceBoundary !== undefined && options.workspaceBoundary !== "root-only") throw new TypeError("Unknown workspace boundary policy")
  if (options.workspaceRoot.trim().length === 0) throw new TypeError("Bridge workspace root must not be empty")
  if (options.profile.apiKey.trim().length === 0) throw new TypeError("Qwen API key must not be empty")
  if (options.profile.model.trim().length === 0) throw new TypeError("Qwen model must not be empty")
  if (options.observationToken !== undefined && options.observationToken.trim().length < 32) {
    throw new TypeError("Bridge observation token must contain at least 32 characters")
  }
  if (
    options.completionVerifier !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.completionVerifier.id)
  ) {
    throw new TypeError("Completion verifier id must be a plain non-empty identifier")
  }
  if (
    options.completionVerifierTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.completionVerifierTimeoutMs) || options.completionVerifierTimeoutMs < 1)
  ) {
    throw new TypeError("Completion verifier timeout must be a positive integer")
  }
  validateAttemptBudget(options.attemptBudget)
  validateMutationProgressSteer(options.mutationProgressSteer, options.attemptBudget)
  if (options.progressPolicy !== undefined) {
    validateProgressPolicy(options.progressPolicy)
    if (options.mutationProgressSteer !== undefined) throw new TypeError("P7 steer and P8 progress policy must not be composed together")
    const maxActions = options.attemptBudget?.maxActions
    if (maxActions === undefined || options.attemptBudget?.maxTurns === undefined || options.attemptBudget.evidenceClosure === undefined ||
      options.progressPolicy.explorationSoftLimit + options.progressPolicy.postSteerGraceActions +
        (options.progressPolicy.investigationExtensionActions ?? 0) >= maxActions) {
      throw new TypeError("Progress policy requires bounded task work/closure budgets and a grace window before the action guard")
    }
  }
  if (options.maxBodyBytes !== undefined && (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)) {
    throw new TypeError("Bridge max body bytes must be a positive integer")
  }
}

function validateMutationProgressSteer(
  policy: QwenMutationProgressSteerPolicy | undefined,
  budget: LoopBudget | undefined,
): void {
  if (policy === undefined) return
  if (!Number.isSafeInteger(policy.afterActions) || policy.afterActions < 1) {
    throw new TypeError("Mutation progress steer afterActions must be a positive integer")
  }
  if (budget?.maxActions === undefined) {
    throw new TypeError("Mutation progress steer requires a task-bound maxActions budget")
  }
  if (policy.afterActions >= budget.maxActions) {
    throw new TypeError("Mutation progress steer must run before the task-bound maxActions guard")
  }
}

function validateAttemptBudget(budget: LoopBudget | undefined): void {
  if (budget === undefined) return
  for (const [name, value] of [
    ["maxTurns", budget.maxTurns],
    ["maxActions", budget.maxActions],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError(`Attempt budget ${name} must be a positive integer`)
    }
  }
  if (budget.maxCost !== undefined && (!Number.isFinite(budget.maxCost) || budget.maxCost < 0)) {
    throw new TypeError("Attempt budget maxCost must be a non-negative finite number")
  }
  if (budget.evidenceClosure !== undefined) {
    if (budget.maxTurns === undefined && budget.maxActions === undefined) {
      throw new TypeError("Attempt budget evidenceClosure requires maxTurns or maxActions")
    }
    for (const [name, value] of [
      ["evidenceClosure.maxTurns", budget.evidenceClosure.maxTurns],
      ["evidenceClosure.maxActions", budget.evidenceClosure.maxActions],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Attempt budget ${name} must be a positive integer`)
      }
    }
    if (
      budget.evidenceClosure.allowedToolNames.length === 0 ||
      budget.evidenceClosure.allowedToolNames.some(
        (name) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name),
      )
    ) {
      throw new TypeError("Attempt budget evidenceClosure.allowedToolNames must contain plain tool names")
    }
  }
}

async function runCompletionVerifier(
  verifier: QwenCompletionVerifier,
  context: Omit<QwenCompletionVerifierContext, "signal">,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DailyExternalVerificationVerdict> {
  const controller = new AbortController()
  let timeout: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const failed = (failureCode: VerificationFailureCode): DailyExternalVerificationVerdict => ({
    verifierId: verifier.id,
    passed: false,
    failureCode,
    guidance: "Independent verification is unavailable. Preserve the artifact and stop; this requires an environment review, not another code-repair attempt.",
  })
  try {
    const verification = Promise.resolve()
      .then(() => verifier.verify({ ...context, signal: controller.signal }))
      .then(
        (verdict): DailyExternalVerificationVerdict => {
          if (typeof verdict?.passed !== "boolean" ||
              (verdict.failureCode !== undefined && (!isVerificationFailureCode(verdict.failureCode) || verdict.passed))) {
            return failed("verifier_exception")
          }
          return {
            verifierId: verifier.id,
            passed: verdict.passed,
            ...(verdict.failureCode === undefined ? {} : { failureCode: verdict.failureCode }),
            ...(verdict.guidance === undefined ? {} : { guidance: verdict.guidance }),
          }
        },
        (error: unknown) => failed(verificationFailureCode(error)),
      )
    const timedOut = new Promise<DailyExternalVerificationVerdict>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("completion verifier timed out"))
        resolve(failed("verifier_timeout"))
      }, timeoutMs)
    })
    const cancelled = new Promise<DailyExternalVerificationVerdict>((_resolve, reject) => {
      onAbort = () => { controller.abort(signal?.reason); reject(signal?.reason) }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
    return await Promise.race([verification, timedOut, cancelled])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

function parseChatRequest(value: unknown): ParsedChatRequest {
  if (!isRecord(value) || typeof value.model !== "string" || !Array.isArray(value.messages)) {
    throw new QwenLoopBridgeError(400, "Invalid chat completion request", "invalid_request")
  }
  const messages: WireMessage[] = value.messages.flatMap((item): WireMessage[] => {
    if (!isRecord(item) || typeof item.role !== "string") return []
    const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id : undefined
    return [{ role: item.role, content: item.content, ...(toolCallId === undefined ? {} : { toolCallId }) }]
  })
  return {
    model: value.model,
    stream: value.stream === true,
    messages,
    tools: parseToolDefinitions(value.tools),
  }
}

function parseToolDefinitions(value: unknown): ToolDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new QwenLoopBridgeError(400, "tools must be an array", "invalid_tools")
  }
  const tools: ToolDefinition[] = []
  const names = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || item.type !== "function" || !isRecord(item.function)) {
      throw new QwenLoopBridgeError(400, "Only function tools are supported", "invalid_tools")
    }
    const fn = item.function
    if (typeof fn.name !== "string" || fn.name.trim().length === 0 || names.has(fn.name)) {
      throw new QwenLoopBridgeError(400, "Tool names must be non-empty and unique", "invalid_tools")
    }
    if (!isRecord(fn.parameters)) {
      throw new QwenLoopBridgeError(400, "Tool parameters must be a JSON object", "invalid_tools")
    }
    names.add(fn.name)
    tools.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "OpenCode host tool",
      inputSchema: toJsonObject(fn.parameters),
    })
  }
  return tools
}

function projectConversation(messages: readonly WireMessage[], maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1_000) {
    throw new QwenLoopBridgeError(400, "Projection limit must be an integer of at least 1000 characters", "invalid_projection_limit")
  }
  const conversational = messages.flatMap((message): Array<{ role: "user" | "assistant"; text: string }> => {
    if (message.role !== "user" && message.role !== "assistant") return []
    const text = readContentText(message.content).trim()
    if (message.role === "user" && parseLocalFeedback(text)) return []
    return text.length === 0 ? [] : [{ role: message.role, text }]
  })
  if (!conversational.some((message) => message.role === "user")) {
    throw new QwenLoopBridgeError(400, "A non-empty user message is required", "missing_user_message")
  }
  const selected: string[] = []
  let remaining = maxChars
  for (const message of [...conversational].reverse()) {
    const prefix = `${message.role === "user" ? "USER" : "ASSISTANT"}:\n`
    const allowance = Math.max(0, remaining - prefix.length - 2)
    if (allowance === 0) break
    const clipped = message.text.length > allowance
      ? message.text.slice(message.text.length - allowance)
      : message.text
    selected.push(`${prefix}${clipped}`)
    remaining -= prefix.length + clipped.length + 2
  }
  return [
    "This request entered through the OpenCode Host UX.",
    "The latest USER block is the current goal; earlier blocks are conversation context.",
    ...selected.reverse(),
  ].join("\n\n")
}

function findLatestToolObservation(messages: readonly WireMessage[]): WireMessage | undefined {
  let latestUser = -1
  let latestTool = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === "user") latestUser = index
    if (message?.role === "tool" && message.toolCallId !== undefined) latestTool = index
  }
  return latestTool > latestUser ? messages[latestTool] : undefined
}

function toKernelObservation(
  message: WireMessage,
  toolName: string,
  maxChars: number,
  observationToken: string,
): ToolObservation {
  const toolCallId = message.toolCallId
  if (toolCallId === undefined) {
    throw new QwenLoopBridgeError(400, "Tool observation is missing tool_call_id", "invalid_observation")
  }
  let parsed: { content: string; ok: boolean }
  try {
    parsed = readToolContent(message.content, toolCallId, observationToken)
  } catch (error) {
    if (error instanceof OpenCodeObservationEnvelopeError) {
      throw new QwenLoopBridgeError(400, "OpenCode tool observation envelope is invalid", "invalid_observation_envelope")
    }
    throw error
  }
  const bounded = parsed.content.length > maxChars
    ? `${parsed.content.slice(0, maxChars)}\n...[observation truncated by Chaos Harness]`
    : parsed.content
  return {
    toolCallId,
    toolName,
    ok: parsed.ok,
    content: bounded,
    ...(parsed.ok ? {} : { errorCode: "host_tool_error" }),
  }
}

function readToolContent(content: unknown, toolCallId: string, observationToken: string): { content: string; ok: boolean } {
  if (typeof content === "string") {
    const observation = decodeOpenCodeToolObservation(content, observationToken, toolCallId)
    if (observation === undefined) {
      throw new OpenCodeObservationEnvelopeError("Tool observation envelope is missing")
    }
    return observation
  }
  if (!Array.isArray(content)) {
    throw new OpenCodeObservationEnvelopeError("Tool observation envelope is missing")
  }
  let authenticated: { content: string; ok: boolean } | undefined
  const text = content.flatMap((part): string[] => {
    if (!isRecord(part)) return []
    for (const candidate of [part.text, part.output, part.error]) {
      if (typeof candidate !== "string") continue
      const observation = decodeOpenCodeToolObservation(candidate, observationToken, toolCallId)
      if (observation !== undefined) {
        if (authenticated !== undefined) {
          throw new OpenCodeObservationEnvelopeError("Tool observation contains multiple authenticated envelopes")
        }
        authenticated = observation
        return [observation.content]
      }
      return [candidate]
    }
    return []
  }).join("\n")
  if (authenticated === undefined) {
    throw new OpenCodeObservationEnvelopeError("Tool observation envelope is missing")
  }
  return { content: text || authenticated.content, ok: authenticated.ok }
}

function readContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part): string[] => {
    if (!isRecord(part)) return []
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      return [part.text]
    }
    return []
  }).join("\n")
}

function metadataTitle(messages: readonly WireMessage[]): string {
  const source = [...messages].reverse().find((message) => message.role === "user")
  const compact = readContentText(source?.content).replace(/\s+/g, " ").trim()
  return (compact || "Chaos Harness session").slice(0, 60)
}

function bindHostClient(profile: QwenProfile, request: IncomingMessage): QwenProfile {
  if (!profile.preserveHostUserAgent) return profile
  const values = request.headersDistinct["user-agent"]
  const value = values?.[0]
  if ((values && values.length !== 1) || (value !== undefined &&
      (!value.trim() || value.length > 512 || /[^\x20-\x7e]/.test(value)))) {
    throw new QwenLoopBridgeError(400, "Host client metadata is invalid", "invalid_host_identity")
  }
  // This is the actual authenticated caller's header, never a synthesized client name.
  const { hostUserAgent: _unbound, ...connection } = profile
  return Object.freeze({ ...connection, ...(value === undefined ? {} : { hostUserAgent: value }) })
}

function requireAuthorization(request: IncomingMessage, apiKey: string): void {
  const value = request.headers.authorization
  const expected = `Bearer ${apiKey}`
  if (typeof value !== "string") {
    throw new QwenLoopBridgeError(401, "Bridge authorization is required", "unauthorized")
  }
  const actualBytes = Buffer.from(value)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new QwenLoopBridgeError(401, "Bridge authorization is invalid", "unauthorized")
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) {
      throw new QwenLoopBridgeError(413, "Bridge request body is too large", "body_too_large")
    }
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new QwenLoopBridgeError(400, "Bridge request body must be valid JSON", "invalid_json")
  }
}

function sendToolCall(
  response: ServerResponse,
  request: ParsedChatRequest,
  call: ToolCall,
  usage: WireUsage,
  reasoning = "",
  activeStream?: CompletionStreamState,
): void {
  const toolCall = {
    id: call.toolCallId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }
  if (!request.stream) {
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    sendJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
          tool_calls: [toolCall],
        },
        finish_reason: "tool_calls",
      }],
      usage,
    })
    return
  }
  const stream = activeStream ?? startCompletionStream(response, request.model)
  if (reasoning.length > 0) writeReasoningDelta(response, stream, reasoning)
  writeSse(response, {
    id: stream.id,
    object: "chat.completion.chunk",
    created: stream.created,
    model: stream.model,
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }],
  })
  writeSse(response, {
    id: stream.id,
    object: "chat.completion.chunk",
    created: stream.created,
    model: stream.model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage,
  })
  response.end("data: [DONE]\n\n")
}

function sendTextCompletion(
  response: ServerResponse,
  request: Pick<ParsedChatRequest, "model" | "stream">,
  content: string,
  usage: WireUsage,
  reasoning = "",
  activeStream?: CompletionStreamState,
): void {
  if (!request.stream) {
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    sendJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
        },
        finish_reason: "stop",
      }],
      usage,
    })
    return
  }
  const stream = activeStream ?? startCompletionStream(response, request.model)
  if (reasoning.length > 0) writeReasoningDelta(response, stream, reasoning)
  writeSse(response, {
    id: stream.id,
    object: "chat.completion.chunk",
    created: stream.created,
    model: stream.model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  writeSse(response, {
    id: stream.id,
    object: "chat.completion.chunk",
    created: stream.created,
    model: stream.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  })
  response.end("data: [DONE]\n\n")
}

function startCompletionStream(response: ServerResponse, model: string): CompletionStreamState {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
  }
}

function writeReasoningDelta(
  response: ServerResponse,
  stream: CompletionStreamState,
  delta: string,
): void {
  writeSse(response, {
    id: stream.id,
    object: "chat.completion.chunk",
    created: stream.created,
    model: stream.model,
    choices: [{ index: 0, delta: { role: "assistant", reasoning_content: delta }, finish_reason: null }],
  })
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function sendError(response: ServerResponse, statusCode: number, message: string, code: string): void {
  sendJson(response, statusCode, { error: { message, type: "chaos_harness_error", code } })
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value))
}

function modelDescriptor(id: string): Record<string, unknown> {
  return { id, object: "model", created: 0, owned_by: QWEN_LOOP_PROVIDER }
}

function zeroUsage(): WireUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
}

function sumModelUsage(total: ModelUsage | undefined, usage: ModelUsage): ModelUsage {
  if (total === undefined) return { ...usage }
  const result = { ...total, inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens, cost: total.cost + usage.cost }
  for (const key of ["reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (usage[key] !== undefined) result[key] = (result[key] ?? 0) + usage[key]
  }
  return result
}

function toWireUsage(usage: ModelUsage | undefined): WireUsage {
  if (usage === undefined) return zeroUsage()
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined
      ? {}
      : {
          prompt_tokens_details: {
            ...(usage.cacheReadTokens === undefined ? {} : { cached_tokens: usage.cacheReadTokens }),
            ...(usage.cacheWriteTokens === undefined
              ? {}
              : { cache_creation_input_tokens: usage.cacheWriteTokens }),
          },
        }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  }
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data)
  return Buffer.from(digest).toString("hex")
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  if (!isJsonValue(value)) {
    throw new QwenLoopBridgeError(400, "Tool parameters must contain only JSON values", "invalid_tools")
  }
  return value as JsonObject
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
