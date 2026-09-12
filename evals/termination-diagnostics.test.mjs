import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { diagnoseTermination } from './termination-diagnostics.mjs'
import { buildReport, renderReport } from './report.mjs'
const identity = { missionId:'m', unitId:'u', unitRevision:1, attemptId:'a' }
const raw = { task:'t', attempts:1, category:'host_interruption', missionOutcome:'cancelled', missionReason:'host_exit', lastStopReason:'stop_after_turn', exitCode:0, independentPassed:false, nativeErrors:0 }
const e = (event, fields={}) => ({...identity,event,...fields})
const events = [e('attempt_started'),e('attempt_control_decided',{controlDecision:'recover', failureCode:'no_artifact_after_steer'}),
  e('attempt_finished',{stopReason:'stop_after_turn'}),e('interrupted_verification_requested'),e('mission_finished',{outcome:'cancelled',reason:'host_exit'})]

test('historical controller cause stays separate from raw outcome and unavailable ledger', () => {
  assert.deepEqual(diagnoseTermination(raw, events), { category:'controller_progress_interruption',failureCode:'no_artifact_after_steer',stopReason:'stop_after_turn',cleanupReason:'host_exit' })
})
test('real Host/model/permission failures and uncorrelated evidence cannot be relabelled', () => {
  for (const flags of [{hostFailure:true},{hostTimedOut:true},{modelFailure:true},{nativeErrors:1},{permissionRejections:1},{exitCode:1},{workspaceRejectedActions:2},{lastStopReason:'model_error'}]) {
    assert.notEqual(diagnoseTermination({...raw,...flags},events).category,'controller_progress_interruption')
  }
  assert.equal(diagnoseTermination(raw,events.map(v=>v.event==='attempt_finished'?{...v,unitId:'other'}:v)).category,'unknown')
  assert.equal(diagnoseTermination(raw,events.filter(v=>v.event!=='interrupted_verification_requested')).category,'unknown')
})
test('earlier recovery does not contaminate later success or later non-controller pending', () => {
  const later = [...events.slice(0,-1),e('attempt_started',{attemptId:'b'}),e('attempt_finished',{attemptId:'b',terminalState:'completion_proposed'}),
    e('mission_finished',{outcome:'succeeded',reason:undefined})]
  assert.equal(diagnoseTermination({...raw,missionOutcome:'succeeded',missionReason:undefined,lastStopReason:undefined,attempts:2},later).category,'completed')
  later[later.length-1]=e('mission_finished',{outcome:'cancelled',reason:'host_exit'})
  assert.equal(diagnoseTermination({...raw,lastStopReason:undefined,attempts:2},later).category,'unknown')
})
test('hard budget is distinct; stop_after_turn alone never implies a budget', () => {
  assert.equal(diagnoseTermination({...raw,lastStopReason:'max_actions'},events.map(v=>v.event==='attempt_finished'?{...v,stopReason:'max_actions'}:v)).category,'budget_interruption')
  assert.equal(diagnoseTermination(raw,events.filter(v=>v.event!=='attempt_control_decided')).category,'unknown')
})
test('report binds both source hashes, preserves failed acceptance, and writes nothing', async () => {
  const base=await mkdtemp(join(tmpdir(),'chaos-diagnostic-report-')); await mkdir(join(base,'t'))
  const resultText=JSON.stringify(raw), lifecycleText=events.map(v=>JSON.stringify(v)).join('\n')+'\n'
  await writeFile(join(base,'t/result.json'),resultText); await writeFile(join(base,'t/lifecycle.jsonl'),lifecycleText)
  const report=await buildReport({batchId:'fixture',base,tasks:[{id:'t'},{id:'unrun'}]})
  assert.equal(report.rawIndependentPass,0); assert.equal(report.artifactAccepted,0); assert.equal(report.completed,1)
  assert.equal(report.rows[0].rawCategory,'host_interruption'); assert.equal(report.rows[0].artifactAcceptance,'failed')
  assert.equal(report.rows[0].termination.category,'controller_progress_interruption')
  assert.equal(report.rows[0].termination.originalResultSha256,createHash('sha256').update(resultText).digest('hex'))
  assert.equal(report.rows[0].termination.lifecycleSha256,createHash('sha256').update(lifecycleText).digest('hex'))
  assert.match(renderReport(report),/controller_progress_interruption/)
  assert.equal(await readFile(join(base,'t/result.json'),'utf8'),resultText)
  assert.equal(await readFile(join(base,'t/lifecycle.jsonl'),'utf8'),lifecycleText)
  await writeFile(join(base,'t/lifecycle.jsonl'),lifecycleText+'{truncated')
  assert.equal((await buildReport({batchId:'fixture',base,tasks:[{id:'t'}]})).rows[0].termination.diagnosticError,'invalid_lifecycle')
})
test('ledger sums completed Attempts, never invents counts for legacy or incomplete data', () => {
  const actionAccounting={proposed:19,hostForwarded:18,hostObserved:18,controllerBlocked:1,workspaceRejected:0,budgetBlocked:0,permissionBlocked:0,unknownTool:0,notDispatched:0}
  const current=events.map(v=>v.event==='attempt_finished'?{...v,actionAccounting}:v)
  assert.deepEqual(diagnoseTermination(raw,current).actionAccounting,actionAccounting)
  assert.equal(diagnoseTermination({...raw,attempts:2},current).actionAccounting,undefined)
})
