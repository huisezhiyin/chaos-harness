// Persist only allowlisted codes, never thrown messages, paths or tool output.
export const verificationFailureCodes = [
  "dependencies_changed", "dependency_mount_changed", "candidate_identity_mismatch",
  "verifier_exception", "verifier_timeout",
] as const
export type VerificationFailureCode = typeof verificationFailureCodes[number]

export function isVerificationFailureCode(value: unknown): value is VerificationFailureCode {
  return typeof value === "string" && (verificationFailureCodes as readonly string[]).includes(value)
}

export function verificationFailureCode(error: unknown): VerificationFailureCode {
  // Accessors/proxies supplied by a verifier must not break failure reporting.
  try {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    return isVerificationFailureCode(code) ? code : "verifier_exception"
  } catch { return "verifier_exception" }
}
