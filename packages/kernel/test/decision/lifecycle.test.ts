import { describe, expect, it } from "vitest"
import {
  DomainError,
  decide,
  ids,
  unitKey,
  type DomainErrorCode,
} from "../../src/index.js"
import {
  admittedUnit,
  admission,
  applyCommand,
  createdMission,
  fixtureIds,
  missionContract,
  proposedUnit,
  readyUnit,
  runningAttempt,
  unitContract,
  verifyingUnit,
} from "./fixtures.js"

function expectDomainError(action: () => unknown, code: DomainErrorCode): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe(code)
  }
}

describe("Slice A decisions", () => {
  it("records controller interruption as stopped verification, never a model completion", () => {
    const result = applyCommand(runningAttempt(), {
      type: "RequestInterruptedVerification", missionId: fixtureIds.mission,
      attemptId: fixtureIds.attempt, occurredAt: fixtureIds.now,
    })
    expect(result.events.map((event) => event.type)).toEqual(["InterruptedVerificationRequested", "AttemptClosed"])
    expect(result.projection.attempts[fixtureIds.attempt]?.status).toBe("stopped")
    expect(result.projection.units[unitKey(fixtureIds.unit, 1)]?.status).toBe("verifying")
    expectDomainError(() => decide(result.projection, {
      type: "RequestInterruptedVerification", missionId: fixtureIds.mission,
      attemptId: fixtureIds.attempt, occurredAt: fixtureIds.now,
    }), "ATTEMPT_NOT_RUNNING")
  })
  it("rejects attempts before admission and before the execution gate resolves", () => {
    const attempt = {
      attemptId: fixtureIds.attempt,
      unitId: fixtureIds.unit,
      unitRevision: 1,
      projectionId: fixtureIds.projection,
    }

    expectDomainError(
      () =>
        decide(proposedUnit(), {
          type: "RecordAttemptStarted",
          missionId: fixtureIds.mission,
          attempt,
          occurredAt: fixtureIds.now,
        }),
      "ATTEMPT_NOT_ALLOWED",
    )
    expectDomainError(
      () =>
        decide(admittedUnit(), {
          type: "RecordAttemptStarted",
          missionId: fixtureIds.mission,
          attempt,
          occurredAt: fixtureIds.now,
        }),
      "ATTEMPT_NOT_ALLOWED",
    )
  })

  it("requires admission accepted to equal all seven checks", () => {
    const invalid = admission()
    invalid.checks[0] = { ...invalid.checks[0]!, passed: false }

    expectDomainError(
      () =>
        decide(proposedUnit(), {
          type: "RecordAdmissionResult",
          missionId: fixtureIds.mission,
          unitId: fixtureIds.unit,
          unitRevision: 1,
          result: invalid,
          executionCheckpointId: fixtureIds.checkpoint,
          occurredAt: fixtureIds.now,
        }),
      "ADMISSION_INVALID",
    )
  })

  it("makes checkpoint resolution idempotent by resolution key", () => {
    const projection = readyUnit()
    const retry = decide(projection, {
      type: "ResolveCheckpoint",
      missionId: fixtureIds.mission,
      checkpointId: fixtureIds.checkpoint,
      resolutionKey: "allow-execution",
      directives: [{ type: "continue" }],
      occurredAt: fixtureIds.now,
    })
    expect(retry).toEqual([])

    expectDomainError(
      () =>
        decide(projection, {
          type: "ResolveCheckpoint",
          missionId: fixtureIds.mission,
          checkpointId: fixtureIds.checkpoint,
          resolutionKey: "conflicting-retry",
          directives: [{ type: "continue" }],
          occurredAt: fixtureIds.now,
        }),
      "CHECKPOINT_ALREADY_RESOLVED",
    )
  })

  it("allows only one active unit and one running attempt", () => {
    expectDomainError(
      () =>
        decide(proposedUnit(), {
          type: "ProposeChaosUnit",
          contract: { ...unitContract(), unitId: ids.unit("unit-2") },
          occurredAt: fixtureIds.now,
        }),
      "ACTIVE_UNIT_EXISTS",
    )

    expectDomainError(
      () =>
        decide(runningAttempt(), {
          type: "RecordAttemptStarted",
          missionId: fixtureIds.mission,
          attempt: {
            attemptId: fixtureIds.attempt2,
            unitId: fixtureIds.unit,
            unitRevision: 1,
            projectionId: ids.projection("projection-2"),
          },
          occurredAt: fixtureIds.now,
        }),
      "ATTEMPT_NOT_ALLOWED",
    )
  })

  it("treats final output as a proposal and requires verification", () => {
    const projection = verifyingUnit()
    const key = unitKey(fixtureIds.unit, 1)
    expect(projection.units[key]?.status).toBe("verifying")
    expect(projection.units[key]?.completionProposed).toBe(true)
    expect(projection.units[key]?.status).not.toBe("completed")

    const failed = applyCommand(projection, {
      type: "RecordVerificationResult",
      missionId: fixtureIds.mission,
      unitId: fixtureIds.unit,
      unitRevision: 1,
      attemptId: fixtureIds.attempt,
      results: [
        {
          requirementId: fixtureIds.requirement,
          passed: false,
          reason: "evidence is missing",
        },
      ],
      verificationGapCheckpointId: fixtureIds.verificationGap,
      occurredAt: fixtureIds.now,
    })
    expect(failed.events.map((event) => event.type)).toEqual([
      "VerificationFailed",
      "CheckpointOpened",
    ])
    expect(failed.projection.units[key]?.status).toBe("checkpoint")
  })

  it("completes a unit before separately closing the mission", () => {
    const unitDone = applyCommand(verifyingUnit(), {
      type: "RecordVerificationResult",
      missionId: fixtureIds.mission,
      unitId: fixtureIds.unit,
      unitRevision: 1,
      attemptId: fixtureIds.attempt,
      results: [
        {
          requirementId: fixtureIds.requirement,
          passed: true,
          reason: "domain tests passed",
        },
      ],
      verificationGapCheckpointId: fixtureIds.verificationGap,
      occurredAt: fixtureIds.now,
    })
    const key = unitKey(fixtureIds.unit, 1)
    expect(unitDone.projection.units[key]?.status).toBe("completed")
    expect(unitDone.projection.mission?.status).toBe("active")
    expect(unitDone.projection.activeUnitKey).toBeUndefined()

    const missionDone = applyCommand(unitDone.projection, {
      type: "RecordMissionGap",
      missionId: fixtureIds.mission,
      gap: {
        missionId: fixtureIds.mission,
        items: [],
        unmetRequirementIds: [],
        satisfiedRequirementIds: [fixtureIds.requirement],
        assessedAtSequence: unitDone.projection.appliedEventCount,
      },
      occurredAt: fixtureIds.now,
    })
    expect(missionDone.events.map((event) => event.type)).toEqual([
      "MissionGapAnalyzed",
      "MissionSucceeded",
    ])
    expect(missionDone.projection.mission?.status).toBe("succeeded")

    expectDomainError(
      () =>
        decide(missionDone.projection, {
          type: "CancelMission",
          missionId: fixtureIds.mission,
          reason: "too late",
          occurredAt: fixtureIds.now,
        }),
      "MISSION_TERMINAL",
    )
  })

  it("halts and resumes only through explicit checkpoints", () => {
    const suspended = applyCommand(admittedUnit(), {
      type: "ResolveCheckpoint",
      missionId: fixtureIds.mission,
      checkpointId: fixtureIds.checkpoint,
      resolutionKey: "halt-before-execution",
      directives: [{ type: "halt", reason: "human review required" }],
      occurredAt: fixtureIds.now,
    })
    expect(suspended.projection.mission?.status).toBe("suspended")

    const resumed = applyCommand(suspended.projection, {
      type: "ResumeMission",
      missionId: fixtureIds.mission,
      checkpointId: fixtureIds.resumeCheckpoint,
      occurredAt: fixtureIds.now,
    })
    expect(resumed.events.map((event) => event.type)).toEqual([
      "MissionResumed",
      "CheckpointOpened",
    ])
    expect(resumed.projection.mission?.status).toBe("waiting")
  })

  it("rejects conflicting structural checkpoint directives", () => {
    expectDomainError(
      () =>
        decide(admittedUnit(), {
          type: "ResolveCheckpoint",
          missionId: fixtureIds.mission,
          checkpointId: fixtureIds.checkpoint,
          resolutionKey: "conflict",
          directives: [
            { type: "halt", reason: "stop" },
            { type: "reroute", direction: "another path" },
          ],
          occurredAt: fixtureIds.now,
        }),
      "CHECKPOINT_DIRECTIVE_CONFLICT",
    )
  })

  it("rejects a second mission", () => {
    expectDomainError(
      () =>
        decide(createdMission(), {
          type: "CreateMission",
          contract: missionContractWithId(ids.mission("mission-2")),
        }),
      "MISSION_ALREADY_EXISTS",
    )
  })
})

function missionContractWithId(missionId: ReturnType<typeof ids.mission>) {
  return {
    ...missionContract(),
    missionId,
  }
}
