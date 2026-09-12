import assert from 'node:assert/strict'
import {test} from 'node:test'
import {boundary,tasks,prompt,readJson,harness,sha} from './suite.mjs'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

test('all ordinary task contracts reject no-op, unrelated mutations and fake regression logs',()=>{
  for(const task of tasks) {
    const source=task.kind==='equal'?'src/index.jst':'index.js'
    const file=task.kind==='equal'?'spec/new.spec.js':'test/new.test.js'
    const before={[source]:'old'},after={...before,[file]:'tests'}
    if(task.taskType!=='tests')after[source]='changed'
    assert.deepEqual(boundary(task,before,after).failed,[])
    assert(boundary(task,before,before).failed.includes('no-mutation'))
    assert(boundary(task,before,{...after,'package.json':'change'}).failed.includes('scope:package.json'))
    assert(boundary(task,before,{...before,'test/notes.log':'text'}).failed.includes('regression-tests-missing'))
    assert(boundary(task,{...before,[file]:'original'},{...after,[file]:'changed'}).failed.includes('protected-test:'+file))
    if(task.taskType==='tests')assert(boundary(task,before,{...after,[source]:'change'}).failed.includes('scope:'+source))
  }
})
test('test-only task is distinct and public prompts disclose provenance and workspace constraints',()=>{
  assert.deepEqual(tasks.map(t=>t.taskType),['bug','feature','refactor','tests'])
  for(const task of tasks){const text=prompt(task);assert(text.includes('owner-authored'));assert(text.includes('900 seconds'));assert(text.includes('test/.chaos-tmp'));assert(!text.includes('fixtures.mjs'))}
})
test('frozen Harness sources remain byte-identical',async()=>{
  const frozen=await readJson(join(harness,'mydocs/freezes/2026-09-07_code-harness-eval-v3-baseline.json'))
  for(const [path,expected] of Object.entries(frozen.sourceSha256))assert.equal(sha(await readFile(join(harness,path))),expected,path)
})
