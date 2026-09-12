import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import { createSuite } from './suite.mjs'
import { summarizeNative, classifyResult } from './native.mjs'
type Suite = ReturnType<typeof createSuite>
import { launchOpenCodeQwen, loadQwenProfile } from '../../packages/adapters/opencode-codex-bridge/src/qwen.js'
import { loadTokenSwitchProfile } from '../../packages/adapters/opencode-codex-bridge/src/token-switch-profile.js'
import { startOpenCodeQwenLoopBridge } from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import { createPrivateStreamCapture } from '../../packages/adapters/opencode-codex-bridge/src/private-stream-capture.js'
import { DEFAULT_QWEN_ENV_FILE } from '../../packages/adapters/opencode-codex-bridge/src/daily-cli.js'
import { resolveDefaultOpenCodeCommand } from '../../packages/adapters/opencode-codex-bridge/src/cli.js'

const budget={maxTurns:30,maxActions:48,evidenceClosure:{maxTurns:6,maxActions:8,allowedToolNames:['bash','read','grep','glob','list','todowrite']}}
const policy={explorationSoftLimit:10,postSteerGraceActions:4,investigationExtensionActions:4,repeatedPairLimit:4,repeatedErrorLimit:3}
export async function exists(path:string) {
  try { await lstat(path); return true } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error }
}
export async function assertFresh(suite:Suite, taskId:string) {
  const {getTask,targets,base,identity,exec,digest,snapshot}=suite
  const t=getTask(taskId),root=join(targets,t.id),state=join(base,t.id)
  if(await exists(join(state,'run.started.json')) || await exists(join(state,'result.json')))throw new Error('Task already consumed; preserve it, use report or prepare a new --batch coding-batch-v2-<name>')
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
  if(!pending.length)throw new Error('Batch already consumed; use report or prepare a new --batch coding-batch-v2-<name>. No provider started.')
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
  if(!['company','personal','dogfood'].includes(selected))throw new Error('Choose company, personal or dogfood')
  const admission=await assertFresh(suite,taskId)
  // Claim once, before loading credentials or starting a Host. Never clear this marker.
  await writeFile(join(state,'run.started.json'),JSON.stringify({at:new Date().toISOString(),source:selected,budget,policy,suite:admission.suite}),{flag:'wx',mode:0o600})
  const start=Date.now()
  let native=summarizeNative(''),missionReason:string|undefined
  let attempts=0,actions=0,failedTools=0,modelFailure=false,missionOutcome:string|undefined,exitCode:number|undefined,hostFailure=false,hostTimedOut=false,budgetStop=false
  const capture=createPrivateStreamCapture({})
  try {
    const profile=await (dependencies.loadProfile ?? (async selected=>selected==='personal'?loadQwenProfile({envFilePath:DEFAULT_QWEN_ENV_FILE}):loadTokenSwitchProfile(undefined,selected==='company'?'company':'dogfood',selected==='company'?'高级':'Qwen3.8-Max-DogFooding')))(selected)
    exitCode=await (dependencies.launch ?? launchOpenCodeQwen)({
      root,profile,opencodeCommand:dependencies.command??resolveDefaultOpenCodeCommand(),attemptBudget:budget,progressPolicy:policy,
      completionVerifier:{id:suite.batchId+'-'+t.id,verify:async context=>{
        const result=await grade(t,context.workspaceRoot,context.signal)
        return result.passed?{passed:true}:{passed:false,guidance:'Independent contract checks failed. Recheck the public TASK.md contract, scope, regression tests and edge cases; do not inspect the evaluator.'}
      }},
      recordEvent:async event=>{
        await appendFile(join(state,'lifecycle.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...event})+'\n',{mode:0o600})
        if(event.event==='attempt_started')attempts++
        if(event.event==='action_observed'){actions++;if(!event.ok)failedTools++}
        if(event.event==='attempt_finished'&&event.modelFailure)modelFailure=true
        if(event.event==='attempt_finished'&&['max_turns','max_actions','budget_exhausted','stop_after_turn'].includes(event.stopReason??''))budgetStop=true
        if(event.event==='mission_finished'){missionOutcome=event.outcome;missionReason=event.reason}
        if(event.event==='attempt_started'||event.event==='mission_finished'||(event.event==='action_observed'&&actions%5===0))console.log(JSON.stringify({task:t.id,event:event.event,attempts,actions,missionOutcome}))
      }
    },{
      startBridge:options=>startOpenCodeQwenLoopBridge({...options,modelFactory:capture}),
      runTui:async input=>{
        const running=(dependencies.nativeExec??exec)(input.command,['run','--dir',root,'--agent','build','--model','chaos-qwen/code-agent','--format','json','--title','Chaos Eval '+t.id,prompt(t)],{
          cwd:root,env:{...input.env,PWD:root},timeout:900_000,maxBuffer:8*1024*1024})
        running.child.stdin?.end()
        let stdout=''
        try{const result=await running;stdout=result.stdout;return 0}
        catch(error){hostTimedOut=Boolean((error as {killed?:boolean}).killed);stdout=String((error as {stdout?:string}).stdout??'');return 1}
        finally{
          // Native output remains private. Do not publish reasoning/tool content.
          await writeFile(join(state,'native.jsonl'),stdout,{flag:'wx',mode:0o600})
          native=summarizeNative(stdout)
          await writeFile(join(state,'final-response.txt'),native.finalText,{flag:'wx',mode:0o600})
        }
      }
    })
  }catch{hostFailure=true}
  const outcome=await grade(t,root,AbortSignal.timeout(30_000)).catch(()=>({passed:false,failed:['grading-interrupted']}))
  const result={task:t.id,source:selected,attempts,actions,failedTools,seconds:Math.round((Date.now()-start)/1000),missionOutcome,missionReason,exitCode,modelFailure,hostFailure,hostTimedOut,budgetStop,
    independentPassed:outcome.passed,failed:outcome.failed,assistance:0,claim:'unreviewed',
    nativeTools:native.nativeTools,nativeFailedTools:native.nativeFailedTools,permissionRejections:native.permissionRejections,nativeErrors:native.nativeErrors,malformedNativeLines:native.malformedLines,
    runtimeFalseAccept:missionOutcome==='succeeded'&&!outcome.passed}
  const classified={...result,category:classifyResult(result)}
  await writeFile(join(state,'result.json'),JSON.stringify(classified,null,2),{flag:'wx',mode:0o600})
  console.log(JSON.stringify(classified));return classified
}
