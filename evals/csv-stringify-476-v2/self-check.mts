import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as original from './suite.mjs'
import { runTask } from './run.mts'
import { classifyResult } from './native.mjs'
import { buildReport } from '../report.mjs'

// Isolated fake launch only. Never load real credentials, invoke a Host or touch an evaluation target.
const scratch = await mkdtemp(join(tmpdir(), 'chaos-csv476-v2-runner-check-'))
let checks = 0
try {
  for (const outcome of ['passed', 'length', 'error', 'profile-failed', 'stale']) {
    const id = 'fake-'+outcome, base = join(scratch,id,'state'), targets = join(scratch,id,'targets'), root = join(targets,id)
    await mkdir(root,{recursive:true}); await mkdir(join(base,id),{recursive:true})
    await writeFile(join(root,'README.md'),'fixture')
    const suite = { ...original, batchId:'fake-csv476-v2',base,targets,tasks:[{id}],getTask:()=>({id}),
      identity:async()=>({version:outcome==='stale'?2:1}), exec:async()=>({stdout:'fake-head\n'}),
      grade:async()=>({passed:outcome==='passed',failed:outcome==='passed'?[]:['no-mutation']}), prompt:()=> 'fake task',
    }
    await writeFile(join(base,id,'admission.json'),JSON.stringify({id,root,head:'fake-head',suite:{version:1},artifact:original.digest(await original.snapshot(root))}))
    let loads=0,launches=0
    const dependencies = {
      loadProfile:async(source:string)=>{loads++;assert.equal(source,'company');if(outcome==='profile-failed')throw new Error('fake profile failure');return {apiKey:'fake',baseUrl:'https://unused.invalid',model:'fake'}},
      launch:async(options:any)=>{
        launches++;assert.equal(options.modelLengthRecovery,'once-per-unit');assert.equal(options.workspaceBoundary,'root-only')
        assert.equal(options.attemptBudget.maxTurns,30);assert.equal(options.attemptBudget.maxActions,48)
        await options.recordEvent({event:'attempt_started'})
        await options.recordEvent({event:'model_length_recovery_started',turn:1,outputTokens:32000,reasoningTokens:32000})
        await options.recordEvent({event:'attempt_finished',...(outcome==='passed'?{}:{stopReason:'model_incomplete',modelTermination:{finishReason:outcome,turn:2,outputTokens:32000}})})
        await options.recordEvent({event:'mission_finished',outcome:outcome==='passed'?'succeeded':'cancelled'})
        return outcome==='passed'?0:1
      },
    }
    if(outcome==='stale') {
      await assert.rejects(()=>runTask(suite as any,id,'company',dependencies),/Suite changed/)
      assert.equal(loads,0);assert.equal(launches,0);checks++;continue
    }
    const result=await runTask(suite as any,id,'company',dependencies)
    const expected={passed:'independent_pass',length:'model_output_limit_interruption',error:'model_incomplete_interruption','profile-failed':'infrastructure_interruption'}[outcome]
    assert.equal(result.category,expected)
    assert.equal(launches,outcome==='profile-failed'?0:1)
    assert.equal(result.modelLengthRecoveries,outcome==='profile-failed'?0:1)
    const raw=await readFile(join(base,id,'result.json'),'utf8')
    const report=await buildReport(suite)
    assert.equal(report.completed,1)
    assert.equal(await readFile(join(base,id,'result.json'),'utf8'),raw)
    await assert.rejects(()=>runTask(suite as any,id,'company',dependencies),/already consumed/)
    assert.equal(loads,1);checks++
  }
  const interrupted={lastStopReason:'model_incomplete',modelTermination:{finishReason:'length'},missionOutcome:'cancelled',workspaceRejectedActions:0,nativeErrors:1}
  assert.equal(classifyResult(interrupted),'model_output_limit_interruption')
  assert.equal(classifyResult({...interrupted,permissionRejections:1}),'permission_interruption')
  assert.equal(classifyResult({...interrupted,modelFailure:true}),'infrastructure_interruption')
  console.log(`Model-free runner checks passed: ${checks} scenarios plus category precedence; no provider or Host started.`)
} finally { await rm(scratch,{recursive:true,force:true}) }
