import type {
  AttemptId,
  CheckpointId,
  GapItemId,
  MissionId,
  ProjectionId,
  RequirementId,
  Timestamp,
  UnitId,
} from "./ids.js"

export interface BoundaryRule {
  kind: "include" | "exclude"
  description: string
}

export type EvidenceKind =
  | "artifact"
  | "build"
  | "diff"
  | "human_confirmation"
  | "lint"
  | "runtime_observation"
  | "static_check"
  | "test"

export interface DoneRequirement {
  requirementId: RequirementId
  description: string
  mandatory: boolean
  acceptedEvidenceKinds: EvidenceKind[]
}

export interface ResourceBudget {
  maxAttempts?: number
  maxTurns?: number
  maxActions?: number
  workTokenTarget?: number
  maxCost?: number
}

export interface RiskProfile {
  level: "low" | "medium" | "high" | "critical"
  channels: string[]
}

export interface CheckpointRule {
  trigger: string
  required: boolean
}

export interface ContextSelector {
  source: string
  selector: string
}

export interface MissionContract {
  missionId: MissionId
  goal: string
  boundaries: BoundaryRule[]
  doneRequirements: DoneRequirement[]
  budget: ResourceBudget
  createdAt: Timestamp
}

export interface ChaosUnitContract {
  unitId: UnitId
  revision: number
  missionId: MissionId
  sourceGapItemIds: GapItemId[]
  whyNow: string
  goal: string
  boundary: {
    include: string[]
    exclude: string[]
  }
  freedom: string[]
  checkpointPlan: CheckpointRule[]
  doneRequirements: DoneRequirement[]
  invalidationConditions: string[]
  risk: RiskProfile
  contextSelectors: ContextSelector[]
}

export const admissionCriteria = [
  "goal_identifiable",
  "boundary_visible",
  "freedom_preserved",
  "outcome_verifiable",
  "failure_localizable",
  "context_focusable",
  "risk_channel_available",
] as const

export type AdmissionCriterion = (typeof admissionCriteria)[number]

export interface AdmissionResult {
  accepted: boolean
  checks: Array<{
    criterion: AdmissionCriterion
    passed: boolean
    reason: string
  }>
}

export type CheckpointKind =
  | "execution_gate"
  | "user_requested"
  | "policy_triggered"
  | "verification_gap"
  | "budget_exceeded"
  | "failure_recovery"
  | "unit_boundary"

export type CheckpointDirective =
  | { type: "continue" }
  | { type: "inquire"; question: string }
  | { type: "augment"; material: string }
  | { type: "reroute"; direction: string }
  | { type: "rewind"; targetCheckpointId: CheckpointId }
  | { type: "halt"; reason: string }

export interface AttemptRef {
  attemptId: AttemptId
  unitId: UnitId
  unitRevision: number
  projectionId: ProjectionId
  previousAttemptId?: AttemptId
  rewoundFromCheckpointId?: CheckpointId
}

export interface RequirementVerification {
  requirementId: RequirementId
  passed: boolean
  reason: string
}

export interface GapItem {
  gapItemId: GapItemId
  kind:
    | "unmet_outcome"
    | "missing_evidence"
    | "dependency"
    | "uncertainty"
    | "risk"
  description: string
  requirementId?: RequirementId
  blocksGapItemIds: GapItemId[]
}

export interface MissionGap {
  missionId: MissionId
  items: GapItem[]
  unmetRequirementIds: RequirementId[]
  satisfiedRequirementIds: RequirementId[]
  assessedAtSequence: number
}
