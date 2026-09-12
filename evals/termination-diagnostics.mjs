// Derived, read-only diagnostics. Never relabel or rewrite the saved result.
export function diagnoseTermination(raw, events) {
  const mission = events.filter(e => e.event === 'mission_finished').at(-1)
  const sameUnit = e => mission && typeof mission.missionId === 'string' && typeof mission.unitId === 'string' && Number.isInteger(mission.unitRevision) && e.missionId === mission.missionId && e.unitId === mission.unitId && e.unitRevision === mission.unitRevision
  const starts = events.filter(e => e.event === 'attempt_started' && sameUnit(e))
  const lastStart = starts.at(-1)
  const finishes = events.filter(e => e.event === 'attempt_finished' && sameUnit(e))
  const terminal = finishes.filter(e => e.attemptId === lastStart?.attemptId).at(-1)
  const controls = events.filter(e => e.event === 'attempt_control_decided' && sameUnit(e) && e.attemptId === lastStart?.attemptId)
  const failureCode = terminal?.primaryStop?.failureCode ?? controls.filter(e => e.controlDecision === 'recover').at(-1)?.failureCode
  const aligned = mission && mission.outcome === raw.missionOutcome && mission.reason === raw.missionReason &&
    (raw.lastStopReason === undefined || terminal?.stopReason === raw.lastStopReason)
  const cleanHost = raw.exitCode === 0 && !raw.hostFailure && !raw.hostTimedOut && !raw.modelFailure && !raw.nativeErrors && !raw.permissionRejections && !(raw.workspaceRejectedActions >= 2)
  const controllerCodes = ['no_artifact_after_steer', 'repeated_cycle', 'repeated_error']
  let category = 'unknown'
  if (aligned && cleanHost && raw.missionOutcome === 'cancelled' && raw.missionReason === 'host_exit' &&
      terminal?.stopReason === 'stop_after_turn' && controllerCodes.includes(failureCode) &&
      events.some(e => e.event === 'interrupted_verification_requested' && sameUnit(e) && e.attemptId === lastStart?.attemptId)) {
    category = 'controller_progress_interruption'
  } else if (aligned && cleanHost && raw.missionOutcome === 'succeeded') category = 'completed'
  else if (aligned && !raw.hostFailure && !raw.hostTimedOut && !raw.modelFailure && !raw.permissionRejections &&
      ['max_turns', 'max_actions', 'max_cost', 'budget_exhausted'].includes(terminal?.stopReason)) category = 'budget_interruption'
  const counts = ['proposed', 'hostForwarded', 'hostObserved', 'controllerBlocked', 'workspaceRejected', 'budgetBlocked', 'permissionBlocked', 'unknownTool', 'notDispatched']
  // Historical events cannot reveal the identity of unforwarded actions. No subtraction guesses.
  const completeLedger = starts.length > 0 && starts.length === raw.attempts && finishes.length === starts.length &&
    new Set(finishes.map(e => e.attemptId)).size === starts.length &&
    finishes.every(e => starts.some(s => s.attemptId === e.attemptId) && counts.every(k => Number.isInteger(e.actionAccounting?.[k]) && e.actionAccounting[k] >= 0))
  const actionAccounting = completeLedger ? Object.fromEntries(counts.map(k => [k, finishes.reduce((sum,e) => sum + e.actionAccounting[k], 0)])) : undefined
  return { category, ...(category === 'controller_progress_interruption' ? { failureCode } : {}),
    stopReason: terminal?.stopReason, cleanupReason: aligned ? mission?.cleanupReason ?? mission?.reason : undefined,
    ...(actionAccounting ? { actionAccounting } : {}) }
}
