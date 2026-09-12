import { verifierFeedback } from './feedback.mjs'
import { startOpenCodeQwenLoopBridge, QWEN_LOOP_MODEL_ID } from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import { encodeOpenCodeToolObservation } from '../../packages/adapters/opencode-codex-bridge/src/opencode-observation-envelope.js'
import type { ModelRequest, ModelStreamEvent, JsonObject } from '../../packages/kernel/src/index.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSuite } from './suite.mjs'
import { summarizeNative, classifyResult } from './native.mjs'
import { runTask, pendingTasks, assertFresh, createCompletionVerifier } from './run.mjs'
import { buildReport, renderReport } from '../report.mjs'
import { parseArgs } from '../cli.mjs'

const scratch=await mkdtemp(join(tmpdir(),'chaos-v2-self-check-'))
const suite=createSuite('coding-batch-v3-test',{stateRoot:join(scratch,'state'),targetRoot:join(scratch,'targets')})
const {put,files,grade,tasks,sha}=suite
let assertions=0
const check=(value:unknown)=>{assert.ok(value);assertions++}
async function candidate(t:any, additions:Record<string,string>={}) {
  const root=await mkdtemp(join(scratch,'candidate-'))
  await put(root,{...files(t),...t.reference,'test/regression.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import * as api from '../src/index.js';test('contract',()=>{"+t.checks+"})",...additions})
  return root
}
const denied={type:'tool_use',part:{type:'tool',callID:'call-1',tool:'bash',state:{status:'error',error:'The user rejected permission to use this specific tool call.'}}}
try {
  // All frozen baselines, references, reintroduced bugs and four duration mutants.
  check(await suite.qualify())
  for(const id of ['07-archive-filter','08-money-contract','10-normalization']) {
    const t=suite.getTask(id)
    let additions:Record<string,string>
    if(id==='07-archive-filter')additions={
      'src/repository.js':t.reference['src/repository.js']+";export const wrap=items=>({status:200,items});export default wrap;",
      'src/handler.js':t.reference['src/handler.js'].replace("import {listItems}","import wrap from './repository.js';import {listItems}").replace("{status:200,items:listItems(records,{includeArchived:[true,'true','1'].includes(v)})}","wrap(listItems(records,{includeArchived:[true,'true','1'].includes(v)}))")}
    else if(id==='08-money-contract')additions={
      'src/money.js':t.reference['src/money.js']+";export {formatCents} from './format.js';",
      'src/format.js':"export const formatCents=n=>String(BigInt(n)/100n)+'.'+String(BigInt(n)%100n).padStart(2,'0');",
      'src/invoice.js':"import {formatCents} from './money.js';"+t.reference['src/invoice.js'].replace("String(n/100n)+'.'+String(n%100n).padStart(2,'0')","formatCents(n)")}
    else additions={
      'src/normalize.js':t.reference['src/normalize.js']+";const joinNames=names=>names.join(',');export {joinNames};",
      'src/mailer.js':"import {normalizeNames,joinNames} from './normalize.js';export function buildRecipients(input){return joinNames(normalizeNames(input))}"}
    const root=await candidate(t,additions)
    const before=suite.digest(await suite.snapshot(root))
    const result=await grade(t,root)
    assert.deepEqual(result.failed,[],id+' valid auxiliary exports')
    check(suite.digest(await suite.snapshot(root))===before)
    // Correct public behavior but copied implementation breaks real delegation.
    if(id==='07-archive-filter')await put(root,{'src/service.js':t.reference['src/repository.js'].replace('export function listRecords','function listRecords')+';export function listItems(records,options){return listRecords(records,options)}'})
    else if(id==='08-money-contract')await put(root,{'src/cart.js':t.reference['src/money.js'].replace('export function','function')+';'+t.reference['src/cart.js'].replace("import {parseMoney} from './money.js';",'')})
    else await put(root,{'src/mailer.js':t.starter['src/mailer.js']})
    const bad=await grade(t,root)
    check(!bad.passed && bad.failed.some((f:string)=>/delegation|shared-helper/.test(f)))
  }
  const money=suite.getTask('08-money-contract')
  const defective=money.reference['src/money.js'].replace('/^\\d+(?:','/^(?:0|[1-9]\\d*)(?:')
  check(defective!==money.reference['src/money.js'])
  const moneyRoot=await candidate(money,{'src/money.js':defective,'test/regression.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import {parseMoney} from '../src/money.js';test('happy',()=>assert.equal(parseMoney('1.2'),120))"})
  const badMoney=await grade(money,moneyRoot)
  assert.deepEqual(badMoney.failed,['behavior'])
  assert.deepEqual(badMoney.diagnostics,['money-valid-decimal'])
  const guidance=verifierFeedback(badMoney)
  check(guidance.includes('leading zeros')&&!guidance.includes('000.01'))
  check(!verifierFeedback({failed:['untrusted stderr with private-key'],diagnostics:['untrusted stdout']}).includes('private-key'))

  // Use the actual v3 completion verifier in the bridge's targeted recovery.
  let attempts=0,changed=false
  const recoveryRequests:ModelRequest[]=[],bridgeEvents:any[]=[]
  const bridge=await startOpenCodeQwenLoopBridge({workspaceRoot:moneyRoot,workspaceBoundary:'root-only',
    profile:{apiKey:'fake-key',baseUrl:'https://unused.invalid/v1',model:'fake-model'},
    completionVerifier:createCompletionVerifier(suite,money.id),
    attemptBudget:{maxTurns:12,maxActions:10,evidenceClosure:{maxTurns:4,maxActions:4,allowedToolNames:['read','bash']}},
    progressPolicy:{explorationSoftLimit:4,postSteerGraceActions:2},
    workspaceArtifactProbe:{capture:async()=>({available:true,digest:'sha256:'+(changed?'b':'a').repeat(64),changedPathCount:changed?1:0})},
    recordEvent:async e=>{bridgeEvents.push(e)},
    modelFactory:()=>{const attempt=++attempts;return {async *stream(request):AsyncIterable<ModelStreamEvent>{
      if(attempt===2)recoveryRequests.push(request)
      const steps:Array<{name:string;arguments:JsonObject}>=[{name:'edit',arguments:{filePath:'src/money.js',oldString:'old',newString:'new'}},{name:'bash',arguments:{command:'npm test',workdir:moneyRoot}},{name:'bash',arguments:{command:'git diff --check',workdir:moneyRoot}}]
      const step=steps[request.turn-1]
      if(step){yield {type:'tool_call',call:{toolCallId:'call-'+request.turn,...step}};yield {type:'finish',reason:'tool_calls'}}
      else{yield {type:'text_delta',delta:'candidate'};yield {type:'finish',reason:'stop'}}
    }}}
  })
  try{
    const goal='Fix the money module and add regression tests.'
    const send=async(observation?:any)=>{
      const response=await fetch(bridge.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+bridge.apiKey,'content-type':'application/json'},body:JSON.stringify({model:QWEN_LOOP_MODEL_ID,messages:[{role:'user',content:goal},...(observation?[{role:'tool',tool_call_id:observation.id,content:encodeOpenCodeToolObservation({token:bridge.observationToken,toolCallId:observation.id,ok:true,content:'ok'})}]:[])],tools:['edit','bash'].map(name=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{}}}}))})})
      assert.equal(response.status,200);return await response.json() as any
    }
    let response=await send()
    for(let n=0;n<8&&response.choices[0].message.tool_calls?.length;n++){
      const c=response.choices[0].message.tool_calls[0]
      if(c.function.name==='edit'){changed=true;if(attempts===2)await put(moneyRoot,money.reference)}
      response=await send(c)
    }
    check(attempts===2)
    check(recoveryRequests[0]!.messages[0]!.content.includes('leading zeros'))
    check(!JSON.stringify(bridgeEvents).includes('leading zeros'))
    assert.deepEqual(bridgeEvents.filter(e=>e.event==='external_verification_completed').map(e=>e.passed),[false,true])
    check(bridgeEvents.at(-1).outcome==='succeeded')
  }finally{await bridge.close()}

  const t=tasks[0],root=await candidate(t),original=files(t)
  await writeFile(join(root,'package.json'),'{"type":"module","scripts":{"test":"exit 0"}}')
  check((await grade(t,root)).failed.includes('immutable:package.json'))
  await writeFile(join(root,'package.json'),original['package.json'])
  await writeFile(join(root,'unexpected.txt'),'unrelated')
  check((await grade(t,root)).failed.includes('scope:unexpected.txt'))
  await unlink(join(root,'unexpected.txt'))
  await writeFile(join(root,'test/regression.test.js'),"import test from 'node:test';test('fail',()=>{throw new Error('fail')})")
  check((await grade(t,root)).failed.includes('public-tests'))

  const n=summarizeNative([denied,denied,{type:'error'}, {type:'text',part:{text:'done'}}].map(e=>JSON.stringify(e)).join('\n')+'\ninvalid')
  check(n.nativeFailedTools===1&&n.permissionRejections===1&&n.nativeErrors===1&&n.malformedLines===1&&n.finalText==='done')
  const successful={missionOutcome:'succeeded',exitCode:0,independentPassed:true,permissionRejections:0,nativeErrors:0}
  check(classifyResult(successful)==='independent_pass')
  check(classifyResult({...successful,missionOutcome:'cancelled',missionReason:'host_exit',permissionRejections:1})==='permission_interruption')
  check(classifyResult({...successful,missionOutcome:'cancelled',missionReason:'host_exit'})==='host_interruption')
  check(classifyResult({...successful,missionOutcome:undefined})==='failed_pending_review')
  check(classifyResult({...successful,hostTimedOut:true})==='timeout_interruption')
  check(classifyResult({...successful,modelFailure:true})==='infrastructure_interruption')
  check(classifyResult({...successful,permissionRejections:1})==='independent_pass') // recovered within the existing run
  check(classifyResult({...successful,workspaceRejectedActions:2,missionOutcome:'cancelled',nativeErrors:1})==='workspace_interruption')
  check(classifyResult({...successful,workspaceRejectedActions:1})==='independent_pass')

  // prepare creates only isolated local detached repositories, never branch refs.
  const manifest=await suite.prepare()
  check(manifest.length===10)
  check((await suite.prepare()).every((r:any)=>r.existing))
  for(const task of tasks) {
    check((await suite.exec('git',['-C',join(suite.targets,task.id),'for-each-ref','refs/heads'])).stdout.trim()==='')
  }
  check((await pendingTasks(suite)).length===10)
  let profileLoads=0,hostLaunches=0,stdinEnded=0
  const deps:any={command:'fake-host',loadProfile:async()=>{profileLoads++;return {apiKey:'fake',baseUrl:'http://unused.invalid',model:'fake'}},
    nativeExec:()=>Object.assign(Promise.resolve({stdout:JSON.stringify(denied)+'\n',stderr:''}),{child:{stdin:{end(){stdinEnded++}}}}),
    launch:async(options:any,hooks:any)=>{
      hostLaunches++
      const code=await hooks.runTui({command:'fake-host',args:[],env:{}})
      await options.recordEvent({event:'mission_finished',outcome:'cancelled',reason:'host_exit'})
      return code
    }}
  const interrupted=await runTask(suite,'06-config-merge','company',deps)
  check(interrupted.category==='permission_interruption'&&interrupted.exitCode===0&&interrupted.failedTools===0&&interrupted.nativeFailedTools===1&&interrupted.missionReason==='host_exit')
  check(profileLoads===1&&hostLaunches===1&&stdinEnded===1)
  await assert.rejects(()=>runTask(suite,'06-config-merge','company',deps),/already consumed/)
  check(profileLoads===1&&hostLaunches===1)
  check(!(await pendingTasks(suite)).includes('06-config-merge'))
  const damaged=join(suite.targets,'02-ttl-cache','src/index.js'), saved=await readFile(damaged,'utf8')
  await writeFile(damaged,saved+'\n// change')
  await assert.rejects(()=>pendingTasks(suite),/differs/)
  check(profileLoads===1)
  await writeFile(damaged,saved)
  const isolated=createSuite('coding-batch-v3-other',{stateRoot:join(scratch,'state'),targetRoot:join(scratch,'targets')})
  check(isolated.base!==suite.base&&isolated.targets!==suite.targets)
  await assert.rejects(()=>isolated.prepare()) // has no qualification
  for(const task of tasks)if(task.id!=='06-config-merge')await writeFile(join(suite.base,task.id,'run.started.json'),'{}',{flag:'wx'})
  await assert.rejects(()=>pendingTasks(suite),/already consumed/)
  await assert.rejects(()=>assertFresh(suite,'01-pagination'),/already consumed/)

  // Report joins only audit entries bound to the unchanged raw result bytes.
  const reportBase=join(scratch,'report')
  const reportTasks=[{id:'01-pagination'},{id:'06-config-merge'},{id:'08-money-contract'},{id:'not-run'}]
  const hashes:Record<string,string>={}
  for(const task of reportTasks.slice(0,3)) {
    const text=JSON.stringify({task:task.id,category:task.id==='01-pagination'?'independent_pass':'failed_pending_review',independentPassed:task.id==='01-pagination'})
    await mkdir(join(reportBase,task.id),{recursive:true});await writeFile(join(reportBase,task.id,'result.json'),text)
    hashes[task.id]=sha(text)
  }
  await writeFile(join(reportBase,'review-2026-09-04.json'),JSON.stringify({schema:1,kind:'post_run_review',original_results_preserved:true,original_result_sha256:hashes,tasks:{
    '06-config-merge':{review:'permission_interruption'},
    '08-money-contract':{review:'grader_false_rejection; runtime timeout preserved',corrected_delegation_pass:true,independent_behavior_pass:true,tests_failed:0,target_unchanged:true}}}))
  const reportInput={batchId:'coding-batch-v1',base:reportBase,tasks:reportTasks}
  const reportBefore=suite.digest(await suite.snapshot(reportBase))
  const report=await buildReport(reportInput)
  check(report.rawIndependentPass===1&&report.artifactAccepted===2&&report.completed===3)
  check(renderReport(report).includes('grader_false_rejection_timeout_preserved'))
  check(suite.digest(await suite.snapshot(reportBase))===reportBefore)
  const rawPath=join(reportBase,'08-money-contract','result.json')
  await writeFile(rawPath,(await readFile(rawPath,'utf8'))+'\n')
  const mismatch=await buildReport(reportInput)
  check(mismatch.auditHashMismatches===1&&mismatch.artifactAccepted===1)
  await writeFile(join(reportBase,'01-pagination','review.json'),JSON.stringify({originalResultSha256:hashes['01-pagination'],claim:'unreviewed',assistance:1}))
  const annotated=await buildReport(reportInput)
  check(annotated.rows[0].rawCategory==='independent_pass'&&annotated.rows[0].reviewedCategory==='assisted_pass')

  assert.throws(()=>parseArgs(['run-all']),/v1 is completed/)
  assert.throws(()=>parseArgs(['run-all','--batch','coding-batch-v1']),/v1 is completed/)
  assert.throws(()=>parseArgs(['run-all','--batch','coding-batch-v2']),/v2 is frozen/)
  assert.throws(()=>parseArgs(['prepare','--batch','../v1']),/Invalid batch/)
  assert.throws(()=>parseArgs(['run-all','--batch','coding-batch-v3','--source','unknown']),/Choose/)
  assert.throws(()=>parseArgs(['report','--batch']),/Missing value/)
  assert.throws(()=>parseArgs(['report','--batch','coding-batch-v3','--batch','coding-batch-v1']),/Duplicate/)
  assert.throws(()=>parseArgs(['run-all','extra','--batch','coding-batch-v3']),/positional/)
  check(parseArgs(['report']).batchId==='coding-batch-v1')
  check(parseArgs(['run-all','--batch','coding-batch-v3-next']).batchId==='coding-batch-v3-next')
  console.log(`Model-free self-check passed: ${assertions} grouped assertions plus rejection checks; no provider or native Host started.`)
} finally {await rm(scratch,{recursive:true,force:true})}
