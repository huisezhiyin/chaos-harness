import {readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import * as suite from './suite.mjs'

const directory=join(suite.harness,'evals/preview-eval16-v2')
const [command='report']=process.argv.slice(2)
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)

async function qualify(){
 if(await suite.exists(join(suite.base,'qualification.json')))throw Error('Qualification already frozen; preserve it')
 const started=await suite.identity(),attempt=Date.now()
 const localChecks=[]
 for(const [binary,args] of [
  ['pnpm',['exec','tsc','--noEmit','-p',join(directory,'tsconfig.json')]],
  [process.execPath,['--import','tsx','--test',join(directory,'catalog.test.mjs'),join(directory,'runtime.check.mts'),join(directory,'run.check.mts'),join(directory,'online.check.mts')]],
  ['python3',[join(directory,'delivery_test.py')]],
  ['python3',[join(directory,'grade_test.py')]],
 ]){
  const result=await suite.exec(binary,args,{cwd:suite.harness,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:360000,maxBuffer:4*1024*1024})
  localChecks.push({command:[binary,...args],passed:true,outputSha256:suite.sha(result.stdout+result.stderr)})
 }
 const running=suite.exec('python3',[join(directory,'check-owner-references.py'),'--full','--mutants'],{cwd:suite.harness,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:900000,maxBuffer:8*1024*1024})
 running.child.stdout?.on('data',chunk=>process.stdout.write(chunk))
 await running
 if(!same(started,await suite.identity()))throw Error('Runtime changed during qualification')
 const checker={}
 for(const name of (await readdir(directory)).sort())if(/\.(py|mjs|mts|json)$/.test(name)&&name!=='preparation-report.json')checker[name]=suite.sha(await readFile(join(directory,name)))
 const records=[]
 for(const task of suite.tasks){
  const folder=join(suite.base,'owner-reference-checks',task.slug)
  const latest=(await readdir(folder)).sort().at(-1),path=join(folder,latest,'result.json'),result=await suite.readJson(path)
  if(!result.passed||!result.referenceDelivery?.passed||!result.postChecksDelivery?.passed)throw Error('Reference qualification failed: '+task.id)
  if(suite.digest(result.checkerIdentity)!==suite.digest(checker))throw Error('Checker changed: '+task.id)
  const required=['reference-behavior','reference-package']
  if(task.kind==='feature')required.push('reference-types-contract')
  if(task.kind==='refactor')required.push('reference-structure')
  if(task.repo==='fastify/fast-uri')required.push('reference-lint','reference-types')
  if(required.some(name=>!result.checks.some(c=>c.name===name&&c.exitCode===0)))throw Error('Missing reference check: '+task.id)
  for(const check of result.checks)if(suite.sha(await readFile(join(folder,latest,check.name+'.log')))!==check.sha256)throw Error('Check log changed')
  if(task.kind==='tests'){
   if(!result.baselineNewTestsMissing)throw Error('Test baseline not verified')
  }else{
   const name=task.kind==='refactor'?'baseline-structure':'baseline-behavior',baseline=result.checks.find(c=>c.name===name)
   const output=JSON.parse((await readFile(join(folder,latest,name+'.log'),'utf8')).trim().split('\n').at(-1))
   if(baseline?.exitCode!==1||output.passed!==false||output.errorCode!==(task.slug==='query-relative-fragment'?'ERR_INVALID_URL':'ERR_ASSERTION'))throw Error('Baseline failed for an unexpected reason: '+task.id)
  }
  const count=task.slug==='queue-priority-lifecycle'?3:2
  if(result.mutants?.length!==count||result.mutants.some(m=>!m.rejected))throw Error('Negative controls incomplete: '+task.id)
  records.push({id:task.id,passed:true,record:'owner-reference-checks/'+task.slug+'/'+latest+'/result.json',sha256:suite.sha(await readFile(path)),mutantsRejected:count})
 }
 const qualification={passed:true,identity:started,localChecks,tasks:records,providerCalls:0,createdAt:new Date().toISOString()}
 await suite.writeOnce(join(suite.base,'qualification-attempt-'+attempt+'.json'),qualification)
 await suite.writeOnce(join(suite.base,'qualification.json'),qualification)
 console.log(JSON.stringify({qualified:records.length,mutantsRejected:records.reduce((n,r)=>n+r.mutantsRejected,0),providerCalls:0}))
}

async function prepare(){
 const q=await suite.readJson(join(suite.base,'qualification.json')),identity=await suite.identity()
 if(!q.passed||!same(q.identity,identity))throw Error('Qualification missing or stale')
 if(await suite.exists(join(suite.base,'batch-admission.json')))throw Error('Batch admission already exists; use preflight')
 const {stdout}=await suite.exec('python3',[join(directory,'bootstrap.py')],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:120000,maxBuffer:4*1024*1024});process.stdout.write(stdout)
 for(const task of suite.tasks){
  const state=join(suite.base,task.id),bootstrap=await suite.readJson(join(state,'bootstrap.json')),root=suite.rootFor(task)
  if(await suite.exists(join(state,'run.started.json')))throw Error('Task already consumed')
  const baseline=await suite.snapshot(root),key=task.repo.replace('/','--')+'-'+task.head
  const admission={id:task.id,root,sourceHead:task.head,head:bootstrap.head,baseline,artifact:suite.digest(baseline),suite:identity,environmentSha256:suite.sha(await readFile(join(suite.base,'dependencies-v2',key,'environment.json')))}
  await suite.checkDependencies(task.id,root,admission)
  await suite.writeOnce(join(state,'admission.json'),admission)
 }
 if(!same(identity,await suite.identity()))throw Error('Runtime changed while admitting tasks')
 await suite.writeOnce(join(suite.base,'batch-admission.json'),{identity,tasks:suite.tasks.map(t=>t.id),qualificationSha256:suite.sha(await readFile(join(suite.base,'qualification.json'))),providerCalls:0})
 console.log(JSON.stringify({admitted:suite.tasks.length,providerCalls:0}))
}

async function report(){
 const q=await suite.readJson(join(suite.base,'qualification.json')).catch(()=>null)
 const current=await suite.identity(),qualificationValid=Boolean(q?.passed&&same(q.identity,current))
 const rows=[]
 for(const task of suite.tasks){const result=await suite.readJson(join(suite.base,task.id,'result.json')).catch(()=>null);rows.push({task:task.slug,state:result?.category??(await suite.exists(join(suite.base,task.id,'run.started.json'))?'started':'not_run'),seconds:result?.seconds,actions:result?.actions,assistance:result?.assistance})}
 console.log(JSON.stringify({batchId:suite.batchId,qualified:qualificationValid?q.tasks.length:0,qualificationValid,admitted:qualificationValid&&await suite.exists(join(suite.base,'batch-admission.json')),tasks:rows},null,2))
}

try {
 if(process.argv.slice(2).length>1)throw Error('Unexpected arguments')
 if(command==='qualify')await qualify()
 else if(command==='prepare')await prepare()
 else if(command==='preflight'){await suite.assertBatchAdmission();const runner=await import('./run.mts');console.log(JSON.stringify({pending:await runner.pendingTasks(suite),providerCalls:0}))}
 else if(command==='run-all'){
  const runner=await import('./run.mts'),{runBatch}=await import('../real-mixed-batch-v3-workdir/batch.mjs')
  const results=await runBatch(suite,runner)
  process.exitCode=results.every(r=>r.category==='independent_pass'&&r.assistance===0)?0:1
  await report()
 }else if(command==='report')await report()
 else throw Error('Use qualify, prepare, preflight, run-all or report')
}catch(error){console.error(error.message);process.exitCode=2}
