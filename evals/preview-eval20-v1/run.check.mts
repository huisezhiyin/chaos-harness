import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runTask} from './run.mjs'
import {runBatch} from '../real-mixed-batch-v3-workdir/batch.mjs'

test('headless eval preserves environment and consumes a task once without a provider',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'eval20-runner-'))
 try {
  const task={id:'fixture',repo:'fixture',delivery:{generatedDirectories:[]}},base=join(temp,'state'),targets=join(temp,'targets'),root=join(targets,task.id),state=join(base,task.id)
  await mkdir(root,{recursive:true});await mkdir(state,{recursive:true})
  const identity={nativeHost:{path:'/fixture/host'}}
  await writeFile(join(state,'admission.json'),JSON.stringify({id:task.id,root,head:'head',artifact:'baseline',suite:identity}))
  const suite={batchId:'fixture',tasks:[task],targets,base,getTask:()=>task,assertBatchAdmission:async()=>{},checkDependencies:async()=>{},identity:async()=>identity,exec:async()=>({stdout:'head'}),snapshot:async()=>({}),digest:()=> 'baseline',prompt:()=> 'fixture task',grade:async()=>({passed:true,failed:[],artifact:'fixed'})}
  let launches=0
  const dependencies={
   loadProfile:async()=>({baseUrl:'http://127.0.0.1:1',apiKey:'fixture-only',model:'fixture'}),
   launch:async(options:any,host:any)=>{
    launches++
    assert.equal(options.workspaceBoundary,'root-only')
    await options.recordEvent({event:'attempt_started'})
    const result=await host.runTui({command:'/fixture/host',env:{TMPDIR:'managed-host',CHAOS_RUNTIME_WORKSPACE_ROOT:root}})
    await options.recordEvent({event:'mission_finished',outcome:'succeeded'})
    return result
   },
   nativeExec:(_command:any,args:any,options:any)=>{
    assert.equal(options.env.TSX_DISABLE_CACHE,'1')
    assert.equal(options.env.TMPDIR,'managed-host')
    assert.equal(options.cwd,root)
    assert(args.includes('fixture task'))
    return Object.assign(Promise.resolve({stdout:''}),{child:{stdin:{end(){}}}})
   },
  }
  await runTask(suite as any,task.id,'personal',dependencies as any)
  assert.equal(launches,1)
  const saved=JSON.parse(await readFile(join(state,'result.json'),'utf8'))
  assert.equal(saved.assistance,0);assert.equal(saved.hostFailure,false);assert.equal(saved.missionOutcome,'succeeded')
  await assert.rejects(runTask(suite as any,task.id,'personal',dependencies as any),/already consumed/)
  assert.equal(launches,1)
 } finally {await rm(temp,{recursive:true,force:true})}
})

test('serial batch stops at first failure and does not dispatch the next task',async()=>{
 const base=await mkdtemp(join(tmpdir(),'eval20-batch-'))
 try {
  const calls:string[]=[]
  const suite={base,tasks:[{id:'one'},{id:'two'},{id:'three'}],assertBatchAdmission:async()=>{},exists:async()=>false}
  const runner={assertFresh:async()=>{},runTask:async(_suite:any,id:string)=>{calls.push(id);return {category:id==='one'?'independent_pass':'task_failed',assistance:0}}}
  const result=await runBatch(suite,runner)
  assert.deepEqual(calls,['one','two']);assert.equal(result.length,2)
 } finally {await rm(base,{recursive:true,force:true})}
})
