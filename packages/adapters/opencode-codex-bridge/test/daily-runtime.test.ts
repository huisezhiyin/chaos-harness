import { describe, expect, it, vi } from "vitest"
import { ids, type ToolObservation, type ToolProposal } from "../../../kernel/src/index.js"
import {
  DailyUnitRuntime,
  evaluateDailyEvidenceClosureAction,
  inferDailyMutationIntent,
  replayDailyRuntimeJournal,
} from "../src/daily-runtime.js"

describe("DailyUnitRuntime", () => {
  it.each([
    "只读查看 README.md，用一句话说明这个项目做什么，不修改任何文件。",
    "只阅读并解释这个模块，不要修改或删除文件",
    "请勿创建、写入或删除，只查看文件",
    "不要进行任何修改，解释代码即可",
    "Read README and summarize. Do not change any files.",
    "Read README; don't write, modify or delete files.",
    "Inspect the address and README without change",
  ])("does not interpret direct negation as mutation: %s", goal => {
    expect(inferDailyMutationIntent(goal)).toBe(false)
  })

  it.each([
    "不修改 README，但修复 src/parser.ts",
    "先只读检查，然后修改代码",
    "不要删除文件，添加一个测试",
    "Don't change README, but fix parser.ts",
    "Do not delete files; add a test",
    "Implement the parser change",
  ])("preserves positive mutation requests outside a negated phrase: %s", goal => {
    expect(inferDailyMutationIntent(goal)).toBe(true)
  })

  it("turns the user request into an admitted Unit with a resolved execution checkpoint", () => {
    const runtime = dailyRuntime(false)
    const started = runtime.beginAttempt("attempt-1", "2026-09-02T10:00:01.000Z")

    expect(started.attempt).toMatchObject({
      attemptId: "attempt-1",
      unitId: "daily-unit-seed-1",
      unitRevision: 1,
    })
    expect(started.journalEvents.map((event) => event.event)).toEqual([
      "mission_started",
      "unit_proposed",
      "unit_admitted",
      "checkpoint_opened",
      "checkpoint_resolved",
    ])
  })

  it("accepts a read-only completion only after authenticated workspace evidence", () => {
    const runtime = dailyRuntime(false)
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "read", { filePath: "README.md" }),
      observation("read", true),
    )

    const completed = runtime.completeAttempt("attempt-1", () => "attempt-2")

    expect(completed.outcome).toBe("unit_verified")
    expect(completed.failedRequirements).toEqual([])
    expect(completed.journalEvents.map((event) => event.event)).toEqual([
      "completion_proposed",
      "verification_completed",
      "unit_finished",
      "mission_finished",
    ])
    expect(replayDailyRuntimeJournal(completed.journalEvents)).toMatchObject({
      attempts: 1,
      verification: "passed",
      outcome: "unit_verified",
      missionOutcome: "succeeded",
    })
  })

  it("opens a verification checkpoint and clean-restarts the same Unit after an unverified mutation", () => {
    const runtime = dailyRuntime(true)
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "write", { filePath: "src/new.ts", content: "export {}" }),
      observation("write", true),
    )

    const completed = runtime.completeAttempt("attempt-1", () => "attempt-2")

    expect(completed.outcome).toBe("restart_required")
    expect(completed.failedRequirements).toEqual([
      "no successful validation ran after the latest mutation",
      "no successful change inspection ran after the latest mutation",
    ])
    expect(completed.recovery?.attempt).toMatchObject({
      attemptId: "attempt-2",
      unitId: "daily-unit-seed-1",
      unitRevision: 1,
      previousAttemptId: "attempt-1",
    })
    expect(completed.recovery?.recoveryPrompt).toContain("Continue the same ChaosUnit in a clean Attempt")
    expect(completed.journalEvents.map((event) => event.event)).toEqual([
      "completion_proposed",
      "verification_completed",
      "checkpoint_opened",
      "checkpoint_resolved",
      "recovery_started",
    ])
  })

  it("preserves Unit evidence across recovery and verifies only checks after the latest mutation", () => {
    const runtime = dailyRuntime(true)
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "write", { filePath: "src/new.ts", content: "export {}" }),
      observation("write", true),
    )
    expect(runtime.completeAttempt("attempt-1", () => "attempt-2").outcome).toBe("restart_required")

    runtime.recordAction(
      proposal("attempt-2", 1, "bash", { command: "pnpm test" }),
      observation("bash", true),
    )
    runtime.recordAction(
      proposal("attempt-2", 2, "bash", { command: "git diff --check && git status --short" }),
      observation("bash", true),
    )
    const completed = runtime.completeAttempt("attempt-2", () => "unused")

    expect(completed.outcome).toBe("unit_verified")
    expect(completed.failedRequirements).toEqual([])
    expect(completed.journalEvents.find((event) => event.event === "unit_finished")).toMatchObject({
      event: "unit_finished",
      outcome: "unit_verified",
      attempts: 2,
    })
    expect(completed.journalEvents.at(-1)).toMatchObject({
      event: "mission_finished",
      outcome: "succeeded",
    })
  })

  it("rejects a successful edit when the final Git state is clean and defers the external verifier", () => {
    const runtime = artifactBoundRuntime(artifactState("a", 0))
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "edit", { filePath: "src/rule.ts", oldString: "a", newString: "b" }),
      observation("edit", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 2, "bash", { command: "pnpm test" }),
      observation("bash", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 3, "bash", { command: "git diff --check && git status --short" }),
      observation("bash", true),
    )
    runtime.recordWorkspaceArtifactState(artifactState("a", 0))

    expect(runtime.isReadyForExternalVerification()).toBe(false)
    const completed = runtime.completeAttempt("attempt-1", () => "attempt-2")

    expect(completed.outcome).toBe("restart_required")
    expect(completed.failedRequirements).toEqual([
      "the requested mutation left no durable workspace artifact",
    ])
    expect(completed.journalEvents.some((event) =>
      event.event === "external_verification_completed")).toBe(false)
  })

  it("assesses in-flight artifact progress without recording it as completion evidence", () => {
    const runtime = artifactBoundRuntime(artifactState("a", 0))
    const readOnly = dailyRuntime(false)

    expect(runtime.assessWorkspaceArtifactProgress(artifactState("b", 1))).toBe("advanced")
    expect(runtime.assessWorkspaceArtifactProgress(artifactState("a", 0))).toBe("unchanged")
    expect(runtime.assessWorkspaceArtifactProgress({ available: false })).toBe("unavailable")
    expect(readOnly.assessWorkspaceArtifactProgress(artifactState("b", 1))).toBe("not_required")

    runtime.beginAttempt("attempt-1")
    expect(runtime.completeAttempt("attempt-1", () => "attempt-2").failedRequirements)
      .toContain("the admitted Unit required a mutation but none was observed")
  })

  it("rejects an unchanged dirty baseline instead of treating pre-existing work as this Unit's artifact", () => {
    const runtime = artifactBoundRuntime(artifactState("c", 2))
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "write", { filePath: "src/new.ts", content: "export {}" }),
      observation("write", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 2, "bash", { command: "pnpm test && git status --short" }),
      observation("bash", true),
    )
    runtime.recordWorkspaceArtifactState(artifactState("c", 2))

    const completed = runtime.completeAttempt("attempt-1", () => "attempt-2")
    expect(completed.outcome).toBe("restart_required")
    expect(completed.failedRequirements).toContain(
      "the final workspace artifact state did not differ from the Unit baseline",
    )
  })

  it("fails closed when the final workspace artifact probe is unavailable", () => {
    const runtime = artifactBoundRuntime(artifactState("a", 0))
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "edit", { filePath: "src/rule.ts", oldString: "a", newString: "b" }),
      observation("edit", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 2, "bash", { command: "pnpm test && git status --short" }),
      observation("bash", true),
    )
    runtime.recordWorkspaceArtifactState({ available: false })

    expect(runtime.isReadyForExternalVerification()).toBe(false)
    const completed = runtime.completeAttempt("attempt-1", () => "attempt-2")
    expect(completed.outcome).toBe("restart_required")
    expect(completed.failedRequirements).toContain(
      "the final workspace artifact state was unavailable",
    )
  })

  it("accepts recovery validation of a durable artifact inherited from the first Attempt", () => {
    const runtime = artifactBoundRuntime(artifactState("a", 0))
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "write", { filePath: "src/new.ts", content: "export {}" }),
      observation("write", true),
    )
    runtime.recordWorkspaceArtifactState(artifactState("b", 1))
    expect(runtime.completeAttempt("attempt-1", () => "attempt-2").outcome).toBe("restart_required")

    runtime.recordAction(
      proposal("attempt-2", 1, "bash", { command: "pnpm test" }),
      observation("bash", true),
    )
    runtime.recordAction(
      proposal("attempt-2", 2, "bash", { command: "git diff --check && git status --short" }),
      observation("bash", true),
    )
    runtime.recordWorkspaceArtifactState(artifactState("b", 1))

    expect(runtime.isReadyForExternalVerification()).toBe(true)
    const completed = runtime.completeAttempt(
      "attempt-2",
      () => "unused",
      { verifierId: "task-specific-test", passed: true },
    )
    expect(completed.outcome).toBe("unit_verified")
    expect(completed.failedRequirements).toEqual([])
  })

  it.each(["dependencies_changed", "verifier_timeout", "verifier_exception"] as const)("keeps %s as the stop cause and never starts repair recovery", (failureCode) => {
    const runtime = new DailyUnitRuntime({ workspaceRoot: "/workspace", goal: "inspect", seed: "environment-error", mutationExpected: false, externalVerificationRequired: true })
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(proposal("attempt-1", 1, "read", { filePath: "README.md" }), observation("read", true))
    const restart = vi.fn(() => "must-not-start")
    const result = runtime.completeAttempt("attempt-1", restart, { verifierId: "environment", passed: false, failureCode })
    expect(result.outcome).toBe("verification_pending")
    expect(restart).not.toHaveBeenCalled()
    expect(result.journalEvents).toContainEqual(expect.objectContaining({ event: "external_verification_completed", failureCode }))
    expect(runtime.cancel("host_exit")).toContainEqual(expect.objectContaining({ event: "mission_finished", verificationFailureCode: failureCode, reason: "host_exit" }))
  })

  it("does not carry a verifier failure into an explicitly resumed Attempt", () => {
    const runtime = new DailyUnitRuntime({ workspaceRoot: "/workspace", goal: "inspect", seed: "resume-environment", mutationExpected: false, externalVerificationRequired: true })
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(proposal("attempt-1", 1, "read", { filePath: "README.md" }), observation("read", true))
    runtime.completeAttempt("attempt-1", () => "unused", { verifierId: "environment", passed: false, failureCode: "dependencies_changed" })
    runtime.resumeAfterUserCheckpoint("attempt-2", "Environment repaired; continue")
    const mission = runtime.cancel("host_exit").find(event => event.event === "mission_finished")
    expect(mission).not.toHaveProperty("verificationFailureCode")
  })

  it("routes an independent verifier rejection into the same Unit recovery before closure", () => {
    const runtime = new DailyUnitRuntime({
      workspaceRoot: "/workspace",
      goal: "inspect the repository and report",
      seed: "external-verifier",
      mutationExpected: false,
      externalVerificationRequired: true,
    })
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "read", { filePath: "README.md" }),
      observation("read", true),
    )

    const rejected = runtime.completeAttempt(
      "attempt-1",
      () => "attempt-2",
      {
        verifierId: "task-specific-child-process",
        passed: false,
        guidance: "Add a zero-handle child-process regression and require exit code 1.",
      },
    )

    expect(rejected.outcome).toBe("restart_required")
    expect(rejected.failedRequirements).toEqual([
      "independent completion verifier rejected the proposed result",
    ])
    expect(rejected.recovery?.attempt).toMatchObject({
      attemptId: "attempt-2",
      unitId: "daily-unit-external-verifier",
      unitRevision: 1,
      previousAttemptId: "attempt-1",
    })
    expect(rejected.recovery?.recoveryPrompt).toContain(
      "Add a zero-handle child-process regression and require exit code 1.",
    )
    expect(rejected.journalEvents.map((event) => event.event)).toEqual([
      "completion_proposed",
      "external_verification_completed",
      "verification_completed",
      "checkpoint_opened",
      "checkpoint_resolved",
      "recovery_started",
    ])
    expect(rejected.journalEvents.find((event) => event.event === "external_verification_completed"))
      .toMatchObject({
        attemptId: "attempt-1",
        verifierId: "task-specific-child-process",
        passed: false,
        verdictDigest: expect.stringMatching(/^sha256:/),
      })
    expect(JSON.stringify(rejected.journalEvents)).not.toContain("zero-handle")

    const accepted = runtime.completeAttempt(
      "attempt-2",
      () => "unused",
      { verifierId: "task-specific-child-process", passed: true },
    )
    expect(accepted.outcome).toBe("unit_verified")
    expect(accepted.journalEvents.map((event) => event.event)).toEqual([
      "completion_proposed",
      "external_verification_completed",
      "verification_completed",
      "unit_finished",
      "mission_finished",
    ])
    expect(replayDailyRuntimeJournal([
      ...rejected.journalEvents,
      ...accepted.journalEvents,
    ])).toMatchObject({
      attempts: 2,
      recoveries: 1,
      verification: "passed",
      externalVerification: "passed",
      outcome: "unit_verified",
      missionOutcome: "succeeded",
    })
  })

  it("stops automatic recovery after the second identical evidence gap", () => {
    const runtime = dailyRuntime(false)
    runtime.beginAttempt("attempt-1")
    expect(runtime.completeAttempt("attempt-1", () => "attempt-2").outcome).toBe("restart_required")

    const completed = runtime.completeAttempt("attempt-2", () => "attempt-3")

    expect(completed.outcome).toBe("verification_pending")
    expect(completed.recovery).toBeUndefined()
    const summary = replayDailyRuntimeJournal(completed.journalEvents)
    expect(summary).toMatchObject({
      attempts: 2,
      verification: "failed",
      outcome: "verification_pending",
    })

    const resumed = runtime.resumeAfterUserCheckpoint(
      "attempt-3",
      "add the missing evidence and keep the current scope",
    )
    expect(resumed.attempt).toMatchObject({
      attemptId: "attempt-3",
      unitId: "daily-unit-seed-1",
      unitRevision: 1,
      previousAttemptId: "attempt-2",
    })
    expect(resumed.recoveryPrompt).toContain("user-role goal contains additional checkpoint direction")
    expect(resumed.journalEvents.map((event) => event.event)).toEqual(["checkpoint_resolved"])
  })

  it("uses the latest user instruction for mutation admission and closes declared plans", () => {
    expect(inferDailyMutationIntent([
      "USER:\n分析项目并汇报",
      "ASSISTANT:\n我建议实现修复",
      "USER:\n可以，推进任务",
    ].join("\n\n"))).toBe(true)
    expect(inferDailyMutationIntent("USER:\n只阅读并解释这个模块")).toBe(false)

    const runtime = dailyRuntime(true)
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "todowrite", {
        todos: [{ content: "add tests", status: "pending" }],
      }),
      observation("todowrite", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 2, "write", { filePath: "src/new.ts", content: "export {}" }),
      observation("write", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 3, "bash", { command: "pnpm test && git diff --check" }),
      observation("bash", true),
    )

    const completed = runtime.completeAttempt("attempt-1", () => "attempt-2")
    expect(completed.outcome).toBe("restart_required")
    expect(completed.failedRequirements).toContain(
      "the latest declared tool plan still contains pending or in-progress work",
    )
  })

  it("projects the current mutation, validation, inspection, and todo gaps into evidence closure", () => {
    const runtime = dailyRuntime(true)
    runtime.beginAttempt("attempt-1")
    runtime.recordAction(
      proposal("attempt-1", 1, "todowrite", {
        todos: [{ content: "verify the fix", status: "in_progress" }],
      }),
      observation("todowrite", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 2, "edit", { filePath: "src/rule.ts", oldString: "a", newString: "b" }),
      observation("edit", true),
    )

    expect(runtime.evidenceClosureGuidance()).toContain(
      "no successful validation ran after the latest mutation",
    )
    expect(runtime.evidenceClosureGuidance()).toContain(
      "no successful change inspection ran after the latest mutation",
    )
    expect(runtime.evidenceClosureGuidance()).toContain(
      "the latest declared tool plan still contains pending or in-progress work",
    )

    runtime.recordAction(
      proposal("attempt-1", 3, "bash", { command: "pnpm exec vitest src/rule.test.ts" }),
      observation("bash", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 4, "bash", { command: "git diff --check && git status --short" }),
      observation("bash", true),
    )
    runtime.recordAction(
      proposal("attempt-1", 5, "todowrite", {
        todos: [{ content: "verify the fix", status: "completed" }],
      }),
      observation("todowrite", true),
    )

    expect(runtime.evidenceClosureGuidance()).toContain(
      "All generic evidence requirements are currently satisfied",
    )
  })

  it("allows only read-only evidence actions during closure", () => {
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "safe-validation",
      name: "bash",
      arguments: { command: "pnpm exec vitest src/rule.test.ts && git diff --check" },
    })).toEqual({ outcome: "allow" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "safe-plan",
      name: "todowrite",
      arguments: { todos: [{ content: "done", status: "completed" }] },
    })).toEqual({ outcome: "allow" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-edit",
      name: "edit",
      arguments: { filePath: "src/rule.ts" },
    })).toMatchObject({ outcome: "deny" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-shell-mutation",
      name: "bash",
      arguments: { command: "sed -i '' 's/a/b/' src/rule.ts && pnpm test" },
    })).toMatchObject({ outcome: "deny" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-arbitrary-shell",
      name: "bash",
      arguments: { command: "node scripts/rewrite.mjs" },
    })).toMatchObject({ outcome: "deny" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-lint-fix",
      name: "lint",
      arguments: { fix: true },
    })).toMatchObject({ outcome: "deny" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-build",
      name: "bash",
      arguments: { command: "pnpm build" },
    })).toMatchObject({ outcome: "deny" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-package-write",
      name: "bash",
      arguments: { command: "npm install test-helper && npm test" },
    })).toMatchObject({ outcome: "deny" })
    expect(evaluateDailyEvidenceClosureAction({
      toolCallId: "blocked-hidden-write",
      name: "bash",
      arguments: { command: "python -c 'open(\"src/rule.ts\", \"w\").write(\"x\")' && pytest" },
    })).toMatchObject({ outcome: "deny" })
  })

  it("replays only the latest Unit when a journal contains multiple daily runs", () => {
    const first = dailyRuntime(false)
    const firstStart = first.beginAttempt("attempt-first")
    first.recordAction(
      proposal("attempt-first", 1, "read", { filePath: "README.md" }),
      observation("read", true),
    )
    const firstDone = first.completeAttempt("attempt-first", () => "unused")

    const second = new DailyUnitRuntime({
      workspaceRoot: "/workspace",
      goal: "read another file",
      seed: "seed-2",
      mutationExpected: false,
    })
    const secondStart = second.beginAttempt("attempt-second")
    const secondPending = second.completeAttempt("attempt-second", () => "attempt-second-recovery")
    const replayed = replayDailyRuntimeJournal([
      ...firstStart.journalEvents,
      ...firstDone.journalEvents,
      ...secondStart.journalEvents,
      ...secondPending.journalEvents,
    ])

    expect(replayed).toMatchObject({
      missionId: "daily-mission-seed-2",
      unitId: "daily-unit-seed-2",
      attempts: 1,
      recoveries: 1,
      verification: "failed",
    })
  })
})

