/** Host-neutral deterministic progress control. No raw tool data or model calls. */
export type ProgressPhase = "explore" | "implement" | "verify" | "review"
export type ProgressLevel = "strong" | "weak" | "none"
export type ProgressArtifact = "advanced" | "unchanged" | "unavailable" | "not_required"
export type ProgressFailureCode =
  | "repeated_cycle" | "repeated_error" | "no_artifact_after_steer"
  | "no_artifact" | "evidence_gap" | "verifier_rejected"

export interface AttemptProgressPolicy {
  explorationSoftLimit: number
  postSteerGraceActions: number
  repeatedPairLimit?: number
  repeatedErrorLimit?: number
  /** One fixed uncertainty allowance; omitted preserves the original policy. */
  investigationExtensionActions?: number
}

export interface ProgressSignal {
  phase: ProgressPhase
  workTurns: number
  workActions: number
  workBudgetExhausted: boolean
  mutationExpected: boolean
  artifact: ProgressArtifact
  artifactDigest?: string
  pairDigest: string
  observationDigest: string
  /** Authenticated Host success, not a claim of semantic correctness. */
  observationSucceeded?: boolean
  errorDigest?: string
  evidenceDigests: readonly string[]
}

export interface AttemptProgressState {
  phase: ProgressPhase
  level: ProgressLevel
  workTurns: number
  workActions: number
  artifact: ProgressArtifact
  repeatedActionObservation: number
  repeatedError: number
  actionsSinceStrongProgress: number
  steerCount: number
  steeredAtAction?: number
  noArtifactDeadlineAction?: number
  contextContinuationCount: number
  pathCorrectionCount: number
  investigationExtensionCount: number
  novelObservationsAfterSteer: number
  evidenceAdvancedAfterSteer: boolean
  lastInvestigationProgressAction?: number
  lastPairDigest?: string
  lastErrorDigest?: string
  seenProgressDigests: readonly string[]
  seenObservationDigests: readonly string[]
  failureCode?: ProgressFailureCode
}

export type ProgressDecision =
  | { kind: "continue" | "enter_closure" }
  | { kind: "steer"; reason: "implement_required" }
  | { kind: "extend"; reason: "new_evidence" | "novel_observations"; untilWorkAction: number }
  | { kind: "continue_context"; reason: "no_artifact_after_steer"; untilWorkAction: number }
  | { kind: "correct_path"; reason: "workspace_boundary"; untilWorkAction: number }
  | { kind: "recover"; reason: ProgressFailureCode }

export function validateProgressPolicy(policy: AttemptProgressPolicy): void {
  for (const value of [policy.explorationSoftLimit, policy.postSteerGraceActions,
    policy.repeatedPairLimit ?? 4, policy.repeatedErrorLimit ?? 3]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Progress thresholds must be positive safe integers")
  }
  if (policy.investigationExtensionActions !== undefined &&
    (!Number.isSafeInteger(policy.investigationExtensionActions) || policy.investigationExtensionActions < 1)) {
    throw new TypeError("Investigation extension must be a positive safe integer")
  }
  if (!Number.isSafeInteger(policy.explorationSoftLimit + policy.postSteerGraceActions + (policy.investigationExtensionActions ?? 0))) {
    throw new TypeError("Progress deadline must be a safe integer")
  }
}

export function initialAttemptProgress(): AttemptProgressState {
  return {
    phase: "explore", level: "none", workTurns: 0, workActions: 0,
    artifact: "unavailable", repeatedActionObservation: 0, repeatedError: 0,
    actionsSinceStrongProgress: 0, steerCount: 0,
    contextContinuationCount: 0, pathCorrectionCount: 0, investigationExtensionCount: 0, novelObservationsAfterSteer: 0, evidenceAdvancedAfterSteer: false,
    seenProgressDigests: [], seenObservationDigests: [],
  }
}

