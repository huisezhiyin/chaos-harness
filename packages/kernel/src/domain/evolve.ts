import type { DomainEvent } from "./events.js"
import { assertInvariants } from "./invariants.js"
import type {
  AttemptProjection,
  CheckpointProjection,
  MissionProjection,
  RunProjection,
  UnitProjection,
} from "../projections/projection.js"
import { initialProjection, unitKey } from "../projections/projection.js"
import { DomainError } from "../errors/domain-error.js"

function replaceUnit(
  projection: RunProjection,
  key: string,
  update: (unit: UnitProjection) => UnitProjection,
): RunProjection {
  const unit = projection.units[key]
  if (unit === undefined) {
    return projection
  }

  return {
    ...projection,
    units: { ...projection.units, [key]: update(unit) },
  }
}

function removeActiveUnit(projection: RunProjection): RunProjection {
  const { activeUnitKey: _activeUnitKey, ...rest } = projection
  return rest
}

function replaceMission(
  projection: RunProjection,
  update: (mission: MissionProjection) => MissionProjection,
): RunProjection {
  if (projection.mission === undefined) {
    throw new DomainError("INVARIANT_VIOLATION", "mission event has no mission")
  }

  return { ...projection, mission: update(projection.mission) }
}

export function evolve(current: RunProjection, event: DomainEvent): RunProjection {
  let next: RunProjection

  switch (event.type) {
    case "MissionCreated":
      next = {
        ...current,
        mission: { contract: event.contract, status: "active" },
      }
      break

    case "ChaosUnitProposed": {
      const key = unitKey(event.contract.unitId, event.contract.revision)
      next = {
        ...current,
        units: {
          ...current.units,
          [key]: {
            contract: event.contract,
            status: "proposed",
            completionProposed: false,
          },
        },
        activeUnitKey: key,
      }
      break
    }

    case "ChaosUnitAdmitted": {
      const key = unitKey(event.unitId, event.unitRevision)
      next = replaceUnit(current, key, (unit) => ({
        ...unit,
        admission: event.result,
        status: "ready",
      }))
      break
    }

    case "ChaosUnitRejected": {
      const key = unitKey(event.unitId, event.unitRevision)
      next = replaceUnit(current, key, (unit) => ({ ...unit, admission: event.result }))
      break
    }

    case "CheckpointOpened": {
      const checkpoint: CheckpointProjection = {
        checkpointId: event.checkpointId,
        kind: event.kind,
        unitId: event.unitId,
        unitRevision: event.unitRevision,
        status: "open",
        openedAt: event.occurredAt,
        directives: [],
      }
      const key = unitKey(event.unitId, event.unitRevision)
      next = replaceUnit(
        replaceMission(
          {
            ...current,
            checkpoints: { ...current.checkpoints, [event.checkpointId]: checkpoint },
          },
          (mission) => ({ ...mission, status: "waiting" }),
        ),
        key,
        (unit) => ({ ...unit, status: "checkpoint" }),
      )
      break
    }

    case "CheckpointResolved": {
      const checkpoint = current.checkpoints[event.checkpointId]
      if (checkpoint === undefined) {
        next = current
        break
      }
      const resolved: CheckpointProjection = {
        ...checkpoint,
        status: "resolved",
        resolutionKey: event.resolutionKey,
        directives: event.directives,
        resolvedAt: event.occurredAt,
      }
      const containsHalt = event.directives.some((directive) => directive.type === "halt")
      const key = unitKey(checkpoint.unitId, checkpoint.unitRevision)
      const withCheckpoint = {
        ...current,
        checkpoints: { ...current.checkpoints, [event.checkpointId]: resolved },
      }
      next = replaceUnit(
        containsHalt
          ? withCheckpoint
          : replaceMission(withCheckpoint, (mission) => ({ ...mission, status: "active" })),
        key,
        (unit) => (containsHalt ? unit : { ...unit, status: "ready" }),
      )
      break
    }

    case "AttemptStarted": {
      const attempt: AttemptProjection = {
        ref: event.attempt,
        status: "running",
        startedAt: event.occurredAt,
      }
      const key = unitKey(event.attempt.unitId, event.attempt.unitRevision)
      next = replaceUnit(
        {
          ...current,
          attempts: { ...current.attempts, [event.attempt.attemptId]: attempt },
        },
        key,
        (unit) => ({
          ...unit,
          status: "running",
          activeAttemptId: event.attempt.attemptId,
        }),
      )
      break
    }

    case "CompletionProposed":
    case "InterruptedVerificationRequested": {
      const key = unitKey(event.unitId, event.unitRevision)
      next = replaceUnit(current, key, (unit) => ({
        ...unit,
        completionProposed: true,
        status: "verifying",
      }))
      break
    }

    case "AttemptClosed": {
      const attempt = current.attempts[event.attemptId]
      if (attempt === undefined) {
        next = current
        break
      }
      const closedAttempt: AttemptProjection = {
        ...attempt,
        status: event.outcome,
        closedAt: event.occurredAt,
      }
      const key = unitKey(attempt.ref.unitId, attempt.ref.unitRevision)
      next = replaceUnit(
        {
          ...current,
          attempts: { ...current.attempts, [event.attemptId]: closedAttempt },
        },
        key,
        (unit) => {
          const { activeAttemptId: _activeAttemptId, ...rest } = unit
          return rest
        },
      )
      break
    }

    case "VerificationPassed":
    case "VerificationFailed": {
      const key = unitKey(event.unitId, event.unitRevision)
      next = replaceUnit(current, key, (unit) => ({
        ...unit,
        verification: event.results,
      }))
      break
    }

    case "ChaosUnitCompleted": {
      const key = unitKey(event.unitId, event.unitRevision)
      next = removeActiveUnit(
        replaceUnit(current, key, (unit) => ({ ...unit, status: "completed" })),
      )
      break
    }

    case "MissionGapAnalyzed":
      next = replaceMission(current, (mission) => ({ ...mission, latestGap: event.gap }))
      break

    case "MissionContinuationRequired":
      next = replaceMission(current, (mission) => ({ ...mission, status: "active" }))
      break

    case "MissionSuspended": {
      const activeKey = current.activeUnitKey
      next = replaceMission(current, (mission) => ({ ...mission, status: "suspended" }))
      if (activeKey !== undefined) {
        next = replaceUnit(next, activeKey, (unit) => ({ ...unit, status: "halted" }))
      }
      break
    }

    case "MissionResumed": {
      const activeKey = current.activeUnitKey
      next = replaceMission(current, (mission) => ({ ...mission, status: "active" }))
      if (activeKey !== undefined) {
        next = replaceUnit(next, activeKey, (unit) => ({ ...unit, status: "ready" }))
      }
      break
    }

    case "MissionSucceeded":
      next = replaceMission(current, (mission) => ({ ...mission, status: "succeeded" }))
      break

    case "MissionCancelled": {
      const units = Object.fromEntries(
        Object.entries(current.units).map(([key, unit]) => [
          key,
          unit.status === "completed" ? unit : { ...unit, status: "failed" as const },
        ]),
      )
      const attempts = Object.fromEntries(
        Object.entries(current.attempts).map(([key, attempt]) => [
          key,
          attempt.status === "running"
            ? { ...attempt, status: "stopped" as const, closedAt: event.occurredAt }
            : attempt,
        ]),
      )
      next = removeActiveUnit(
        replaceMission({ ...current, units, attempts }, (mission) => ({
          ...mission,
          status: "cancelled",
        })),
      )
      break
    }
  }

  return assertInvariants({ ...next, appliedEventCount: current.appliedEventCount + 1 })
}

export function replay(events: readonly DomainEvent[]): RunProjection {
  return events.reduce(evolve, initialProjection())
}
