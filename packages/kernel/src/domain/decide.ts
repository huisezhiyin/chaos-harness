import { admissionCriteria, type AdmissionResult, type CheckpointDirective } from "../contracts/contracts.js"
import type { MissionId } from "../contracts/ids.js"
import { fail } from "../errors/domain-error.js"
import type { RunProjection, UnitProjection } from "../projections/projection.js"
import { unitKey } from "../projections/projection.js"
import type { DomainCommand } from "./commands.js"
import type { DomainEvent } from "./events.js"

const terminalMissionStatuses = new Set(["succeeded", "failed", "cancelled"])

function missionFor(projection: RunProjection, missionId: MissionId) {
  const mission = projection.mission
  if (mission === undefined) {
    fail("MISSION_NOT_FOUND", "mission does not exist")
  }
  if (mission.contract.missionId !== missionId) {
    fail("MISSION_ID_MISMATCH", "command targets a different mission")
  }
  return mission
}

function writableMission(projection: RunProjection, missionId: MissionId) {
  const mission = missionFor(projection, missionId)
  if (terminalMissionStatuses.has(mission.status)) {
    fail("MISSION_TERMINAL", `mission is terminal: ${mission.status}`)
  }
  return mission
}

function activeUnit(projection: RunProjection): UnitProjection {
  const key = projection.activeUnitKey
  const unit = key === undefined ? undefined : projection.units[key]
  if (unit === undefined) {
    fail("UNIT_NOT_FOUND", "mission has no active unit")
  }
  return unit
}

function validateAdmission(result: AdmissionResult): void {
  const seen = new Set(result.checks.map((check) => check.criterion))
  const complete =
    result.checks.length === admissionCriteria.length &&
    seen.size === admissionCriteria.length &&
    admissionCriteria.every((criterion) => seen.has(criterion))
  const accepted = complete && result.checks.every((check) => check.passed)

  if (!complete || accepted !== result.accepted) {
    fail(
      "ADMISSION_INVALID",
      "accepted must be the conjunction of all seven unique admission checks",
    )
  }
}

function validateDirectives(directives: readonly CheckpointDirective[]): void {
  const structural = directives.filter((directive) =>
    ["halt", "reroute", "rewind"].includes(directive.type),
  )
  if (structural.length > 1) {
    fail(
      "CHECKPOINT_DIRECTIVE_CONFLICT",
      "a resolution can contain at most one structural directive",
    )
  }
  if (structural.some((directive) => directive.type === "reroute" || directive.type === "rewind")) {
    fail("SLICE_NOT_IMPLEMENTED", "reroute and rewind belong to Slice B")
  }
}

