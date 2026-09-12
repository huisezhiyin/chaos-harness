import { classifyResult as classifyV3 } from '../coding-batch-v3/native.mjs'
export { summarizeNative } from '../coding-batch-v3/native.mjs'

export function classifyResult(result) {
  // A bridge-generated terminal error is not independent infrastructure evidence.
  if (!result.hostFailure && !result.hostTimedOut && !result.modelFailure &&
      !result.permissionRejections && result.workspaceRejectedActions < 2 &&
      result.lastStopReason === 'model_incomplete' && result.missionOutcome === 'cancelled') {
    if (result.modelTermination?.finishReason === 'length') return 'model_output_limit_interruption'
    if (['content_filter', 'error'].includes(result.modelTermination?.finishReason)) return 'model_incomplete_interruption'
  }
  return classifyV3(result)
}
