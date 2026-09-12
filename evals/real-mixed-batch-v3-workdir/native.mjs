import { classifyResult as classifyPrevious } from '../csv-stringify-476-v10-deadline/native.mjs'
import { diagnoseTermination as diagnosePrevious } from '../termination-diagnostics.mjs'
export { summarizeNative } from '../csv-stringify-476-v10-deadline/native.mjs'

const codes = new Set(['dependencies_changed', 'dependency_mount_changed', 'candidate_identity_mismatch', 'verifier_exception', 'verifier_timeout'])
const categoryFor = code => code === 'verifier_timeout' ? 'verification_timeout' : code === 'verifier_exception' ? 'verification_error' : 'verification_environment_interruption'
export function diagnoseTermination(raw, events) {
  const previous = diagnosePrevious(raw, events)
  const mission = events.filter(e => e.event === 'mission_finished').at(-1)
  const verdict = events.filter(e => e.event === 'external_verification_completed' &&
    e.missionId === mission?.missionId && e.unitId === mission?.unitId && e.unitRevision === mission?.unitRevision).at(-1)
  if (mission && mission.outcome === raw.missionOutcome && mission.reason === raw.missionReason &&
      mission.outcome === 'cancelled' && verdict?.passed === false && codes.has(verdict.failureCode) &&
      mission.verificationFailureCode === verdict.failureCode) {
    return { ...previous, category: categoryFor(verdict.failureCode), verificationFailureCode: verdict.failureCode }
  }
  return previous
}
export function classifyResult(result) {
  const prior = classifyPrevious(result)
  // Actual permission/model/deadline failures retain precedence over cleanup.
  if (['permission_interruption', 'infrastructure_interruption', 'timeout_interruption'].includes(prior)) return prior
  if (codes.has(result.termination?.verificationFailureCode)) return categoryFor(result.termination.verificationFailureCode)
  if (result.missionOutcome === 'succeeded' && codes.has(result.postGradeFailureCode)) return categoryFor(result.postGradeFailureCode)
  return prior
}
