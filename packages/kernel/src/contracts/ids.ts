declare const brand: unique symbol

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name
}

export type MissionId = Brand<string, "MissionId">
export type UnitId = Brand<string, "UnitId">
export type AttemptId = Brand<string, "AttemptId">
export type AttemptControlId = Brand<string, "AttemptControlId">
export type TurnId = Brand<string, "TurnId">
export type ActionId = Brand<string, "ActionId">
export type CheckpointId = Brand<string, "CheckpointId">
export type RequirementId = Brand<string, "RequirementId">
export type EvidenceId = Brand<string, "EvidenceId">
export type GapItemId = Brand<string, "GapItemId">
export type ProjectionId = Brand<string, "ProjectionId">
export type EventId = Brand<string, "EventId">
export type FactId = Brand<string, "FactId">
export type Timestamp = Brand<string, "Timestamp">

function nonEmpty<Value extends string>(value: string, label: string): Value {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }

  return value as Value
}

export const ids = {
  mission: (value: string): MissionId => nonEmpty(value, "MissionId"),
  unit: (value: string): UnitId => nonEmpty(value, "UnitId"),
  attempt: (value: string): AttemptId => nonEmpty(value, "AttemptId"),
  attemptControl: (value: string): AttemptControlId => nonEmpty(value, "AttemptControlId"),
  turn: (value: string): TurnId => nonEmpty(value, "TurnId"),
  action: (value: string): ActionId => nonEmpty(value, "ActionId"),
  checkpoint: (value: string): CheckpointId => nonEmpty(value, "CheckpointId"),
  requirement: (value: string): RequirementId => nonEmpty(value, "RequirementId"),
  evidence: (value: string): EvidenceId => nonEmpty(value, "EvidenceId"),
  gapItem: (value: string): GapItemId => nonEmpty(value, "GapItemId"),
  projection: (value: string): ProjectionId => nonEmpty(value, "ProjectionId"),
  event: (value: string): EventId => nonEmpty(value, "EventId"),
  fact: (value: string): FactId => nonEmpty(value, "FactId"),
  timestamp: (value: string): Timestamp => nonEmpty(value, "Timestamp"),
} as const
