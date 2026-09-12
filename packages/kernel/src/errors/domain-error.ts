export const domainErrorCodes = [
  "MISSION_ALREADY_EXISTS",
  "MISSION_NOT_FOUND",
  "MISSION_ID_MISMATCH",
  "MISSION_NOT_ACTIVE",
  "MISSION_TERMINAL",
  "ACTIVE_UNIT_EXISTS",
  "UNIT_NOT_FOUND",
  "UNIT_REVISION_MISMATCH",
  "UNIT_NOT_PROPOSED",
  "ADMISSION_INVALID",
  "CHECKPOINT_NOT_FOUND",
  "CHECKPOINT_ALREADY_RESOLVED",
  "CHECKPOINT_DIRECTIVE_CONFLICT",
  "ATTEMPT_NOT_ALLOWED",
  "ATTEMPT_ALREADY_RUNNING",
  "ATTEMPT_NOT_FOUND",
  "ATTEMPT_NOT_RUNNING",
  "UNIT_NOT_VERIFYING",
  "VERIFICATION_INVALID",
  "GAP_INVALID",
  "SLICE_NOT_IMPLEMENTED",
  "INVARIANT_VIOLATION",
] as const

export type DomainErrorCode = (typeof domainErrorCodes)[number]

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "DomainError"
    this.code = code
    this.details = details
  }
}

export function fail(
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new DomainError(code, message, details)
}
