import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as original from './suite.mjs'
import { runTask } from './run.mts'
import { classifyResult } from './native.mjs'
import { buildReport } from './report.mjs'

// Fake launch only; never read credentials or touch real evaluation targets.
const scratch=await mkdtemp(join(tmpdir(),'chaos-mixed-runner-check-'))
let checks=0
try {
  for(const scenario of ['native-roundtrip','terminal-denied','path-corrected','passed','controller','budget','recovered','length','error','profile-failed','stale','dependency-stale','batch-stale','verifier-env','postgrade-error']) {
    const id='fake-'+scenario,base=join(scratch,id,'state'),targets=join(scratch,id,'targets'),root=join(targets,id)
    await mkdir(root,{recursive:true});await mkdir(join(base,id),{recursive:true});await writeFile(join(root,'README.md'),'fixture')
    const success=['native-roundtrip','passed','recovered','path-corrected','postgrade-error'].includes(scenario)
    const suite={...original,batchId:'fake-real-mixed-batch',base,targets,tasks:[{id}],getTask:()=>({id}),identity:async()=>({version:scenario==='stale'?2:1}),
      snapshot:async(root:string)=>({'README.md':(await readFile(join(root,'README.md'))).toString('base64')}),assertBatchAdmission:async()=>{if(scenario==='batch-stale')throw Error('Batch stale')},checkDependencies:async()=>{if(scenario==='dependency-stale')throw Error('Dependency stale')},exec:async()=>({stdout:'fake-head\n'}),grade:async()=>{if(scenario==='verifier-env')throw Object.assign(Error('SECRET'),{code:'dependencies_changed'});if(scenario==='postgrade-error')throw Error('SECRET');return {passed:success,failed:success?[]:['no-mutation']}},prompt:(t:{id:string})=> 'fake task '+t.id}
    await writeFile(join(base,id,'admission.json'),JSON.stringify({id,root,head:'fake-head',suite:{version:1},artifact:original.digest(await suite.snapshot(root))}))
    let loads=0,launches=0
    const dependencies={loadProfile:async(source:string)=>{assert.equal(source,'personal');loads++;if(scenario==='profile-failed')throw new Error('fake profile failure');return {apiKey:'fake',baseUrl:'https://unused.invalid',model:'fake'}},
      nativeExec:((command:string,args:string[],options:any)=>{assert.equal(command,'fake-host');assert.equal(args.at(-1),'fake task '+id);assert.equal(options.cwd,root);assert.match(options.env.PATH,/tools\/node_modules\/\.bin/);assert.equal(options.env.NODE_OPTIONS,'--no-experimental-strip-types');assert.equal(options.env.TMPDIR,join(root,'test/.chaos-tmp'));assert.equal(options.env.TMP,options.env.TMPDIR);assert.equal(options.env.TEMP,options.env.TMPDIR);assert.equal(options.env.PWD,root);assert(!args.some(a=>['--auto','--yolo','--dangerously-skip-permissions'].includes(a)));assert.equal(options.env.CACHE_DIR,join(base,id,'run-cache'));assert.equal(options.env.NYC_CACHE_DIR,join(base,id,'run-cache/nyc'));assert(!options.env.CACHE_DIR.startsWith(root));assert(options.timeout<=900000);const result=Promise.resolve({stdout:''});return Object.assign(result,{child:{stdin:{end(){}}}})}) as any,
      launch:async(options:any,services:any)=>{
        launches++;if(scenario==='native-roundtrip')assert.equal(await services.runTui({command:'fake-host',env:{PATH:'/fake'}}),0);assert.equal(options.deadline.closureWindowMs,180000);assert(options.deadline.remainingMs<=900000);assert(options.deadline.remainingMs>890000);assert.equal(options.deliveryReadiness.afterActions,20);assert.equal(options.deliveryReadiness.timeoutMs,5000);assert.match(options.deliveryReadiness.probe.id,/delivery$/);assert.deepEqual(options.workspacePathRecovery,{maxAdditionalActions:2});assert.equal(options.completionVerificationOrder,'artifact-first');assert.equal(options.modelLengthRecovery,'once-per-unit');assert.equal(options.workspaceBoundary,'root-only')
        assert.equal(options.attemptBudget.maxTurns,30);assert.equal(options.attemptBudget.maxActions,48);assert.equal(options.progressPolicy.explorationSoftLimit,10)
        assert.deepEqual(options.unitBudget,{maxTurns:72,maxActions:112});assert.deepEqual(options.noArtifactContinuation,{maxAdditionalActions:18})
        const identity={missionId:'m',unitId:'u',unitRevision:1,attemptId:'a'}
        const emit=(event:string,fields:any={})=>options.recordEvent({...identity,event,...fields})
        await emit('attempt_started')
        if(scenario==='terminal-denied')await emit('host_terminal_observation_received',{hostTerminalError:'host_permission_rejected',ok:false,action:'bash'})
        if(scenario==='path-corrected'){await emit('action_observed',{action:'write',ok:false,observationSource:'workspace_preflight',workspaceBoundary:{reason:'outside_workspace',detail:'lexical_escape',pathKind:'absolute',pathField:'filePath'}});await emit('attempt_control_decided',{controlDecision:'correct_path'})}
        const actionAccounting={proposed:19,hostForwarded:18,hostObserved:18,controllerBlocked:1,workspaceRejected:0,budgetBlocked:0,permissionBlocked:0,unknownTool:0,notDispatched:0}
        if(['controller','recovered'].includes(scenario)) {
          await emit('attempt_control_decided',{controlDecision:'recover',failureCode:'no_artifact_after_steer'})
          await emit('attempt_finished',{stopReason:'stop_after_turn',actionAccounting,primaryStop:{kind:'controller_progress',stopReason:'stop_after_turn',failureCode:'no_artifact_after_steer'}})
          await emit('interrupted_verification_requested')
          if(scenario==='recovered') {
            identity.attemptId='b';await emit('attempt_started');await emit('attempt_finished',{terminalState:'completion_proposed',actionAccounting:{...actionAccounting,proposed:18,controllerBlocked:0}})
          }
        } else if(scenario==='budget') await emit('attempt_finished',{stopReason:'max_actions',primaryStop:{kind:'budget',stopReason:'max_actions'}})
        else if(scenario==='verifier-env'){await emit('attempt_finished',{terminalState:'completion_proposed'});await emit('external_verification_completed',{passed:false,failureCode:'dependencies_changed'})}
        else await emit('attempt_finished',success?{}:{stopReason:'model_incomplete',modelTermination:{finishReason:scenario,turn:2,outputTokens:32000}})
        await emit('mission_finished',{outcome:success?'succeeded':'cancelled',...(scenario==='verifier-env'?{reason:'host_exit',cleanupReason:'host_exit',verificationFailureCode:'dependencies_changed'}:{}),...(['controller','budget'].includes(scenario)?{reason:'host_exit',cleanupReason:'host_exit'}:{})})
        return ['length','error'].includes(scenario)?1:0
      }}
    if(['stale','dependency-stale','batch-stale'].includes(scenario)) {await assert.rejects(()=>runTask(suite as any,id,'personal',dependencies),/Suite changed|Dependency stale|Batch stale/);await assert.rejects(()=>readFile(join(base,id,'run.started.json')),e=>(e as NodeJS.ErrnoException).code==='ENOENT');assert.equal(loads,0);assert.equal(launches,0);checks++;continue}
    await assert.rejects(()=>runTask(suite as any,id,'company',dependencies),/requires personal/);assert.equal(loads,0);assert.equal(launches,0)
    const result=await runTask(suite as any,id,'personal',dependencies)
    assert.equal(result.category,({'native-roundtrip':'independent_pass','terminal-denied':'host_interruption','path-corrected':'independent_pass',passed:'independent_pass',recovered:'independent_pass',controller:'controller_progress_interruption',budget:'budget_interruption',length:'model_output_limit_interruption',error:'model_incomplete_interruption','profile-failed':'infrastructure_interruption','verifier-env':'verification_environment_interruption','postgrade-error':'verification_error'} as Record<string,string>)[scenario])
    if(scenario==='path-corrected'){assert.equal(result.pathCorrections,1);assert.equal(result.workspaceBoundaryRejections[0]?.detail,'lexical_escape')}
    assert.equal(result.budgetStop,scenario==='budget')
    if(scenario==='terminal-denied')assert.deepEqual(result.hostTerminalErrors,['host_permission_rejected'])
    if(scenario==='controller')assert.equal(result.actionAccounting?.controllerBlocked,1)
    if(scenario==='recovered')assert.equal(result.primaryStop,undefined)
    const raw=await readFile(join(base,id,'result.json'),'utf8');const report=await buildReport(suite);assert.equal(report.completed,1);if(['verifier-env','postgrade-error'].includes(scenario)){assert.equal(report.rows[0].artifactAcceptance,'unknown');assert.equal(result.runtimeFalseAccept,false);assert(!raw.includes('SECRET'));assert.equal(result.postGradeFailureCode,scenario==='verifier-env'?'dependencies_changed':'verifier_exception')}
    assert.equal(await readFile(join(base,id,'result.json'),'utf8'),raw)
    await assert.rejects(()=>runTask(suite as any,id,'personal',dependencies),/already consumed/);assert.equal(loads,1);checks++
  }
  const controlled={termination:{category:'controller_progress_interruption'},lastStopReason:'stop_after_turn',missionOutcome:'cancelled',missionReason:'host_exit',exitCode:0,workspaceRejectedActions:0}
  assert.equal(classifyResult(controlled),'controller_progress_interruption')
  assert.equal(classifyResult({...controlled,permissionRejections:1}),'permission_interruption')
  assert.equal(classifyResult({...controlled,modelFailure:true}),'infrastructure_interruption')
  assert.equal(classifyResult({...controlled,hostTimedOut:true}),'timeout_interruption')
  console.log(`Model-free real-mixed runner checks passed: ${checks} scenarios plus fault precedence; no provider or Host started.`)
} finally {await rm(scratch,{recursive:true,force:true})}
