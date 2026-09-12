import {
  admissionCriteria,
  decide,
  evolve,
  ids,
  initialProjection,
  type AdmissionResult,
  type ChaosUnitContract,
  type DomainCommand,
  type DomainEvent,
  type MissionContract,
  type RunProjection,
} from "../../src/index.js"

export const fixtureIds = {
  mission: ids.mission("mission-1"),
  unit: ids.unit("unit-1"),
  attempt: ids.attempt("attempt-1"),
  attempt2: ids.attempt("attempt-2"),
  projection: ids.projection("projection-1"),
  checkpoint: ids.checkpoint("checkpoint-1"),
  verificationGap: ids.checkpoint("checkpoint-verification-gap"),
  resumeCheckpoint: ids.checkpoint("checkpoint-resume"),
  requirement: ids.requirement("requirement-1"),
  now: ids.timestamp("2026-08-04T10:00:00.000Z"),
} as const

export function missionContract(): MissionContract {
  return {
    missionId: fixtureIds.mission,
    goal: "prove the pure domain lifecycle",
    boundaries: [],
    doneRequirements: [
      {
        requirementId: fixtureIds.requirement,
        description: "domain lifecycle is verified",
        mandatory: true,
        acceptedEvidenceKinds: ["test"],
      },
    ],
    budget: { maxAttempts: 2, maxTurns: 10, maxActions: 20 },
    createdAt: fixtureIds.now,
  }
}

export function unitContract(): ChaosUnitContract {
  return {
    unitId: fixtureIds.unit,
    revision: 1,
    missionId: fixtureIds.mission,
    sourceGapItemIds: [],
    whyNow: "it is the first executable domain slice",
    goal: "implement and verify Slice A",
    boundary: { include: ["packages/kernel"], exclude: ["adapters"] },
    freedom: ["choose pure TypeScript structures"],
    checkpointPlan: [{ trigger: "before_execution", required: true }],
    doneRequirements: [
      {
        requirementId: fixtureIds.requirement,
        description: "domain lifecycle is verified",
        mandatory: true,
        acceptedEvidenceKinds: ["test"],
      },
    ],
    invalidationConditions: ["requires a real model"],
    risk: { level: "low", channels: ["automated_tests"] },
    contextSelectors: [],
  }
}

export function admission(accepted = true): AdmissionResult {
  return {
    accepted,
    checks: admissionCriteria.map((criterion, index) => ({
      criterion,
      passed: accepted || index > 0,
      reason: accepted ? "satisfied" : "goal is ambiguous",
    })),
  }
}

export function applyCommand(
  projection: RunProjection,
  command: DomainCommand,
): { projection: RunProjection; events: DomainEvent[] } {
  const events = decide(projection, command)
  return {
    events,
    projection: events.reduce(evolve, projection),
  }
}

export function createdMission(): RunProjection {
  return applyCommand(initialProjection(), {
    type: "CreateMission",
    contract: missionContract(),
  }).projection
}

export function proposedUnit(): RunProjection {
  return applyCommand(createdMission(), {
    type: "ProposeChaosUnit",
    contract: unitContract(),
    occurredAt: fixtureIds.now,
  }).projection
}

export function admittedUnit(): RunProjection {
  return applyCommand(proposedUnit(), {
    type: "RecordAdmissionResult",
    missionId: fixtureIds.mission,
    unitId: fixtureIds.unit,
    unitRevision: 1,
    result: admission(),
    executionCheckpointId: fixtureIds.checkpoint,
    occurredAt: fixtureIds.now,
  }).projection
}

export function readyUnit(): RunProjection {
  return applyCommand(admittedUnit(), {
    type: "ResolveCheckpoint",
    missionId: fixtureIds.mission,
    checkpointId: fixtureIds.checkpoint,
    resolutionKey: "allow-execution",
    directives: [{ type: "continue" }],
    occurredAt: fixtureIds.now,
  }).projection
}

export function runningAttempt(): RunProjection {
  return applyCommand(readyUnit(), {
    type: "RecordAttemptStarted",
    missionId: fixtureIds.mission,
    attempt: {
      attemptId: fixtureIds.attempt,
      unitId: fixtureIds.unit,
      unitRevision: 1,
      projectionId: fixtureIds.projection,
    },
    occurredAt: fixtureIds.now,
  }).projection
}

export function verifyingUnit(): RunProjection {
  return applyCommand(runningAttempt(), {
    type: "ProposeCompletion",
    missionId: fixtureIds.mission,
    attemptId: fixtureIds.attempt,
    occurredAt: fixtureIds.now,
  }).projection
}
