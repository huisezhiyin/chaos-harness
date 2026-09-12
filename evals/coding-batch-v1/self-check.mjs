import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {tasks,files,put,grade} from './suite.mjs'
const root=await mkdtemp(join(tmpdir(),'chaos-eval-integrity-'))
try{
  const t=tasks[0],original=files(t)
  await put(root,{...original,...t.reference,'test/regression.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import * as api from '../src/index.js';test('contract',()=>{"+t.checks+"})"})
  assert.equal((await grade(t,root)).passed,true)
  await writeFile(join(root,'package.json'),'{"type":"module","scripts":{"test":"exit 0"}}')
  assert.ok((await grade(t,root)).failed.includes('immutable:package.json'))
  await writeFile(join(root,'package.json'),original['package.json'])
  await writeFile(join(root,'unexpected.txt'),'unrelated artifact')
  assert.ok((await grade(t,root)).failed.includes('scope:unexpected.txt'))
  await unlink(join(root,'unexpected.txt'))
  await writeFile(join(root,'test/regression.test.js'),"import test from 'node:test';test('failure',()=>{throw new Error('fail')})")
  assert.ok((await grade(t,root)).failed.includes('public-tests'))
  console.log('Integrity checks passed: valid candidate, immutable package, scope, failing test.')
}finally{await rm(root,{recursive:true,force:true})}
