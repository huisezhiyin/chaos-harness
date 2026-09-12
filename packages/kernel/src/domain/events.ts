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
  EventId,
  MissionId,
  Timestamp,
  UnitId,
} from "../contracts/ids.js"

export type DomainEvent =
  | { type: "MissionCreated"; contract: MissionContract }
  | {
      type: "ChaosUnitProposed"
      contract: ChaosUnitContract
      occurredAt: Timestamp
    }
  | {
      type: "ChaosUnitAdmitted"
      unitId: UnitId
      unitRevision: number
      result: AdmissionResult
      occurredAt: Timestamp
    }
  | {
      type: "ChaosUnitRejected"
      unitId: UnitId
      unitRevision: number
      result: AdmissionResult
      occurredAt: Timestamp
    }
  | {
      type: "CheckpointOpened"
      checkpointId: CheckpointId
      kind: CheckpointKind
      unitId: UnitId
      unitRevision: number
      occurredAt: Timestamp
    }
  | {
      type: "CheckpointResolved"
      checkpointId: CheckpointId
      resolutionKey: string
      directives: CheckpointDirective[]
      occurredAt: Timestamp
    }
  | { type: "AttemptStarted"; attempt: AttemptRef; occurredAt: Timestamp }
  | {
      type: "AttemptClosed"
      attemptId: AttemptId
      outcome: "completed" | "failed" | "stopped"
      occurredAt: Timestamp
    }
  | {
      type: "CompletionProposed"
      attemptId: AttemptId
      unitId: UnitId
      unitRevision: number
      occurredAt: Timestamp
    }
  | {
      type: "InterruptedVerificationRequested"
      attemptId: AttemptId
      unitId: UnitId
      unitRevision: number
      occurredAt: Timestamp
    }
  | {
      type: "VerificationPassed"
      unitId: UnitId
      unitRevision: number
      attemptId: AttemptId
      results: RequirementVerification[]
      occurredAt: Timestamp
    }
  | {
      type: "VerificationFailed"
      unitId: UnitId
      unitRevision: number
      attemptId: AttemptId
      results: RequirementVerification[]
      occurredAt: Timestamp
    }
  | {
      type: "ChaosUnitCompleted"
      unitId: UnitId
      unitRevision: number
      occurredAt: Timestamp
    }
  | { type: "MissionGapAnalyzed"; gap: MissionGap; occurredAt: Timestamp }
  | { type: "MissionContinuationRequired"; occurredAt: Timestamp }
  | { type: "MissionSuspended"; reason: string; occurredAt: Timestamp }
  | { type: "MissionResumed"; occurredAt: Timestamp }
  | { type: "MissionSucceeded"; occurredAt: Timestamp }
  | { type: "MissionCancelled"; reason: string; occurredAt: Timestamp }

export interface EventEnvelope<Event extends DomainEvent = DomainEvent> {
  eventId: EventId
  eventType: Event["type"]
  schemaVersion: 1
  missionId: MissionId
  sequence: number
  occurredAt: Timestamp
  correlationId: string
  causationId: string
  payload: Event
}