function dailyRuntime(mutationExpected: boolean): DailyUnitRuntime {
  return new DailyUnitRuntime({
    workspaceRoot: "/workspace",
    goal: "inspect or update the repository and verify the result",
    seed: "seed-1",
    mutationExpected,
    occurredAt: "2026-09-02T10:00:00.000Z",
  })
}

function artifactBoundRuntime(
  artifactBaseline: ReturnType<typeof artifactState>,
): DailyUnitRuntime {
  return new DailyUnitRuntime({
    workspaceRoot: "/workspace",
    goal: "fix the repository and verify the result",
    seed: "artifact-bound",
    mutationExpected: true,
    externalVerificationRequired: true,
    artifactBaseline,
    occurredAt: "2026-09-03T10:00:00.000Z",
  })
}

function artifactState(seed: string, changedPathCount: number): {
  available: true
  digest: string
  changedPathCount: number
} {
  return {
    available: true,
    digest: `sha256:${seed.repeat(64)}`,
    changedPathCount,
  }
}

function proposal(
  attemptId: string,
  turn: number,
  name: string,
  args: ToolProposal["call"]["arguments"],
): ToolProposal {
  return {
    attemptId: ids.attempt(attemptId),
    turn,
    call: { toolCallId: `${attemptId}-${turn}`, name, arguments: args },
  }
}

function observation(toolName: string, ok: boolean): ToolObservation {
  return {
    toolCallId: "unused-by-runtime",
    toolName,
    ok,
    content: ok ? "completed" : "failed",
  }
}
