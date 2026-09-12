import { classifyResult as classifyPrevious } from '../csv-stringify-476-v2/native.mjs'
export { summarizeNative } from '../csv-stringify-476-v2/native.mjs'

export function classifyResult(result) {
  // New run identity only: a correlated controller stop precedes normal Host cleanup.
  if (!result.hostFailure && !result.hostTimedOut && !result.modelFailure && !result.nativeErrors &&
      !result.permissionRejections && !(result.workspaceRejectedActions >= 2) && result.exitCode === 0 &&
      result.missionOutcome === 'cancelled' && result.missionReason === 'host_exit' &&
      result.lastStopReason === 'stop_after_turn' && result.termination?.category === 'controller_progress_interruption') {
    return 'controller_progress_interruption'
  }
  if (!result.hostFailure && !result.hostTimedOut && !result.modelFailure && !result.permissionRejections &&
      result.termination?.category === 'budget_interruption') return 'budget_interruption'
  return classifyPrevious(result)
}
