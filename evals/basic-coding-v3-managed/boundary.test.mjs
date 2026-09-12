import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {boundary,tasks} from './suite.mjs'
import {scratchFindings,prepareScratch} from './workdir.mjs'
test('new batch preserves existing tests and configuration, and requires task deliverables',()=>{
 const before={'index.d.ts':'old','readme.md':'old','index.js':'old','package.json':'original','test/existing.test.js':'old-test'}
 const feature=tasks[0],tests=tasks[1]
 assert.deepEqual(boundary(feature,before,{...before,'index.js':'new','index.d.ts':'new','readme.md':'new','test/new.test.js':'new-test'}).failed,[])
 assert.ok(boundary(tests,before,{...before,'index.js':'new','test/new.test.js':'new-test'}).failed.includes('scope:index.js'))
 assert.ok(boundary(feature,before,{...before,'index.js':'new'}).failed.includes('regression-tests-missing'))
 assert.ok(boundary(feature,before,{...before,'test/new.test.js':'test'}).failed.includes('implementation-missing'))
 assert.ok(boundary(tests,before,{...before,'test/existing.test.js':'changed','test/new.test.js':'test'}).failed.includes('protected-test:test/existing.test.js'))
 assert.ok(boundary(tests,before,{...before,'package.json':'changed','test/new.test.js':'test'}).failed.includes('scope:package.json'))
})
test('strict managed acceptance rejects even an empty legacy Host directory',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'chaos-v3-boundary-')))
 try{
  const scratch=await prepareScratch(root)
  assert.deepEqual(await scratchFindings(root),[])
  await mkdir(join(scratch,'opencode'))
  assert.deepEqual(await scratchFindings(root),['temporary-files-remain'])
  await writeFile(join(scratch,'user.log'),'preserve')
  assert.deepEqual(await scratchFindings(root),['temporary-files-remain'])
 }finally{await rm(root,{recursive:true,force:true})}
})
