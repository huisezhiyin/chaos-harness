import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runBatch} from './batch.mjs'
import {boundary} from './suite.mjs'

const task={allowed:['src/fix.ts','test/']},initial={'src/fix.ts':'old','test/existing.ts':'original','package.json':'protected'}
test('artifact boundary requires source and new regressions, preserving existing tests and manifests',()=>{
  const good={...initial,'src/fix.ts':'new','test/regression.ts':'assertion'}
  assert.deepEqual(boundary(task,initial,good).failed,[])
  assert(boundary(task,initial,initial).failed.includes('no-mutation'))
  assert(boundary(task,initial,{...initial,'src/fix.ts':'new'}).failed.includes('regression-tests-missing'))
  assert(boundary(task,initial,{...good,'package.json':'changed'}).failed.includes('scope:package.json'))
  assert(boundary(task,initial,{...good,'test/existing.ts':'weakened'}).failed.includes('protected-test:test/existing.ts'))
  const deleted={...good};delete deleted['package.json'];assert(boundary(task,initial,deleted).failed.includes('scope:package.json'))
})
async function fixture(fn) {
  const base=await mkdtemp(join(tmpdir(),'chaos-mixed-batch-test-')),tasks=['a','b','c'].map(id=>({id})),calls=[]
  for(const t of tasks)await mkdir(join(base,t.id))
  const suite={base,tasks,exists:async p=>{try{await readFile(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}},readJson:async p=>JSON.parse(await readFile(p,'utf8')),assertBatchAdmission:async()=>{calls.push('admission')}}
  const runner={assertFresh:async(_s,id)=>calls.push('fresh:'+id),runTask:async(_s,id)=>{
    calls.push('run:'+id);const r={task:id,category:'independent_pass',assistance:0};await writeFile(join(base,id,'run.started.json'),'{}',{flag:'wx'});await writeFile(join(base,id,'result.json'),JSON.stringify(r),{flag:'wx'});return r
  }}
  try{await fn({base,suite,runner,calls})}finally{await rm(base,{recursive:true,force:true})}
}
test('preflight all tasks first, then serial single-use execution and read-only consumed rejection',()=>fixture(async({base,suite,runner,calls})=>{
  assert.equal((await runBatch(suite,runner)).length,3)
  assert.deepEqual(calls,['admission','fresh:a','fresh:b','fresh:c','run:a','run:b','run:c'])
  const before=await readFile(join(base,'a','result.json'),'utf8');await assert.rejects(()=>runBatch(suite,runner),/consumed/);assert.equal(await readFile(join(base,'a','result.json'),'utf8'),before)
}))
test('stale last task prevents every dispatch',()=>fixture(async({suite,runner,calls})=>{
  runner.assertFresh=async(_s,id)=>{if(id==='c')throw Error('stale')}
  await assert.rejects(()=>runBatch(suite,runner),/stale/);assert(!calls.some(x=>x.startsWith('run:')))
}))
test('failure pauses batch; explicit continuation visits only unconsumed items',()=>fixture(async({base,suite,runner,calls})=>{
  const original=runner.runTask
  runner.runTask=async(s,id)=>{const r=await original(s,id);if(id==='a'){r.category='timeout_interruption';await writeFile(join(base,id,'result.json'),JSON.stringify(r))}return r}
  assert.equal((await runBatch(suite,runner)).length,1)
  await assert.rejects(()=>runBatch(suite,runner),/Earlier task/)
  assert.equal((await runBatch(suite,runner,{continueUnrun:true})).length,2)
  assert.equal(calls.filter(x=>x==='run:a').length,1)
}))
test('started-without-result remains consumed and blocks ordinary continuation',()=>fixture(async({base,suite,runner,calls})=>{
  await writeFile(join(base,'a','run.started.json'),'{}')
  await assert.rejects(()=>runBatch(suite,runner),/Earlier task/)
  await runBatch(suite,runner,{continueUnrun:true});assert(!calls.includes('run:a'))
}))
test('concurrent invocation rejects before preflight or dispatch',()=>fixture(async({suite,runner,calls})=>{
  let release,entered
  const waiting=new Promise(r=>{release=r}),ready=new Promise(r=>{entered=r})
  suite.assertBatchAdmission=async()=>{entered();await waiting}
  const active=runBatch(suite,runner);await ready
  await assert.rejects(()=>runBatch(suite,runner),/locked/)
  release();await active;assert.equal(calls.filter(x=>x.startsWith('run:')).length,3)
}))
test('failed admission never dispatches and releases only its own lock',()=>fixture(async({suite,runner,calls})=>{
  suite.assertBatchAdmission=async()=>{throw Error('bad admission')}
  await assert.rejects(()=>runBatch(suite,runner),/bad admission/)
  suite.assertBatchAdmission=async()=>{};await runBatch(suite,runner);assert.equal(calls.filter(x=>x.startsWith('run:')).length,3)
}))
