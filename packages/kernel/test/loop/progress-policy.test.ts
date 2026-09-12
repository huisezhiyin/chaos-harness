import { describe, expect, it } from "vitest"
import { advanceAttemptProgress, chooseRecoveryStrategy, initialAttemptProgress,
  validateProgressPolicy, type ProgressSignal } from "../../src/loop/progress-policy.js"

const digest = (n: number): string => `sha256:${n.toString(16).padStart(64, "0")}`
const policy = { explorationSoftLimit: 4, postSteerGraceActions: 2 }
const signal = (n: number, patch: Partial<ProgressSignal> = {}): ProgressSignal => ({
  phase: "explore", workActions: n, workTurns: n, workBudgetExhausted: false,
  mutationExpected: true, artifact: "unchanged", pairDigest: digest(n),
  observationDigest: digest(n), evidenceDigests: [], ...patch,
})

describe("deterministic Attempt progress policy", () => {
  it("bounds novel read-only exploration, steers once, then routes before completion", () => {
    let state = initialAttemptProgress()
    const decisions: string[] = []
    for (let n = 1; n <= 6; n++) {
      const next = advanceAttemptProgress(state, signal(n), policy)
      decisions.push(next.decision.kind)
      state = next.state
    }
    expect(decisions).toEqual(["continue", "continue", "continue", "steer", "continue", "recover"])
    expect(state).toMatchObject({ steerCount: 1, failureCode: "no_artifact_after_steer", level: "weak" })
  })

  it("detects four identical action-observation pairs independent of tool IDs", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 4; n++) state = advanceAttemptProgress(state, signal(n, {
      pairDigest: digest(100), observationDigest: digest(100), mutationExpected: false,
    }), policy).state
    expect(state.failureCode).toBe("repeated_cycle")
    expect(state.level).toBe("none")
  })

  it("detects stable errors across different actions and resets after success", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 3; n++) state = advanceAttemptProgress(state, signal(n, { errorDigest: digest(100) }), policy).state
    expect(state.failureCode).toBe("repeated_error")
    let other = advanceAttemptProgress(initialAttemptProgress(), signal(1, { errorDigest: digest(100) }), policy).state
    other = advanceAttemptProgress(other, signal(2), policy).state
    expect(other.repeatedError).toBe(0)
    expect(other.lastErrorDigest).toBeUndefined()
  })

  it("new artifact is strong progress, unchanged advanced state is not", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 4; n++) state = advanceAttemptProgress(state, signal(n), policy).state
    const advanced = advanceAttemptProgress(state, signal(5, { artifact: "advanced", artifactDigest: digest(200) }), policy)
    expect(advanced.state).toMatchObject({ level: "strong", actionsSinceStrongProgress: 0 })
    const same = advanceAttemptProgress(advanced.state, signal(6, { artifact: "advanced", artifactDigest: digest(200) }), policy)
    expect(same.state.level).toBe("weak")
    expect(same.decision.kind).toBe("continue")
  })

  it("does not reward alternating already-seen artifacts as strong progress", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 4; n++) state = advanceAttemptProgress(state, signal(n, {
      artifact: "advanced", artifactDigest: digest(200 + n % 2),
    }), policy).state
    expect(state.level).toBe("weak")
  })

  it("evidence novelty counts only once", () => {
    const first = advanceAttemptProgress(initialAttemptProgress(), signal(1, { evidenceDigests: [digest(200)] }), policy)
    const second = advanceAttemptProgress(first.state, signal(2, { evidenceDigests: [digest(200)] }), policy)
    expect(first.state.level).toBe("strong")
    expect(second.state.level).toBe("weak")
  })

  it("prioritizes closure over stuck and does not interrupt verification", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 3; n++) state = advanceAttemptProgress(state, signal(n, { pairDigest: digest(100) }), policy).state
    expect(advanceAttemptProgress(state, signal(4, { pairDigest: digest(100), workBudgetExhausted: true }), policy).decision.kind).toBe("enter_closure")
    expect(advanceAttemptProgress(state, signal(4, { pairDigest: digest(100), phase: "verify" }), policy).decision.kind).toBe("continue")
  })

  it("read-only work is never steered for missing mutation and unavailable is not strong", () => {
    let state = initialAttemptProgress()
    for (let n = 1; n <= 10; n++) state = advanceAttemptProgress(state, signal(n, { mutationExpected: false, artifact: "not_required" }), policy).state
    expect(state.steerCount).toBe(0)
    expect(advanceAttemptProgress(initialAttemptProgress(), signal(1, { artifact: "unavailable" }), policy).state.level).not.toBe("strong")
  })

  it("rejects invalid policy, raw payloads and nonmonotonic counters", () => {
    expect(() => validateProgressPolicy({ ...policy, repeatedPairLimit: 0 })).toThrow()
    expect(() => advanceAttemptProgress(initialAttemptProgress(), signal(1, { pairDigest: "secret" }), policy)).toThrow()
    expect(() => advanceAttemptProgress(initialAttemptProgress(), signal(0), policy)).toThrow()
  })

  it("routes by cause with at most one distinct automatic recovery", () => {
    expect(chooseRecoveryStrategy("no_artifact", ["initial"])).toBe("implement-first")
    expect(chooseRecoveryStrategy("repeated_cycle", ["initial"])).toBe("break-cycle")
    expect(chooseRecoveryStrategy("repeated_error", ["initial"])).toBe("repair-error")
    expect(chooseRecoveryStrategy("verifier_rejected", ["initial"])).toBe("targeted-repair")
    expect(chooseRecoveryStrategy("evidence_gap", ["initial"])).toBe("evidence-only")
    expect(chooseRecoveryStrategy("no_artifact", ["implement-first"])).toBeUndefined()
    expect(chooseRecoveryStrategy("verifier_rejected", ["initial", "break-cycle"])).toBeUndefined()
  })
})
