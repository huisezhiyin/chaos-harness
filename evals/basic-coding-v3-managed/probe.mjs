import {readdir,readFile,writeFile,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'
import {makeCopy,command,harness} from './common.mjs'
import {repair,mutate,mutants} from './fixtures.mjs'
import {scratchFindings} from './workdir.mjs'
export async function inspect(task,source,options={}) {
 const owned=await makeCopy(task,source)
 try{return await inspectCopy(task,owned,options)}finally{await owned.dispose()}
}
export async function inspectCopy(task,{scratch,copy},{signal,fixture,full=true,exerciseLive=false}={}){
 const start=performance.now(),checks=[]
 const record=(id,r)=>checks.push({id,passed:r.passed,exitCode:r.exitCode,timedOut:r.timedOut??false,output:r.output.slice(-14000)})
 const run=async(id,cmd,args,timeout=30000,live=false)=>record(id,await command(task,scratch,copy,cmd,args,signal,timeout,live))
 if(fixture){await repair(task,copy);if(fixture!=='fixed')await mutate(task,copy,fixture)}
 if(exerciseLive)await run('live-upstream:npm test','/usr/bin/env',['npm','test'],120000,true)
 for(const group of task.kind==='defer'?['controls','defect']:['controls'])await run(group,process.execPath,[join(harness,'evals/basic-coding-v3-managed/contract-probe.mjs'),copy,task.kind,group],10000)
 if(task.kind==='defer'){
  await writeFile(join(copy,'test/owner-defer.ts'),`import pDefer from '../index.js';\nconst d=pDefer<number>();\nconst status:boolean=d.settled;\ntype Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;\nconst exact:Equal<typeof d.settled,boolean>=true;\n// @ts-expect-error readonly\nd.settled=true;\nconst promise:Promise<number>=d.promise;\nd.resolve(1);\n// @ts-expect-error wrong value\nd.resolve('wrong');\n`)
  await run('new-types',process.execPath,[join(harness,'evals/basic-coding-v3-managed/type-probe.mjs'),copy],15000)
  await unlink(join(copy,'test/owner-defer.ts'))
 }
 if(full)await run('upstream:npm test','/usr/bin/env',['npm','test'],120000)
 if(task.kind==='once'){
  const tests=(await readdir(join(copy,'test')).catch(()=>[])).filter(p=>p.endsWith('.test.js')).map(p=>'test/'+p)
  if(!tests.length)checks.push({id:'new-tests',passed:false,output:'AssertionError: new tests missing'})
  else{
   const args=[join(copy,'node_modules/ava/entrypoints/cli.mjs'),...tests]
   await run('new-tests',process.execPath,args,15000)
   if(!fixture||fixture==='fixed'){
    const file=join(copy,'index.js'),source=await readFile(file,'utf8')
    for(const id of mutants(task)){
     await mutate(task,copy,id)
     const r=await command(task,scratch,copy,process.execPath,args,signal,15000)
     checks.push({id:'new-tests-kill:'+id,passed:!r.passed&&!r.timedOut&&r.exitCode===1&&/tests? failed/.test(r.output)&&!/Internal error|EPERM|ENOENT/.test(r.output),output:r.output.slice(-3000)})
     await writeFile(file,source)
    }
   }
  }
 }
 const leftovers=await scratchFindings(copy)
 checks.push({id:'runtime-scratch',passed:!leftovers.length,output:JSON.stringify(leftovers)})
 return {passed:checks.every(c=>c.passed),elapsedMs:Math.round(performance.now()-start),checks}
}
