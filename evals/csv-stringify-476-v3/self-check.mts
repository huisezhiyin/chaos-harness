import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as original from './suite.mjs'
import { runTask } from './run.mts'
import { classifyResult } from './native.mjs'
import { buildReport } from '../report.mjs'

// Fake launch only; never read credentials or touch real evaluation targets.
const scratch=await mkdtemp(join(tmpdir(),'chaos-csv476-v3-runner-check-'))
let checks=0
try {
  for(const scenario of ['passed','controller','budget','recovered','length','error','profile-failed','stale']) {
    const id='fake-'+scenario,base=join(scratch,id,'state'),targets=join(scratch,id,'targets'),root=join(targets,id)
    await mkdir(root,{recursive:true});await mkdir(join(base,id),{recursive:true});await writeFile(join(root,'README.md'),'fixture')
    const success=['passed','recovered'].includes(scenario)
    const suite={...original,batchId:'fake-csv476-v3',base,targets,tasks:[{id}],getTask:()=>({id}),identity:async()=>({version:scenario==='stale'?2:1}),
      exec:async()=>({stdout:'fake-head\n'}),grade:async()=>({passed:success,failed:success?[]:['no-mutation']}),prompt:()=> 'fake task'}
    await writeFile(join(base,id,'admission.json'),JSON.stringify({id,root,head:'fake-head',suite:{version:1},artifact:original.digest(await original.snapshot(root))}))
    let loads=0,launches=0
    const dependencies={loadProfile:async()=>{loads++;if(scenario==='profile-failed')throw new Error('fake profile failure');return {apiKey:'fake',baseUrl:'https://unused.invalid',model:'fake'}},
      launch:async(options:any)=>{
        launches++;assert.equal(options.modelLengthRecovery,'once-per-unit');assert.equal(options.workspaceBoundary,'root-only')
        assert.equal(options.attemptBudget.maxTurns,30);assert.equal(options.attemptBudget.maxActions,48);assert.equal(options.progressPolicy.explorationSoftLimit,10)
        const identity={missionId:'m',unitId:'u',unitRevision:1,attemptId:'a'}
        const emit=(event:string,fields:any={})=>options.recordEvent({...identity,event,...fields})
        await emit('attempt_started')
        const actionAccounting={proposed:19,hostForwarded:18,hostObserved:18,controllerBlocked:1,workspaceRejected:0,budgetBlocked:0,permissionBlocked:0,unknownTool:0,notDispatched:0}
        if(['controller','recovered'].includes(scenario)) {
          await emit('attempt_control_decided',{controlDecision:'recover',failureCode:'no_artifact_after_steer'})
          await emit('attempt_finished',{stopReason:'stop_after_turn',actionAccounting,primaryStop:{kind:'controller_progress',stopReason:'stop_after_turn',failureCode:'no_artifact_after_steer'}})
          await emit('interrupted_verification_requested')
          if(scenario==='recovered') {
            identity.attemptId='b';await emit('attempt_started');await emit('attempt_finished',{terminalState:'completion_proposed',actionAccounting:{...actionAccounting,proposed:18,controllerBlocked:0}})
          }
        } else if(scenario==='budget') await emit('attempt_finished',{stopReason:'max_actions',primaryStop:{kind:'budget',stopReason:'max_actions'}})
        else await emit('attempt_finished',success?{}:{stopReason:'model_incomplete',modelTermination:{finishReason:scenario,turn:2,outputTokens:32000}})
        await emit('mission_finished',{outcome:success?'succeeded':'cancelled',...(['controller','budget'].includes(scenario)?{reason:'host_exit',cleanupReason:'host_exit'}:{})})
        return ['length','error'].includes(scenario)?1:0
      }}
    if(scenario==='stale') {await assert.rejects(()=>runTask(suite as any,id,'company',dependencies),/Suite changed/);assert.equal(loads,0);assert.equal(launches,0);checks++;continue}
    const result=await runTask(suite as any,id,'company',dependencies)
    assert.equal(result.category,({passed:'independent_pass',recovered:'independent_pass',controller:'controller_progress_interruption',budget:'budget_interruption',length:'model_output_limit_interruption',error:'model_incomplete_interruption','profile-failed':'infrastructure_interruption'} as Record<string,string>)[scenario])
    assert.equal(result.budgetStop,scenario==='budget')
    if(scenario==='controller')assert.equal(result.actionAccounting?.controllerBlocked,1)
    if(scenario==='recovered')assert.equal(result.primaryStop,undefined)
    const raw=await readFile(join(base,id,'result.json'),'utf8');assert.equal((await buildReport(suite)).completed,1)
    assert.equal(await readFile(join(base,id,'result.json'),'utf8'),raw)
    await assert.rejects(()=>runTask(suite as any,id,'company',dependencies),/already consumed/);assert.equal(loads,1);checks++
  }
  const controlled={termination:{category:'controller_progress_interruption'},lastStopReason:'stop_after_turn',missionOutcome:'cancelled',missionReason:'host_exit',exitCode:0,workspaceRejectedActions:0}
  assert.equal(classifyResult(controlled),'controller_progress_interruption')
  assert.equal(classifyResult({...controlled,permissionRejections:1}),'permission_interruption')
  assert.equal(classifyResult({...controlled,modelFailure:true}),'infrastructure_interruption')
  assert.equal(classifyResult({...controlled,hostTimedOut:true}),'timeout_interruption')
  console.log(`Model-free v3 runner checks passed: ${checks} scenarios plus fault precedence; no provider or Host started.`)
} finally {await rm(scratch,{recursive:true,force:true})}
