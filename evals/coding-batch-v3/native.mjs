import { classifyResult as classifyNativeResult } from '../coding-batch-v2/native.mjs'
export { summarizeNative } from '../coding-batch-v2/native.mjs'

export function classifyResult(result) {
  if (result.workspaceRejectedActions >= 2 && result.missionOutcome !== 'succeeded') return 'workspace_interruption'
  return classifyNativeResult(result)
}