export function advanceAttemptProgress(
  previous: AttemptProgressState,
  signal: ProgressSignal,
  policy: AttemptProgressPolicy,
): { state: AttemptProgressState; decision: ProgressDecision } {
  validateProgressPolicy(policy)
  for (const value of [signal.pairDigest, signal.observationDigest,
    ...signal.evidenceDigests, ...(signal.artifactDigest ? [signal.artifactDigest] : []),
    ...(signal.errorDigest ? [signal.errorDigest] : [])]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("Progress signals require SHA-256 digests")
  }
  if (!Number.isSafeInteger(signal.workActions) || signal.workActions <= previous.workActions ||
      !Number.isSafeInteger(signal.workTurns) || signal.workTurns < previous.workTurns) {
    throw new TypeError("Progress counters must advance monotonically")
  }
  // Bounded lifetime sets deliberately stop admitting novelty when full: eviction would
  // let cycling through old artifacts/observations count as fresh progress indefinitely.
  const strongDigests = [...signal.evidenceDigests,
    ...(signal.artifact === "advanced" && signal.artifactDigest ? [signal.artifactDigest] : [])]
  const novel = strongDigests.some((value) => !previous.seenProgressDigests.includes(value)) && previous.seenProgressDigests.length < 128
  const novelEvidence = signal.evidenceDigests.some((value) => !previous.seenProgressDigests.includes(value)) && previous.seenProgressDigests.length < 128
  const weak = !previous.seenObservationDigests.includes(signal.observationDigest) && previous.seenObservationDigests.length < 128
  const afterSteer = previous.steeredAtAction !== undefined
  const successfulNovelObservation = weak && signal.observationSucceeded === true && signal.errorDigest === undefined
  const state: AttemptProgressState = {
    ...previous, phase: signal.phase, workTurns: signal.workTurns, workActions: signal.workActions,
    artifact: signal.artifact, level: novel ? "strong" : weak ? "weak" : "none",
    repeatedActionObservation: signal.pairDigest === previous.lastPairDigest ? previous.repeatedActionObservation + 1 : 1,
    repeatedError: signal.errorDigest === undefined ? 0 : signal.errorDigest === previous.lastErrorDigest ? previous.repeatedError + 1 : 1,
    actionsSinceStrongProgress: novel ? 0 : previous.actionsSinceStrongProgress + signal.workActions - previous.workActions,
    lastPairDigest: signal.pairDigest,
    seenProgressDigests: boundedUnion(previous.seenProgressDigests, strongDigests),
    seenObservationDigests: boundedUnion(previous.seenObservationDigests, [signal.observationDigest]),
    novelObservationsAfterSteer: Math.min(2, previous.novelObservationsAfterSteer + (afterSteer && successfulNovelObservation ? 1 : 0)),
    evidenceAdvancedAfterSteer: previous.evidenceAdvancedAfterSteer || (afterSteer && novelEvidence),
  }
  if (afterSteer && (novelEvidence || successfulNovelObservation)) state.lastInvestigationProgressAction = signal.workActions
  delete state.lastErrorDigest
  if (signal.errorDigest !== undefined) state.lastErrorDigest = signal.errorDigest
  if (previous.failureCode) return { state, decision: { kind: "recover", reason: previous.failureCode } }
  if (signal.workBudgetExhausted || signal.phase === "verify" || signal.phase === "review") {
    return { state, decision: { kind: signal.workBudgetExhausted ? "enter_closure" : "continue" } }
  }
  let failure: ProgressFailureCode | undefined
  if (!novel && state.repeatedError >= (policy.repeatedErrorLimit ?? 3)) failure = "repeated_error"
  else if (!novel && state.repeatedActionObservation >= (policy.repeatedPairLimit ?? 4)) failure = "repeated_cycle"
  else if (signal.mutationExpected && signal.artifact !== "advanced" && state.noArtifactDeadlineAction !== undefined &&
    signal.workActions >= state.noArtifactDeadlineAction) {
    const extendedDeadline = state.noArtifactDeadlineAction + (policy.investigationExtensionActions ?? 0)
    const recent = state.lastInvestigationProgressAction !== undefined &&
      signal.workActions - state.lastInvestigationProgressAction < policy.postSteerGraceActions
    if (policy.investigationExtensionActions !== undefined && state.investigationExtensionCount === 0 && state.contextContinuationCount === 0 && state.pathCorrectionCount === 0 &&
      signal.artifact === "unchanged" && recent && signal.workActions < extendedDeadline &&
      (state.evidenceAdvancedAfterSteer || state.novelObservationsAfterSteer >= 2)) {
      state.investigationExtensionCount = 1
      state.noArtifactDeadlineAction = extendedDeadline
      return { state, decision: { kind: "extend", reason: state.evidenceAdvancedAfterSteer ? "new_evidence" : "novel_observations", untilWorkAction: extendedDeadline } }
    }
    failure = "no_artifact_after_steer"
  }
  if (failure) {
    state.failureCode = failure
    return { state, decision: { kind: "recover", reason: failure } }
  }
  if (signal.mutationExpected && signal.artifact !== "advanced" && state.steerCount === 0 && signal.workActions >= policy.explorationSoftLimit) {
    state.steerCount = 1
    state.steeredAtAction = signal.workActions
    state.noArtifactDeadlineAction = signal.workActions + policy.postSteerGraceActions
    return { state, decision: { kind: "steer", reason: "implement_required" } }
  }
  return { state, decision: { kind: "continue" } }
}

function boundedUnion(previous: readonly string[], next: readonly string[]): readonly string[] {
  return [...new Set([...previous, ...next])].slice(0, 128)
}

export type RecoveryStrategy = "initial" | "implement-first" | "break-cycle" | "repair-error" | "targeted-repair" | "evidence-only"

export function chooseRecoveryStrategy(failure: ProgressFailureCode, used: readonly RecoveryStrategy[]): RecoveryStrategy | undefined {
  if (used.length >= 2) return undefined
  const strategy: RecoveryStrategy = failure === "repeated_cycle" ? "break-cycle"
    : failure === "repeated_error" ? "repair-error"
    : failure === "verifier_rejected" ? "targeted-repair"
    : failure === "evidence_gap" ? "evidence-only" : "implement-first"
  return used.includes(strategy) ? undefined : strategy
}
