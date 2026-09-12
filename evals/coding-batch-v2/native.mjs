// Native and bridge observations cover overlapping calls. Keep their counters
// separate; summing them would count some failures twice.
export function summarizeNative(stdout) {
  const calls = new Map(), texts = []
  let nativeErrors = 0, malformedLines = 0
  for (const line of stdout.split('\n').filter(line => line.trim())) {
    let event
    try { event = JSON.parse(line) } catch { malformedLines++; continue }
    if (event.type === 'text' && typeof event.part?.text === 'string') texts.push(event.part.text)
    if (event.type === 'error') nativeErrors++
    const part = event.part
    if (event.type !== 'tool_use' || part?.type !== 'tool' || !part.state) continue
    const key = part.callID ?? part.id ?? `unidentified-${calls.size}`
    if (!['completed', 'error'].includes(part.state.status)) continue
    const error = typeof part.state.error === 'string' ? part.state.error : ''
    calls.set(key, {
      failed: part.state.status === 'error',
      // This is the host's wording, not evidence a human clicked Reject.
      permission: part.state.status === 'error' && /(?:rejected permission|permission (?:denied|rejected)|PermissionDeniedError|RejectedError)/i.test(error),
    })
  }
  return {
    nativeTools: calls.size,
    nativeFailedTools: [...calls.values()].filter(c => c.failed).length,
    permissionRejections: [...calls.values()].filter(c => c.permission).length,
    nativeErrors, malformedLines,
    finalText: texts.join('\n').slice(-32768),
  }
}

export function classifyResult(r) {
  const cleanCompletion = r.missionOutcome === 'succeeded' && r.exitCode === 0 && !r.hostFailure && !r.hostTimedOut && !r.modelFailure && !r.nativeErrors
  if (r.permissionRejections > 0 && !cleanCompletion) return 'permission_interruption'
  if (r.modelFailure || r.hostFailure || r.nativeErrors > 0) return 'infrastructure_interruption'
  if (r.hostTimedOut) return 'timeout_interruption'
  if (r.missionOutcome === 'cancelled' || (r.exitCode !== 0 && !r.budgetStop) || (!r.missionOutcome && r.missionReason === 'host_exit')) return 'host_interruption'
  if (cleanCompletion && r.independentPassed) return 'independent_pass'
  return 'failed_pending_review'
}

export const isInterruption = category => category.endsWith('_interruption')
