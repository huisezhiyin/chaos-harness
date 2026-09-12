import {diagnoseTermination as previous, classifyResult as classifyPrevious} from '../real-mixed-batch-v3-workdir/native.mjs'
export {summarizeNative} from '../real-mixed-batch-v3-workdir/native.mjs'

export function diagnoseTermination(raw, events) {
  const prior = previous(raw, events)
  if (prior.category !== 'unknown' || raw.exitCode !== 0 || raw.hostFailure || raw.hostTimedOut || raw.modelFailure || raw.nativeErrors || raw.permissionRejections || raw.budgetStop) return prior
  const mi = events.findLastIndex(e => e.event === 'mission_finished'), mission = events[mi]
  if (!mission || mission.outcome !== 'cancelled' || mission.reason !== 'host_exit' || raw.missionOutcome !== mission.outcome || raw.missionReason !== mission.reason || typeof mission.missionId !== 'string' || typeof mission.unitId !== 'string' || !Number.isInteger(mission.unitRevision)) return prior
  const same = e => e.missionId === mission.missionId && e.unitId === mission.unitId && e.unitRevision === mission.unitRevision
  const start = events.slice(0, mi).findLast(e => e.event === 'attempt_started' && same(e))
  if (!start || typeof start.attemptId !== 'string') return prior
  const vi = events.slice(0, mi).findLastIndex(e => e.event === 'external_verification_completed' && same(e))
  const verdict = events[vi]
  if (vi < 0 || verdict.attemptId !== start.attemptId || verdict.passed !== false || verdict.failureCode !== undefined) return prior
  const pending = events.slice(vi + 1, mi).find(e => e.event === 'unit_finished' && same(e) && e.outcome === 'verification_pending')
  if (!pending || events.slice(vi + 1, mi).some(e => same(e) && (e.event === 'attempt_started' || e.event === 'host_terminal_observation_received'))) return prior
  return {...prior, category:'verification_rejected', failureCode:'verifier_rejected', cleanupReason:'host_exit'}
}
export function classifyResult(raw) {
  const prior = classifyPrevious(raw)
  if (prior === 'host_interruption' && raw.termination?.category === 'verification_rejected') return 'verification_rejected'
  return prior
}
