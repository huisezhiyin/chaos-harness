import { ExecutionDeadline } from "../../packages/kernel/src/index.js"
import { inspectReadiness } from './readiness.mjs'
import { diagnoseTermination } from '../termination-diagnostics.mjs'
import type { QwenLoopJournalEvent } from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import { verifierFeedback } from '../coding-batch-v3/feedback.mjs'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import * as suiteDefinition from './suite.mjs'
import { summarizeNative, classifyResult } from './native.mjs'
type Suite = typeof suiteDefinition
import { launchOpenCodeQwen, loadQwenProfile } from '../../packages/adapters/opencode-codex-bridge/src/qwen.js'
import { DEFAULT_DASHSCOPE_BASE_URL, DEFAULT_QWEN_MODEL } from '../../packages/adapters/opencode-codex-bridge/src/qwen.js'
import { startOpenCodeQwenLoopBridge } from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import type { QwenCompletionVerifier } from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import { createPrivateStreamCapture } from '../../packages/adapters/opencode-codex-bridge/src/private-stream-capture.js'
import { DEFAULT_QWEN_ENV_FILE } from '../../packages/adapters/opencode-codex-bridge/src/daily-cli.js'
import { resolveDefaultOpenCodeCommand } from '../../packages/adapters/opencode-codex-bridge/src/cli.js'