export function decide(projection: RunProjection, command: DomainCommand): DomainEvent[] {
  switch (command.type) {
    case "CreateMission":
      if (projection.mission !== undefined) {
        fail("MISSION_ALREADY_EXISTS", "projection already contains a mission")
      }
      return [{ type: "MissionCreated", contract: command.contract }]

    case "ProposeChaosUnit": {
      const mission = writableMission(projection, command.contract.missionId)
      if (mission.status !== "active") {
        fail("MISSION_NOT_ACTIVE", `cannot propose a unit while mission is ${mission.status}`)
      }
      if (projection.activeUnitKey !== undefined) {
        fail("ACTIVE_UNIT_EXISTS", "mission already has an active unit")
      }
      if (command.contract.revision < 1) {
        fail("UNIT_REVISION_MISMATCH", "initial unit revision must be at least 1")
      }
      return [
        {
          type: "ChaosUnitProposed",
          contract: command.contract,
          occurredAt: command.occurredAt,
        },
      ]
    }

    case "RecordAdmissionResult": {
      writableMission(projection, command.missionId)
      validateAdmission(command.result)
      const unit = projection.units[unitKey(command.unitId, command.unitRevision)]
      if (unit === undefined) {
        fail("UNIT_NOT_FOUND", "admission targets an unknown unit")
      }
      if (unit.status !== "proposed" || unit.admission !== undefined) {
        fail("UNIT_NOT_PROPOSED", "only a fresh proposed unit can be admitted")
      }

      if (!command.result.accepted) {
        return [
          {
            type: "ChaosUnitRejected",
            unitId: command.unitId,
            unitRevision: command.unitRevision,
            result: command.result,
            occurredAt: command.occurredAt,
          },
        ]
      }

      if (projection.checkpoints[command.executionCheckpointId] !== undefined) {
        fail("CHECKPOINT_ALREADY_RESOLVED", "checkpoint id already exists")
      }
      return [
        {
          type: "ChaosUnitAdmitted",
          unitId: command.unitId,
          unitRevision: command.unitRevision,
          result: command.result,
          occurredAt: command.occurredAt,
        },
        {
          type: "CheckpointOpened",
          checkpointId: command.executionCheckpointId,
          kind: "execution_gate",
          unitId: command.unitId,
          unitRevision: command.unitRevision,
          occurredAt: command.occurredAt,
        },
      ]
    }

    case "ResolveCheckpoint": {
      writableMission(projection, command.missionId)
      const checkpoint = projection.checkpoints[command.checkpointId]
      if (checkpoint === undefined) {
        fail("CHECKPOINT_NOT_FOUND", "checkpoint does not exist")
      }
      if (checkpoint.status === "resolved") {
        if (checkpoint.resolutionKey === command.resolutionKey) {
          return []
        }
        fail("CHECKPOINT_ALREADY_RESOLVED", "checkpoint was resolved with another key")
      }
      validateDirectives(command.directives)
      const events: DomainEvent[] = [
        {
          type: "CheckpointResolved",
          checkpointId: command.checkpointId,
          resolutionKey: command.resolutionKey,
          directives: command.directives,
          occurredAt: command.occurredAt,
        },
      ]
      const halt = command.directives.find((directive) => directive.type === "halt")
      if (halt?.type === "halt") {
        events.push({
          type: "MissionSuspended",
          reason: halt.reason,
          occurredAt: command.occurredAt,
        })
      }
      return events
    }

    case "RecordAttemptStarted": {
      writableMission(projection, command.missionId)
      const unit = activeUnit(projection)
      if (
        unit.contract.unitId !== command.attempt.unitId ||
        unit.contract.revision !== command.attempt.unitRevision
      ) {
        fail("UNIT_REVISION_MISMATCH", "attempt must bind the exact active unit revision")
      }
      if (unit.admission?.accepted !== true || unit.status !== "ready") {
        fail("ATTEMPT_NOT_ALLOWED", "attempt requires admitted unit and resolved execution gate")
      }
      if (projection.attempts[command.attempt.attemptId] !== undefined) {
        fail("ATTEMPT_ALREADY_RUNNING", "attempt id already exists")
      }
      if (Object.values(projection.attempts).some((attempt) => attempt.status === "running")) {
        fail("ATTEMPT_ALREADY_RUNNING", "mission already has a running attempt")
      }
      return [
        { type: "AttemptStarted", attempt: command.attempt, occurredAt: command.occurredAt },
      ]
    }

    case "ProposeCompletion":
    case "RequestInterruptedVerification": {
      writableMission(projection, command.missionId)
      const attempt = projection.attempts[command.attemptId]
      if (attempt === undefined) {
        fail("ATTEMPT_NOT_FOUND", "attempt does not exist")
      }
      if (attempt.status !== "running") {
        fail("ATTEMPT_NOT_RUNNING", "only a running attempt can propose completion")
      }
      return [
        {
          type: command.type === "ProposeCompletion" ? "CompletionProposed" : "InterruptedVerificationRequested",
          attemptId: command.attemptId,
          unitId: attempt.ref.unitId,
          unitRevision: attempt.ref.unitRevision,
          occurredAt: command.occurredAt,
        },
        {
          type: "AttemptClosed",
          attemptId: command.attemptId,
          outcome: command.type === "ProposeCompletion" ? "completed" : "stopped",
          occurredAt: command.occurredAt,
        },
      ]
    }

    case "RecordVerificationResult": {
      writableMission(projection, command.missionId)
      const key = unitKey(command.unitId, command.unitRevision)
      const unit = projection.units[key]
      if (unit === undefined) {
        fail("UNIT_NOT_FOUND", "verification targets an unknown unit")
      }
      if (unit.status !== "verifying" || !unit.completionProposed) {
        fail("UNIT_NOT_VERIFYING", "unit has no completion proposal to verify")
      }
      const attempt = projection.attempts[command.attemptId]
      if (
        attempt === undefined ||
        attempt.ref.unitId !== command.unitId ||
        attempt.ref.unitRevision !== command.unitRevision
      ) {
        fail("ATTEMPT_NOT_FOUND", "verification attempt does not match unit revision")
      }
      const known = new Set(unit.contract.doneRequirements.map((item) => item.requirementId))
      const resultIds = command.results.map((result) => result.requirementId)
      if (
        new Set(resultIds).size !== resultIds.length ||
        resultIds.some((requirementId) => !known.has(requirementId))
      ) {
        fail("VERIFICATION_INVALID", "verification results must be unique and known")
      }
      const resultMap = new Map(
        command.results.map((result) => [result.requirementId, result.passed] as const),
      )
      const passed = unit.contract.doneRequirements
        .filter((requirement) => requirement.mandatory)
        .every((requirement) => resultMap.get(requirement.requirementId) === true)
      const verificationEvent: DomainEvent = {
        type: passed ? "VerificationPassed" : "VerificationFailed",
        unitId: command.unitId,
        unitRevision: command.unitRevision,
        attemptId: command.attemptId,
        results: command.results,
        occurredAt: command.occurredAt,
      }
      if (passed) {
        return [
          verificationEvent,
          {
            type: "ChaosUnitCompleted",
            unitId: command.unitId,
            unitRevision: command.unitRevision,
            occurredAt: command.occurredAt,
          },
          { type: "MissionContinuationRequired", occurredAt: command.occurredAt },
        ]
      }
      if (projection.checkpoints[command.verificationGapCheckpointId] !== undefined) {
        fail("CHECKPOINT_ALREADY_RESOLVED", "verification gap checkpoint id already exists")
      }
      return [
        verificationEvent,
        {
          type: "CheckpointOpened",
          checkpointId: command.verificationGapCheckpointId,
          kind: "verification_gap",
          unitId: command.unitId,
          unitRevision: command.unitRevision,
          occurredAt: command.occurredAt,
        },
      ]
    }

    case "RecordMissionGap": {
      const mission = writableMission(projection, command.missionId)
      if (projection.activeUnitKey !== undefined) {
        fail("ACTIVE_UNIT_EXISTS", "mission gap closes only outside an active unit")
      }
      if (command.gap.missionId !== mission.contract.missionId) {
        fail("GAP_INVALID", "gap belongs to another mission")
      }
      const events: DomainEvent[] = [
        { type: "MissionGapAnalyzed", gap: command.gap, occurredAt: command.occurredAt },
      ]
      if (command.gap.items.length === 0 && command.gap.unmetRequirementIds.length === 0) {
        events.push({ type: "MissionSucceeded", occurredAt: command.occurredAt })
      }
      return events
    }

    case "ResumeMission": {
      const mission = writableMission(projection, command.missionId)
      if (mission.status !== "suspended") {
        fail("MISSION_NOT_ACTIVE", "only a suspended mission can resume")
      }
      const unit = activeUnit(projection)
      if (unit.status !== "halted") {
        fail("MISSION_NOT_ACTIVE", "suspended mission must have a halted active unit")
      }
      if (projection.checkpoints[command.checkpointId] !== undefined) {
        fail("CHECKPOINT_ALREADY_RESOLVED", "resume checkpoint id already exists")
      }
      return [
        { type: "MissionResumed", occurredAt: command.occurredAt },
        {
          type: "CheckpointOpened",
          checkpointId: command.checkpointId,
          kind: "failure_recovery",
          unitId: unit.contract.unitId,
          unitRevision: unit.contract.revision,
          occurredAt: command.occurredAt,
        },
      ]
    }

    case "CancelMission":
      writableMission(projection, command.missionId)
      return [
        {
          type: "MissionCancelled",
          reason: command.reason,
          occurredAt: command.occurredAt,
        },
      ]
  }
}
