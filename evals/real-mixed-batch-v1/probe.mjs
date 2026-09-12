import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { makeCopy, command, harness } from './common.mjs'
import { repair, mutate } from './fixtures.mjs'

export async function inspect(task,source,{signal,fixture,full=true}={}) {
  const {scratch,copy,dispose}=await makeCopy(task,source),started=performance.now(),checks=[]
  const run=async(id,cmd,args,timeout)=>{
    const r=await command(task,scratch,copy,cmd,args,signal,timeout)
    checks.push({id,passed:r.passed,exitCode:r.exitCode,timedOut:r.timedOut??false,output:r.output.slice(-14000)})
    return r.passed
  }
  try {
    if(fixture){await repair(task,copy);if(fixture!=='fixed')await mutate(task,copy,fixture)}
    const build=task.kind==='yargs'?['npm',['run','compile']]:task.kind==='semaphore'?['yarn',['build']]:null
    const built=build?await run('build','/usr/bin/env',build.flat(),60000):true
    if(built) {
      const probe=join(harness,'evals/real-mixed-batch-v1',task.kind==='semaphore'?'semaphore-probe.mjs':task.kind==='yargs'?'yargs-probe.mjs':'fjs-probe.mjs')
      const groups=task.kind==='semaphore'?['controls','empty','sparse','priority']:['controls','defect']
      for(const group of groups)await run(group,process.execPath,[probe,copy,group],task.kind==='semaphore'?3000:10000)
      if(full) {
        const commands=task.kind==='yargs'?[['npm','test'],['npm','run','test:typescript'],['npm','run','check']]:task.kind==='semaphore'?[['yarn','test']]:[['npm','test'],['npm','run','lint']]
        for(const args of commands)await run('upstream:'+args.join(' '),'/usr/bin/env',args,120000)
      }
    }
    return {passed:checks.every(c=>c.passed),elapsedMs:Math.round(performance.now()-started),checks}
  } finally {await dispose()}
}
