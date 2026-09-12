import type {
  AdmissionResult,
  AttemptRef,
  ChaosUnitContract,
  CheckpointDirective,
  CheckpointKind,
  MissionContract,
  MissionGap,
  RequirementVerification,
} from "../contracts/contracts.js"
import type {
  AttemptId,
  CheckpointId,
  Timestamp,
  UnitId,
} from "../contracts/ids.js"

export type MissionStatus =
  | "active"
  | "waiting"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled"

export type UnitStatus =
  | "proposed"
  | "ready"
  | "running"
  | "checkpoint"
  | "halted"
  | "verifying"
  | "completed"
  | "rewound"
  | "failed"

export type AttemptStatus = "starting" | "running" | "stopped" | "completed" | "failed"

export interface MissionProjection {
  contract: MissionContract
  status: MissionStatus
  latestGap?: MissionGap
}

export interface UnitProjection {
  contract: ChaosUnitContract
  status: UnitStatus
  admission?: AdmissionResult
  activeAttemptId?: AttemptId
  completionProposed: boolean
  verification?: RequirementVerification[]
}

export interface AttemptProjection {
  ref: AttemptRef
  status: AttemptStatus
  startedAt: Timestamp
  closedAt?: Timestamp
}

export interface CheckpointProjection {
  checkpointId: CheckpointId
  kind: CheckpointKind
  unitId: UnitId
  unitRevision: number
  status: "open" | "resolved"
  openedAt: Timestamp
  resolutionKey?: string
  directives: CheckpointDirective[]
  resolvedAt?: Timestamp
}

export interface RunProjection {
  mission?: MissionProjection
  units: Readonly<Record<string, UnitProjection>>
  attempts: Readonly<Record<string, AttemptProjection>>
  checkpoints: Readonly<Record<string, CheckpointProjection>>
  activeUnitKey?: string
  appliedEventCount: number
}

export function initialProjection(): RunProjection {
  return {
    units: {},
    attempts: {},
    checkpoints: {},
    appliedEventCount: 0,
  }
}

export function unitKey(unitId: UnitId, revision: number): string {
  return `${unitId}@${revision}`
}
