import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { makeCopy, command, harness } from './common.mjs'
import { repair, mutate } from './fixtures.mjs'

export async function inspect(task,source,options={}) {
  const owned=await makeCopy(task,source)
  try { return await inspectCopy(task,owned,options) } finally { await owned.dispose() }
}
// Also used by the integration check with an independently copied dependency tree.
export async function inspectCopy(task,{scratch,copy},{signal,fixture,full=true,exerciseLive=false,toolsRoot}={}) {
  const started=performance.now(),checks=[]
  const run=async(id,cmd,args,timeout,live=false)=>{
    const r=await command(task,scratch,copy,cmd,args,signal,timeout,live,toolsRoot)
    checks.push({id,passed:r.passed,exitCode:r.exitCode,timedOut:r.timedOut??false,output:r.output.slice(-14000)})
    return r.passed
  }
  {
    if(fixture){await repair(task,copy);if(fixture!=='fixed')await mutate(task,copy,fixture)}
    const build=task.kind==='yargs'?['npm',['run','compile']]:task.kind==='semaphore'?['yarn',['build']]:null
    const commands=task.kind==='yargs'?[['npm','test'],['npm','run','test:typescript'],['npm','run','check']]:task.kind==='semaphore'?[['yarn','test']]:[['npm','test'],['npm','run','lint']]
    if(exerciseLive) {
      if(fixture!=='fixed')throw Error('Live-environment qualification requires an owner positive control')
      const ready=build?await run('live-build','/usr/bin/env',build.flat(),60000,true):true
      if(ready)for(const args of commands)await run('live-upstream:'+args.join(' '),'/usr/bin/env',args,120000,true)
      if(task.kind==='semaphore')checks.push({id:'live-nyc-cache-exercised',passed:(await readdir(join(scratch,'cache/live/nyc')).catch(()=>[])).length>0,output:''})
    }
    const built=build?await run('build','/usr/bin/env',build.flat(),60000):true
    if(built) {
      const probe=join(harness,'evals/real-mixed-batch-v2-cache',task.kind==='semaphore'?'semaphore-probe.mjs':task.kind==='yargs'?'yargs-probe.mjs':'fjs-probe.mjs')
      const groups=task.kind==='semaphore'?['controls','empty','sparse','priority']:['controls','defect']
      for(const group of groups)await run(group,process.execPath,[probe,copy,group],task.kind==='semaphore'?3000:10000)
      if(full) {
        for(const args of commands)await run('upstream:'+args.join(' '),'/usr/bin/env',args,120000)
      }
    }
    if(exerciseLive&&task.kind==='semaphore')checks.push({id:'qualifier-nyc-cache-exercised',passed:(await readdir(join(scratch,'cache/verifier/nyc')).catch(()=>[])).length>0,output:''})
    return {passed:checks.every(c=>c.passed),elapsedMs:Math.round(performance.now()-started),checks}
  }
}