const timeBudget={maxMs:900_000,closureWindowMs:180_000}
const budget={maxTurns:30,maxActions:48,evidenceClosure:{maxTurns:6,maxActions:8,allowedToolNames:['bash','read','grep','glob','list','todowrite']}}
const completionVerificationOrder="artifact-first" as const
const workspacePathRecovery={maxAdditionalActions:2}
const deliveryCheckpoint={afterActions:20,timeoutMs:5000}
const unitBudget={maxTurns:72,maxActions:112}
const noArtifactContinuation={maxAdditionalActions:18}
const policy={explorationSoftLimit:10,postSteerGraceActions:4,investigationExtensionActions:4,repeatedPairLimit:4,repeatedErrorLimit:3}
export function createCompletionVerifier(suite:Suite,taskId:string):QwenCompletionVerifier {
  const task=suite.getTask(taskId)
  return {id:suite.batchId+'-'+taskId,verify:async context=>{
    const result=await suite.grade(task,context.workspaceRoot,context.signal)
    return result.passed?{passed:true}:{passed:false,guidance:verifierFeedback(result)}
  }}
}
export async function exists(path:string) {
  try { await lstat(path); return true } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error }
}
export async function assertFresh(suite:Suite, taskId:string) {
  const {getTask,targets,base,identity,exec,digest,snapshot}=suite
  const t=getTask(taskId),root=join(targets,t.id),state=join(base,t.id)
  if(await exists(join(state,'run.started.json')) || await exists(join(state,'result.json')))throw new Error('Task already consumed; preserve it, use report; prepare a separately versioned real task')
  const admission=JSON.parse(await readFile(join(state,'admission.json'),'utf8'))
  if(admission.id!==t.id||admission.root!==root)throw new Error('Task admission identity mismatch')
  if(JSON.stringify(admission.suite)!==JSON.stringify(await identity()))throw new Error('Suite changed since preparation; prepare a new batch')
  const {stdout:head}=await exec('git',['-C',root,'rev-parse','HEAD'])
  if(head.trim()!==admission.head||digest(await snapshot(root))!==admission.artifact)throw new Error('Target differs from prepared baseline; preserve it and review')
  return admission
}
export async function pendingTasks(suite:Suite) {
  const pending=[]
  for(const task of suite.tasks) {
    const state=join(suite.base,task.id)
    if(await exists(join(state,'run.started.json')) || await exists(join(state,'result.json')))continue
    pending.push(task.id)
  }
  if(!pending.length)throw new Error('Batch already consumed; use report; prepare a separately versioned real task. No provider started.')
  // Validate the entire pending batch before even loading a provider profile.
  for(const taskId of pending)await assertFresh(suite,taskId)
  return pending
}
export async function runTask(suite:Suite,taskId:string,selected:string,dependencies:{
  launch?:typeof launchOpenCodeQwen
  loadProfile?:(source:string)=>Promise<Awaited<ReturnType<typeof loadQwenProfile>>>
  command?:string
  nativeExec?:Suite['exec']
}={}) {
  const {getTask,targets,base,prompt,grade,exec}=suite
  const t=getTask(taskId),root=join(targets,t.id),state=join(base,t.id)
  if(selected!=='personal')throw new Error('This independent evaluation requires personal')
  const admission=await assertFresh(suite,taskId)
  // Claim once, before loading credentials or starting a Host. Never clear this marker.
  await writeFile(join(state,'run.started.json'),JSON.stringify({at:new Date().toISOString(),source:selected,timeBudget,budget,unitBudget,noArtifactContinuation,completionVerificationOrder,workspacePathRecovery,deliveryCheckpoint,policy,modelLengthRecovery:"once-per-unit",suite:admission.suite}),{flag:'wx',mode:0o600})
  const lifecycle: QwenLoopJournalEvent[]=[]
  const deliveryReadinessFindings: string[][]=[]
  let pathCorrections=0
  const workspaceBoundaryRejections: import("../../packages/adapters/opencode-codex-bridge/src/workspace-action-boundary.js").WorkspaceBoundaryDiagnostic[]=[]
  let contextContinuations=0, unitUsage: unknown
  let primaryStop: unknown, cleanupReason: string|undefined
  const start=Date.now()
  const deadline=new ExecutionDeadline({deadlineAtMs:start+timeBudget.maxMs,closureWindowMs:timeBudget.closureWindowMs})
  let native=summarizeNative(''),missionReason:string|undefined
  let workspaceRejectedActions=0,modelLengthRecoveries=0
  let modelTermination: unknown,lastStopReason: string|undefined
  let attempts=0,actions=0,failedTools=0,modelFailure=false,missionOutcome:string|undefined,exitCode:number|undefined,hostFailure=false,hostTimedOut=false,budgetStop=false
  const capture=createPrivateStreamCapture({})
  try {
    const profile=await (dependencies.loadProfile ?? (async () => {
      const initial=await loadQwenProfile({envFilePath:DEFAULT_QWEN_ENV_FILE})
      if(initial.baseUrl!==DEFAULT_DASHSCOPE_BASE_URL||initial.model!==DEFAULT_QWEN_MODEL)throw new Error('Personal evaluation profile mismatch')
      return {...initial,assertConnection:async()=>{
        const current=await loadQwenProfile({envFilePath:DEFAULT_QWEN_ENV_FILE})
        if(current.baseUrl!==initial.baseUrl||current.model!==initial.model||current.apiKey!==initial.apiKey)throw new Error('Personal evaluation connection changed')
      }}
    }))(selected)
    exitCode=await (dependencies.launch ?? launchOpenCodeQwen)({
      root,profile,deadline,opencodeCommand:dependencies.command??resolveDefaultOpenCodeCommand(),attemptBudget:budget,unitBudget,noArtifactContinuation,progressPolicy:policy,workspaceBoundary:'root-only',modelLengthRecovery:'once-per-unit',
      completionVerifier:createCompletionVerifier(suite,t.id),completionVerificationOrder,workspacePathRecovery,
      deliveryReadiness:{...deliveryCheckpoint,probe:{id:suite.batchId+'-delivery',verify:async context=>{
        const checked=await inspectReadiness(suite,context.workspaceRoot,context.signal)
        context.signal.throwIfAborted();deliveryReadinessFindings.push(checked.failed)
        return checked
      }}},
      recordEvent:async event=>{
        await appendFile(join(state,'lifecycle.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...event})+'\n',{mode:0o600})
        lifecycle.push(event)
        if(event.event==='attempt_started')attempts++
        if(event.event==='attempt_control_decided'&&event.controlDecision==='correct_path')pathCorrections++
        if(event.event==='action_observed'&&event.workspaceBoundary)workspaceBoundaryRejections.push(event.workspaceBoundary)
        if(event.event==='model_length_recovery_started')modelLengthRecoveries++
        if(event.event==='attempt_control_decided'&&event.controlDecision==='continue_context')contextContinuations++
        if(event.event==='attempt_finished'){unitUsage=event.unitBudget;lastStopReason=event.stopReason;modelTermination=event.modelTermination;primaryStop=event.primaryStop;budgetStop=event.primaryStop?.kind==='budget'||['max_turns','max_actions','max_cost','budget_exhausted'].includes(event.stopReason??'')}
        if(event.event==='action_observed'){actions++;if(!event.ok)failedTools++;if(event.observationSource==='workspace_preflight')workspaceRejectedActions++}
        if(event.event==='attempt_finished'&&event.modelFailure)modelFailure=true
        if(event.event==='mission_finished'){missionOutcome=event.outcome;missionReason=event.reason;cleanupReason=event.cleanupReason}
        if(event.event==='delivery_readiness_checked'||event.event==='attempt_started'||event.event==='model_length_recovery_started'||event.event==='attempt_control_decided'&&['continue_context','correct_path'].includes(event.controlDecision??'')||event.event==='mission_finished'||(event.event==='action_observed'&&actions%5===0))console.log(JSON.stringify({task:t.id,event:event.event,attempts,actions,missionOutcome,modelLengthRecoveries,contextContinuations,pathCorrections}))
      }
    },{
      startBridge:options=>startOpenCodeQwenLoopBridge({...options,modelFactory:capture}),
      runTui:async input=>{
        const running=(dependencies.nativeExec??exec)(input.command,['run','--dir',root,'--agent','build','--model','chaos-qwen/code-agent','--format','json','--title','Chaos Eval '+t.id,prompt()],{
          cwd:root,env:{...input.env,PWD:root},signal:deadline.signal,killSignal:"SIGKILL",timeout:Math.max(1,deadline.remainingMs),maxBuffer:8*1024*1024})
        running.child.stdin?.end()
        let stdout=''
        try{const result=await running;stdout=result.stdout;return 0}
        catch(error){hostTimedOut=deadline.expired||Boolean((error as {killed?:boolean}).killed);stdout=String((error as {stdout?:string}).stdout??'');return 1}
        finally{
          // Native output remains private. Do not publish reasoning/tool content.
          await writeFile(join(state,'native.jsonl'),stdout,{flag:'wx',mode:0o600})
          native=summarizeNative(stdout)
          await writeFile(join(state,'final-response.txt'),native.finalText,{flag:'wx',mode:0o600})
        }
      }
    })
  }catch{hostFailure=true}finally{hostTimedOut ||= deadline.expired;deadline.dispose()}
  const outcome=await grade(t,root,AbortSignal.timeout(30_000)).catch(()=>({passed:false,failed:['grading-interrupted']}))
  const modelTimings=lifecycle.flatMap(e=>e.event==='model_request_finished'&&e.timing?[e.timing]:[])
  const hostTimings=lifecycle.flatMap(e=>e.event==='host_observation_received'&&e.hostRoundTripMs!==undefined?[e.hostRoundTripMs]:[])
  const timing={modelRequests:lifecycle.filter(e=>e.event==='model_request_started').length,modelFinished:modelTimings.length,
    modelPortTotalMs:modelTimings.reduce((n,t)=>n+t.elapsedMs,0),maxModelRequestMs:Math.max(0,...modelTimings.map(t=>t.elapsedMs)),
    maxFirstEventMs:Math.max(0,...modelTimings.flatMap(t=>t.firstEventMs===undefined?[]:[t.firstEventMs])),
    hostRoundTrips:hostTimings.length,hostRoundTripTotalMs:hostTimings.reduce((a,b)=>a+b,0),maxHostRoundTripMs:Math.max(0,...hostTimings)}
  const deliveryReadinessChecks=lifecycle.flatMap(e=>e.event==='delivery_readiness_checked'&&e.readiness?[e.readiness]:[])
  const hostTerminalErrors=lifecycle.flatMap(e=>e.event==='host_terminal_observation_received'&&e.hostTerminalError?[e.hostTerminalError]:[])
  const result={executionDeadline:{deadlineAtMs:deadline.deadlineAtMs,closureWindowMs:deadline.closureWindowMs},hostTerminalErrors,timing,deliveryReadinessChecks,deliveryReadinessFindings,pathCorrections,workspaceBoundaryRejections,contextContinuations,unitBudget:unitUsage,primaryStop,cleanupReason,modelLengthRecoveries,lastStopReason,modelTermination,task:t.id,source:selected,attempts,actions,failedTools,workspaceRejectedActions,seconds:Math.round((Date.now()-start)/1000),missionOutcome,missionReason,exitCode,modelFailure,hostFailure,hostTimedOut,budgetStop,
    independentPassed:outcome.passed,failed:outcome.failed,assistance:0,claim:'unreviewed',
    nativeTools:native.nativeTools,nativeFailedTools:native.nativeFailedTools,permissionRejections:native.permissionRejections,nativeErrors:native.nativeErrors,malformedNativeLines:native.malformedLines,
    runtimeFalseAccept:missionOutcome==='succeeded'&&!outcome.passed}
  const termination=diagnoseTermination(result,lifecycle)
  const diagnosed={...result,termination,actionAccounting:termination.actionAccounting}
  const classified={...diagnosed,category:classifyResult(diagnosed)}
  await writeFile(join(state,'result.json'),JSON.stringify(classified,null,2),{flag:'wx',mode:0o600})
  console.log(JSON.stringify(classified));return classified
}
