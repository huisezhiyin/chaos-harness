import { DomainError } from "../errors/domain-error.js"
import type { RunProjection, UnitProjection } from "../projections/projection.js"
import { unitKey } from "../projections/projection.js"

const activeUnitStatuses = new Set<UnitProjection["status"]>([
  "proposed",
  "ready",
  "running",
  "checkpoint",
  "halted",
  "verifying",
])

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new DomainError("INVARIANT_VIOLATION", message)
  }
}

export function assertInvariants(projection: RunProjection): RunProjection {
  const units = Object.values(projection.units)
  const activeUnits = units.filter((unit) => activeUnitStatuses.has(unit.status))

  invariant(
    projection.mission !== undefined || units.length === 0,
    "unit state cannot exist without a mission",
  )

  invariant(activeUnits.length <= 1, "a mission can have at most one active unit")

  if (projection.activeUnitKey === undefined) {
    invariant(activeUnits.length === 0, "active unit key is missing")
  } else {
    const activeUnit = projection.units[projection.activeUnitKey]
    invariant(activeUnit !== undefined, "active unit key points to no unit")
    invariant(activeUnitStatuses.has(activeUnit.status), "active unit key points to a terminal unit")
    invariant(activeUnits.length === 1, "active unit key does not match active units")
  }

  const runningAttempts = Object.values(projection.attempts).filter(
    (attempt) => attempt.status === "running",
  )
  invariant(runningAttempts.length <= 1, "a mission can have at most one running attempt")

  for (const attempt of Object.values(projection.attempts)) {
    const key = unitKey(attempt.ref.unitId, attempt.ref.unitRevision)
    const unit = projection.units[key]
    invariant(unit !== undefined, `attempt ${attempt.ref.attemptId} references an unknown unit`)
    invariant(unit.contract.revision === attempt.ref.unitRevision, "attempt revision drifted")

    if (attempt.status === "running") {
      invariant(unit.admission?.accepted === true, "a running attempt requires admitted unit")
      invariant(
        unit.status === "running" || unit.status === "verifying",
        "a running attempt requires an executing unit",
      )
    }
  }

  for (const unit of units) {
    invariant(
      !(unit.completionProposed && unit.status === "completed" && unit.verification === undefined),
      "completion proposal cannot complete a unit without verification",
    )

    if (unit.status === "completed") {
      invariant(unit.verification !== undefined, "completed unit requires verification results")
      const results = new Map(
        unit.verification.map((result) => [result.requirementId, result.passed] as const),
      )
      const mandatoryPassed = unit.contract.doneRequirements
        .filter((requirement) => requirement.mandatory)
        .every((requirement) => results.get(requirement.requirementId) === true)
      invariant(mandatoryPassed, "completed unit has unmet mandatory requirements")
    }

    const unitRunningAttempts = runningAttempts.filter(
      (attempt) =>
        attempt.ref.unitId === unit.contract.unitId &&
        attempt.ref.unitRevision === unit.contract.revision,
    )
    invariant(unitRunningAttempts.length <= 1, "a unit can have at most one running attempt")
  }

  for (const checkpoint of Object.values(projection.checkpoints)) {
    const unit = projection.units[unitKey(checkpoint.unitId, checkpoint.unitRevision)]
    invariant(unit !== undefined, `checkpoint ${checkpoint.checkpointId} references an unknown unit`)
  }

  return projection
}
