import type {
  AdmissionResult,
  AttemptRef,
  ChaosUnitContract,
  CheckpointDirective,
  MissionContract,
  MissionGap,
  RequirementVerification,
} from "../contracts/contracts.js"
import type {
  AttemptId,
  CheckpointId,
  MissionId,
  Timestamp,
  UnitId,
} from "../contracts/ids.js"

export type DomainCommand =
  | {
      type: "CreateMission"
      contract: MissionContract
    }
  | {
      type: "ProposeChaosUnit"
      contract: ChaosUnitContract
      occurredAt: Timestamp
    }
  | {
      type: "RecordAdmissionResult"
      missionId: MissionId
      unitId: UnitId
      unitRevision: number
      result: AdmissionResult
      executionCheckpointId: CheckpointId
      occurredAt: Timestamp
    }
  | {
      type: "ResolveCheckpoint"
      missionId: MissionId
      checkpointId: CheckpointId
      resolutionKey: string
      directives: CheckpointDirective[]
      occurredAt: Timestamp
    }
  | {
      type: "RecordAttemptStarted"
      missionId: MissionId
      attempt: AttemptRef
      occurredAt: Timestamp
    }
  | {
      type: "ProposeCompletion"
      missionId: MissionId
      attemptId: AttemptId
      occurredAt: Timestamp
    }
  | {
      type: "RequestInterruptedVerification"
      missionId: MissionId
      attemptId: AttemptId
      occurredAt: Timestamp
    }
  | {
      type: "RecordVerificationResult"
      missionId: MissionId
      unitId: UnitId
      unitRevision: number
      attemptId: AttemptId
      results: RequirementVerification[]
      verificationGapCheckpointId: CheckpointId
      occurredAt: Timestamp
    }
  | {
      type: "RecordMissionGap"
      missionId: MissionId
      gap: MissionGap
      occurredAt: Timestamp
    }
  | {
      type: "ResumeMission"
      missionId: MissionId
      checkpointId: CheckpointId
      occurredAt: Timestamp
    }
  | {
      type: "CancelMission"
      missionId: MissionId
      reason: string
      occurredAt: Timestamp
    }
