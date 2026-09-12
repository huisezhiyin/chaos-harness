import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tasks, getTask, base, targets, prompt, identity, digest, snapshot, grade, qualify, prepare, exec } from './suite.mjs'
import { launchOpenCodeQwen, loadQwenProfile } from '../../packages/adapters/opencode-codex-bridge/src/qwen.js'
import { loadTokenSwitchProfile } from '../../packages/adapters/opencode-codex-bridge/src/token-switch-profile.js'
import { startOpenCodeQwenLoopBridge } from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import { createPrivateStreamCapture } from '../../packages/adapters/opencode-codex-bridge/src/private-stream-capture.js'
import { DEFAULT_QWEN_ENV_FILE } from '../../packages/adapters/opencode-codex-bridge/src/daily-cli.js'
import { resolveDefaultOpenCodeCommand } from '../../packages/adapters/opencode-codex-bridge/src/cli.js'

const [command,id,source='company',...extra]=process.argv.slice(2)
const budget={maxTurns:30,maxActions:48,evidenceClosure:{maxTurns:6,maxActions:8,allowedToolNames:['bash','read','grep','glob','list','todowrite']}}
const policy={explorationSoftLimit:10,postSteerGraceActions:4,investigationExtensionActions:4,repeatedPairLimit:4,repeatedErrorLimit:3}
async function runTask(taskId:string,selected:string) {
  const t=getTask(taskId),root=join(targets,t.id),state=join(base,t.id)
  if(!['company','personal','dogfood'].includes(selected))throw new Error('Choose company, personal or dogfood')
  const admission=JSON.parse(await readFile(join(state,'admission.json'),'utf8'))
  if(JSON.stringify(admission.suite)!==JSON.stringify(await identity()))throw new Error('Suite changed since preparation')
  const {stdout:head}=await exec('git',['-C',root,'rev-parse','HEAD'])
  if(head.trim()!==admission.head||digest(await snapshot(root))!==admission.artifact)throw new Error('Target differs from prepared baseline; preserve it and review')
  const profile=selected==='personal'?await loadQwenProfile({envFilePath:DEFAULT_QWEN_ENV_FILE}):await loadTokenSwitchProfile(undefined,selected==='company'?'company':'dogfood',selected==='company'?'高级':'Qwen3.8-Max-DogFooding')
  // --run is one explicit dispatch. A failed run never silently restarts.
  await writeFile(join(state,'run.started.json'),JSON.stringify({at:new Date().toISOString(),source:selected,budget,policy,suite:admission.suite}),{flag:'wx',mode:0o600})
  const start=Date.now()
  let attempts=0,actions=0,failedTools=0,modelFailure=false,missionOutcome:string|undefined,exitCode:number|undefined,hostFailure=false,hostTimedOut=false,budgetStop=false
  const capture=createPrivateStreamCapture({onCapture:path=>console.log(JSON.stringify({task:t.id,privateCapture:path}))})
  try {
    exitCode=await launchOpenCodeQwen({
      root,profile,opencodeCommand:resolveDefaultOpenCodeCommand(),attemptBudget:budget,progressPolicy:policy,
      completionVerifier:{id:'coding-batch-v1-'+t.id,verify:async context=>{
        const result=await grade(t,context.workspaceRoot,context.signal)
        return result.passed?{passed:true}:{passed:false,guidance:'Independent contract checks failed. Recheck the public TASK.md contract, scope, regression tests and edge cases; do not inspect the evaluator.'}
      }},
      recordEvent:async event=>{
        await appendFile(join(state,'lifecycle.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...event})+'\n',{mode:0o600})
        if(event.event==='attempt_started')attempts++
        if(event.event==='action_observed'){actions++;if(!event.ok)failedTools++}
        if(event.event==='attempt_finished'&&event.modelFailure)modelFailure=true
        if(event.event==='attempt_finished'&&['max_turns','max_actions','budget_exhausted','stop_after_turn'].includes(event.stopReason??''))budgetStop=true
        if(event.event==='mission_finished')missionOutcome=event.outcome
        if(event.event==='attempt_started'||event.event==='mission_finished'||(event.event==='action_observed'&&actions%5===0))console.log(JSON.stringify({task:t.id,event:event.event,attempts,actions,missionOutcome}))
      }
    },{
      startBridge:options=>startOpenCodeQwenLoopBridge({...options,modelFactory:capture}),
      runTui:async input=>{
        const running=exec(input.command,['run','--dir',root,'--agent','build','--model','chaos-qwen/code-agent','--format','json','--title','Chaos Eval '+t.id,prompt(t)],{
          cwd:root,env:{...input.env,PWD:root},timeout:900_000,maxBuffer:8*1024*1024})
        running.child.stdin?.end()
        let stdout=''
        try{const result=await running;stdout=result.stdout;return 0}
        catch(error){hostTimedOut=Boolean((error as {killed?:boolean}).killed);stdout=String((error as {stdout?:string}).stdout??'');return 1}
        finally{
          // Native output remains private. Do not publish reasoning/tool content.
          await writeFile(join(state,'native.jsonl'),stdout,{mode:0o600})
          const texts=[]
          for(const line of stdout.split('\n')){try{const e=JSON.parse(line);if(e.type==='text'&&typeof e.part?.text==='string')texts.push(e.part.text)}catch{}}
          await writeFile(join(state,'final-response.txt'),texts.join('\n').slice(-32768),{mode:0o600})
        }
      }
    })
  }catch{hostFailure=true}
  const outcome=await grade(t,root,AbortSignal.timeout(30_000)).catch(()=>({passed:false,failed:['grading-interrupted']}))
  const infrastructure=modelFailure||hostFailure||(exitCode!==0&&!hostTimedOut&&!budgetStop)
  const result={task:t.id,source:selected,attempts,actions,failedTools,seconds:Math.round((Date.now()-start)/1000),missionOutcome,exitCode,modelFailure,hostFailure,hostTimedOut,budgetStop,
    independentPassed:outcome.passed,failed:outcome.failed,assistance:0,claim:'unreviewed',
    category:infrastructure?'infrastructure_interruption':outcome.passed?'independent_pass':'failed_pending_review',
    runtimeFalseAccept:missionOutcome==='succeeded'&&!outcome.passed}
  await writeFile(join(state,'result.json'),JSON.stringify(result,null,2),{mode:0o600})
  console.log(JSON.stringify(result));return result
}
async function report() {
  const rows=[]
  for(const t of tasks){
    try{const row=JSON.parse(await readFile(join(base,t.id,'result.json'),'utf8'));rows.push(row)}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;rows.push({task:t.id,category:'not_run'})}
  }
  await mkdir(base,{recursive:true,mode:0o700})
  await writeFile(join(base,'report.json'),JSON.stringify({rows,completed:rows.filter(r=>r.category!=='not_run').length,total:tasks.length},null,2),{mode:0o600})
  const md=['# Coding batch v1','自包含小项目；非真实开源 issue 分数。未运行不计作失败。','',
    '| 任务 | 结果 | 秒 | Attempts | 工具动作 | 人工介入 |','|---|---|---:|---:|---:|---:|',
    ...rows.map(r=>'| '+[r.task,r.category,r.seconds??'—',r.attempts??'—',r.actions??'—',r.assistance??'—'].join(' | ')+' |')].join('\n')+'\n'
  await writeFile(join(base,'report.md'),md,{mode:0o600});console.log(md)
}
try{
  if(extra.length)throw new Error('Unexpected extra arguments')
  if(command==='list'&&!id)console.log(tasks.map((t:{id:string;category:string;title:string})=>t.id+' | '+t.category+' | '+t.title).join('\n'))
  else if(command==='qualify'&&!id)process.exitCode=await qualify()?0:1
  else if(command==='prepare'&&!id)console.log(JSON.stringify(await prepare(),null,2))
  else if(command==='run'&&id){const r=await runTask(id,source);process.exitCode=r.category==='infrastructure_interruption'?2:r.independentPassed?0:1;await report()}
  else if(command==='run-all'&&!id){for(const t of tasks){const r=await runTask(t.id,'company');if(r.category==='infrastructure_interruption')break}await report()}
  else if(command==='grade'&&id)console.log(JSON.stringify(await grade(getTask(id),join(targets,id),AbortSignal.timeout(30_000)),null,2))
  else if(command==='report'&&!id)await report()
  else if(command==='review'&&id){
    const t=getTask(id),p=join(base,t.id,'result.json'),r=JSON.parse(await readFile(p,'utf8'))
    if(!['claimed-complete','reported-incomplete','assisted'].includes(source))throw new Error('review requires claimed-complete, reported-incomplete or assisted')
    if(source==='assisted'){r.assistance++;if(r.independentPassed)r.category='assisted_pass'}
    else{r.claim=source;if(!r.independentPassed&&r.category!=='infrastructure_interruption')r.category=source==='claimed-complete'?'false_completion':'honest_failure'}
    await writeFile(p,JSON.stringify(r,null,2),{mode:0o600});await report()
  }
  else throw new Error('Usage: chaos-eval list|qualify|prepare|report|run-all | run <id> [company|personal|dogfood] | grade <id> | review <id> <claimed-complete|reported-incomplete|assisted>')
}catch(error){console.error(error instanceof Error?error.message:'Eval command failed');process.exitCode=2}
