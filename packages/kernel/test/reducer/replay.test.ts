import { describe, expect, it } from "vitest"
import {
  DomainError,
  evolve,
  initialProjection,
  replay,
  unitKey,
  type DomainCommand,
  type DomainEvent,
} from "../../src/index.js"
import {
  admission,
  applyCommand,
  fixtureIds,
  missionContract,
  unitContract,
  verifyingUnit,
} from "../decision/fixtures.js"

describe("Slice A reducer and replay", () => {
  it.each(["ProposeCompletion", "RequestInterruptedVerification"] as const)("replays a JSON-round-tripped %s event stream to the same projection", (terminalType) => {
    let projection = initialProjection()
    const stream: DomainEvent[] = []
    const commands: DomainCommand[] = [
      { type: "CreateMission", contract: missionContract() },
      {
        type: "ProposeChaosUnit",
        contract: unitContract(),
        occurredAt: fixtureIds.now,
      },
      {
        type: "RecordAdmissionResult",
        missionId: fixtureIds.mission,
        unitId: fixtureIds.unit,
        unitRevision: 1,
        result: admission(),
        executionCheckpointId: fixtureIds.checkpoint,
        occurredAt: fixtureIds.now,
      },
      {
        type: "ResolveCheckpoint",
        missionId: fixtureIds.mission,
        checkpointId: fixtureIds.checkpoint,
        resolutionKey: "allow-execution",
        directives: [{ type: "continue" }],
        occurredAt: fixtureIds.now,
      },
      {
        type: "RecordAttemptStarted",
        missionId: fixtureIds.mission,
        attempt: {
          attemptId: fixtureIds.attempt,
          unitId: fixtureIds.unit,
          unitRevision: 1,
          projectionId: fixtureIds.projection,
        },
        occurredAt: fixtureIds.now,
      },
      {
        type: terminalType,
        missionId: fixtureIds.mission,
        attemptId: fixtureIds.attempt,
        occurredAt: fixtureIds.now,
      },
    ]

    for (const command of commands) {
      const result = applyCommand(projection, command)
      projection = result.projection
      stream.push(...result.events)
    }

    const serialized = JSON.stringify(stream)
    const restored = JSON.parse(serialized) as DomainEvent[]
    expect(replay(restored)).toEqual(projection)
  })

  it("rejects an attempt event that references an unknown unit", () => {
    const event: DomainEvent = {
      type: "AttemptStarted",
      attempt: {
        attemptId: fixtureIds.attempt,
        unitId: fixtureIds.unit,
        unitRevision: 1,
        projectionId: fixtureIds.projection,
      },
      occurredAt: fixtureIds.now,
    }
    expect(() => evolve(initialProjection(), event)).toThrowError(DomainError)
  })

  it("rejects unit completion without verification evidence", () => {
    const projection = verifyingUnit()
    const event: DomainEvent = {
      type: "ChaosUnitCompleted",
      unitId: fixtureIds.unit,
      unitRevision: 1,
      occurredAt: fixtureIds.now,
    }
    expect(() => evolve(projection, event)).toThrowError(
      expect.objectContaining({ code: "INVARIANT_VIOLATION" }),
    )
  })

  it("keeps completion proposal distinct from completion", () => {
    const projection = verifyingUnit()
    const unit = projection.units[unitKey(fixtureIds.unit, 1)]
    expect(unit?.completionProposed).toBe(true)
    expect(unit?.status).toBe("verifying")
    expect(unit?.verification).toBeUndefined()
  })
})
