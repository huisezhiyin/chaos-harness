import { describe, expect, it } from "vitest"
import { advanceAttemptProgress, initialAttemptProgress, validateProgressPolicy,
  type AttemptProgressState, type ProgressSignal } from "../../src/loop/progress-policy.js"

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`
const policy = { explorationSoftLimit: 4, postSteerGraceActions: 2, investigationExtensionActions: 2 }
const signal = (n: number, patch: Partial<ProgressSignal> = {}): ProgressSignal => ({
  phase: "explore", workActions: n, workTurns: n, workBudgetExhausted: false,
  mutationExpected: true, artifact: "unchanged", pairDigest: digest(n),
  observationDigest: digest(n), observationSucceeded: true, evidenceDigests: [], ...patch,
})
function steered(patch: Partial<ProgressSignal> = {}): AttemptProgressState {
  let state = initialAttemptProgress()
  for (let n = 1; n <= 4; n++) state = advanceAttemptProgress(state, signal(n, patch), policy).state
  expect(state.noArtifactDeadlineAction).toBe(6)
  return state
}

describe("bounded investigation uncertainty allowance", () => {
  it("distinguishes the original 10+4 cutoff from an opt-in 4-action extension", () => {
    // Abstract model-free signals, not a replay of private provider outputs or a live outcome.
    const original = { explorationSoftLimit: 10, postSteerGraceActions: 4 }
    let legacy = initialAttemptProgress(); let revised = initialAttemptProgress()
    for (let n = 1; n <= 14; n++) {
      legacy = advanceAttemptProgress(legacy, signal(n), original).state
      revised = advanceAttemptProgress(revised, signal(n), { ...original, investigationExtensionActions: 4 }).state
    }
    expect(legacy.failureCode).toBe("no_artifact_after_steer")
    expect(revised.failureCode).toBeUndefined()
    expect(revised).toMatchObject({ level: "weak", investigationExtensionCount: 1, noArtifactDeadlineAction: 18 })
  })
  it("extends once for two post-steer novel successful observations, without upgrading weak progress", () => {
    let state = steered()
    state = advanceAttemptProgress(state, signal(5), policy).state
    const extended = advanceAttemptProgress(state, signal(6), policy)
    expect(extended.decision).toEqual({ kind: "extend", reason: "novel_observations", untilWorkAction: 8 })
    expect(extended.state).toMatchObject({ level: "weak", steerCount: 1, investigationExtensionCount: 1 })
    state = advanceAttemptProgress(extended.state, signal(7), policy).state
    expect(advanceAttemptProgress(state, signal(8), policy).decision).toEqual({ kind: "recover", reason: "no_artifact_after_steer" })
  })

  it("extends for new requirement evidence even without novel successful observations", () => {
    const state = advanceAttemptProgress(steered(), signal(5, { observationSucceeded: false, evidenceDigests: [digest(200)] }), policy).state
    const result = advanceAttemptProgress(state, signal(6, { observationSucceeded: false, evidenceDigests: [digest(200)] }), policy)
    expect(result.decision).toEqual({ kind: "extend", reason: "new_evidence", untilWorkAction: 8 })
    expect(result.state.novelObservationsAfterSteer).toBe(0)
  })

  it("does not renew even when every subsequent action produces strong evidence", () => {
    let state = steered()
    for (let n = 5; n <= 8; n++) state = advanceAttemptProgress(state, signal(n, { evidenceDigests: [digest(200 + n)] }), policy).state
    expect(state).toMatchObject({ level: "strong", investigationExtensionCount: 1, failureCode: "no_artifact_after_steer" })
  })

  it.each([
    ["failed", { observationSucceeded: false }],
    ["error despite success", { errorDigest: digest(300) }],
    ["previously seen", { observationDigest: digest(1) }],
    ["old evidence", { observationSucceeded: false, evidenceDigests: [digest(200)] }],
    ["unavailable artifact", { artifact: "unavailable" }],
  ] as const)("does not grant an extension for %s", (_, patch) => {
    let state = steered({ evidenceDigests: [digest(200)] })
    for (let n = 5; n <= 6; n++) state = advanceAttemptProgress(state, signal(n, patch), policy).state
    expect(state.investigationExtensionCount).toBe(0)
    expect(state.failureCode).toBe("no_artifact_after_steer")
  })

  it("does not treat unknown observation success as successful progress", () => {
    let state = steered()
    for (let n = 5; n <= 6; n++) {
      const next = signal(n)
      delete next.observationSucceeded
      state = advanceAttemptProgress(state, next, policy).state
    }
    expect(state.investigationExtensionCount).toBe(0)
    expect(state.failureCode).toBe("no_artifact_after_steer")
  })

  it("one new observation is not enough and changing call identity alone does not help", () => {
    const state = advanceAttemptProgress(steered(), signal(5), policy).state
    const result = advanceAttemptProgress(state, signal(6, { observationDigest: digest(5) }), policy)
    expect(result.state.novelObservationsAfterSteer).toBe(1)
    expect(result.decision.kind).toBe("recover")
  })

  it("does not count evidence observed at the steer boundary as post-steer progress", () => {
    let state = steered({ evidenceDigests: [digest(200)] })
    for (let n = 5; n <= 6; n++) state = advanceAttemptProgress(state, signal(n, { observationSucceeded: false, evidenceDigests: [digest(200)] }), policy).state
    expect(state.evidenceAdvancedAfterSteer).toBe(false)
    expect(state.failureCode).toBe("no_artifact_after_steer")
  })

  it("does not revive an expired extension after a counter jump", () => {
    const state = advanceAttemptProgress(steered(), signal(5), policy).state
    const result = advanceAttemptProgress(state, signal(9), policy)
    expect(result.state.novelObservationsAfterSteer).toBe(2)
    expect(result.decision.kind).toBe("recover")
  })

  it("does not reuse stale evidence to grant a late extension", () => {
    const state = advanceAttemptProgress(steered(), signal(5, { evidenceDigests: [digest(200)], observationSucceeded: false }), policy).state
    expect(advanceAttemptProgress(state, signal(7, { observationSucceeded: false }), policy).decision.kind).toBe("recover")
  })

  it.each(["repeated_cycle", "repeated_error"] as const)("%s remains higher priority", (reason) => {
    const short = { ...policy, repeatedPairLimit: 2, repeatedErrorLimit: 2 }
    let state = steered()
    for (let n = 5; n <= 6; n++) state = advanceAttemptProgress(state, signal(n,
      reason === "repeated_cycle" ? { pairDigest: digest(400) } : { errorDigest: digest(400) }), short).state
    expect(state.failureCode).toBe(reason)
    expect(state.investigationExtensionCount).toBe(0)
  })

  it("budget/verification wins; a previous stop remains terminal", () => {
    const state = advanceAttemptProgress(steered(), signal(5), policy).state
    expect(advanceAttemptProgress(state, signal(6, { workBudgetExhausted: true }), policy).decision.kind).toBe("enter_closure")
    expect(advanceAttemptProgress(state, signal(6, { phase: "verify" }), policy).decision.kind).toBe("continue")
    const stopped = advanceAttemptProgress(state, signal(6, { artifact: "unavailable" }), policy).state
    expect(advanceAttemptProgress(stopped, signal(7), policy).decision.kind).toBe("recover")
  })

  it("does not impose a mutation deadline on read-only work", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 10; n++) state = advanceAttemptProgress(state, signal(n, { mutationExpected: false, artifact: "not_required" }), policy).state
    expect(state.noArtifactDeadlineAction).toBeUndefined()
    expect(state.investigationExtensionCount).toBe(0)
  })

  it("accepts an artifact within the extension without demanding another extension", () => {
    let state = steered()
    for (let n = 5; n <= 6; n++) state = advanceAttemptProgress(state, signal(n), policy).state
    expect(advanceAttemptProgress(state, signal(8, { artifact: "advanced", artifactDigest: digest(500) }), policy).decision.kind).toBe("continue")
  })

  it("preserves the original deadline when the extension is not configured, even for strong evidence", () => {
    const legacy = { explorationSoftLimit: 4, postSteerGraceActions: 2 }
    let state = initialAttemptProgress()
    for (let n = 1; n <= 6; n++) state = advanceAttemptProgress(state, signal(n, { evidenceDigests: [digest(200 + n)] }), legacy).state
    expect(state.failureCode).toBe("no_artifact_after_steer")
    expect(state.investigationExtensionCount).toBe(0)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid/overflow extension %s", (value) => {
    expect(() => validateProgressPolicy({ ...policy, investigationExtensionActions: value })).toThrow()
  })
})
