import {readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'
import {makeCopy,command,harness} from './common.mjs'
import {repair,mutate,mutants} from './fixtures.mjs'

export async function inspect(task,source,options={}) {
  const owned=await makeCopy(task,source)
  try{return await inspectCopy(task,owned,options)}finally{await owned.dispose()}
}
export async function inspectCopy(task,{scratch,copy},{signal,fixture,full=true,exerciseLive=false,toolsRoot}={}) {
  const start=performance.now(),checks=[]
  const run=async(id,cmd,args,timeout=30000,live=false)=>{const r=await command(task,scratch,copy,cmd,args,signal,timeout,live,toolsRoot);checks.push({id,passed:r.passed,exitCode:r.exitCode,timedOut:r.timedOut??false,output:r.output.slice(-14000)});return r.passed}
  if(fixture){await repair(task,copy);if(fixture!=='fixed')await mutate(task,copy,fixture)}
  const build=async(live=false)=>task.kind==='equal'?run(live?'live-build':'build','/usr/bin/env',['npm','run','build'],30000,live):true
  if(exerciseLive){if(await build(true))await run('live-upstream:npm test','/usr/bin/env',['npm','test'],120000,true)}
  if(await build()) {
    const groups=task.kind==='equal'||task.kind==='queue'?['controls','defect']:task.kind==='retry'?['controls','structure']:['controls']
    for(const group of groups)await run(group,process.execPath,[join(harness,'evals/basic-coding-v2-host-scratch/contract-probe.mjs'),copy,task.kind,group],group==='defect'&&task.kind==='equal'?3000:10000)
    if(task.kind==='queue') {
      const {writeFile,unlink}=await import('node:fs/promises');await writeFile(join(copy,'test/owner-queue.test-d.ts'),`import {expectType,expectError} from 'tsd';\nimport Queue from '../index.js';\nconst q=new Queue<string>();\nexpectType<void>(q.enqueueAll(['a']));\nexpectType<void>(q.enqueueAll(new Set(['b'])));\nexpectError(q.enqueueAll([1]));\n`)
      await run('new-types',process.execPath,[join(harness,'evals/basic-coding-v2-host-scratch/type-probe.mjs'),copy],15000)
      await unlink(join(copy,'test/owner-queue.test-d.ts'))
    }
    if(full)await run('upstream:npm test','/usr/bin/env',['npm','test'],120000)
    if(task.kind==='limit') {
      const tests=(await readdir(join(copy,'test')).catch(()=>[])).filter(p=>p.endsWith('.test.js'))
      if(!tests.length)checks.push({id:'new-tests',passed:false,output:'AssertionError: new tests missing'})
      else {
        await run('new-tests','/usr/bin/env',['node',join(copy,'node_modules/ava/entrypoints/cli.mjs'),...tests.map(p=>'test/'+p)],15000)
        if(!fixture||fixture==='fixed') {
          // A verifier copy has no Git index; preserve its source before each isolated mutant.
          const {readFile,writeFile}=await import('node:fs/promises'),file=join(copy,'index.js'),text=await readFile(file,'utf8')
          for(const id of mutants(task)) {
            await mutate(task,copy,id)
            const r=await command(task,scratch,copy,'/usr/bin/env',['node',join(copy,'node_modules/ava/entrypoints/cli.mjs'),...tests.map(p=>'test/'+p)],signal,15000,false,toolsRoot)
            checks.push({id:'new-tests-kill:'+id,passed:!r.passed&&!r.timedOut&&r.exitCode===1&&/tests? failed/.test(r.output)&&!/Internal error|EPERM|ENOENT/.test(r.output),output:r.output.slice(-2000)})
            await writeFile(file,text)
          }
        }
      }
    }
  }
  return {passed:checks.every(c=>c.passed),elapsedMs:Math.round(performance.now()-start),checks}
}
