import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,readdir,symlink} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {prepareRuntime} from './environment.mjs'
import {scratchFindings} from './workdir.mjs'
import {treeDigest} from '../basic-coding-v2-host-scratch/common.mjs'
const exec=promisify(execFile)
test('real AVA repeated runs leave managed compiler cache and no task scratch residue',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'chaos-ava-managed-'))),root=join(base,'workspace'),cache=join(base,'cache')
 const deps=join(homedir(),'.local/state/chaos-harness/evals/basic-coding-v2-host-scratch/dependencies/basic-coding-v2-host-scratch-04-limit-regressions/node_modules')
 const before=await treeDigest(deps)
 try {
  await mkdir(root);await mkdir(cache);await mkdir(join(root,'node_modules'))
  for(const name of await readdir(deps))if(name!=='.cache')await symlink(join(deps,name),join(root,'node_modules',name))
  await mkdir(join(root,'node_modules/.cache'))
  const runtime=await prepareRuntime({workspaceRoot:root,cacheRoot:cache})
  await writeFile(join(root,'package.json'),JSON.stringify({name:'managed-runtime-fixture',type:'module',private:true}))
  await writeFile(join(root,'test/runtime.test.js'),`import test from 'ava';import os from 'node:os';test('confined tmp',t=>{t.is(os.tmpdir(),${JSON.stringify(join(root,'test/.chaos-tmp'))});t.true(process.env.NODE_COMPILE_CACHE.startsWith(${JSON.stringify(cache)}));});`)
  const env={PATH:'/usr/bin:/bin',HOME:base,...runtime.toolEnvironment}
  const policy=`(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath ${JSON.stringify(base)})))`
  for(let i=0;i<2;i++) {
   const result=await exec('/usr/bin/sandbox-exec',['-p',policy,process.execPath,join(root,'node_modules/ava/entrypoints/cli.mjs'),'test/runtime.test.js'],{cwd:root,env,timeout:20000,maxBuffer:1024*1024})
   assert.match(result.stdout+result.stderr,/1 test passed/);assert.deepEqual(await scratchFindings(root),[])
  }
  assert((await readdir(runtime.toolEnvironment.NODE_COMPILE_CACHE)).length>0)
  assert.equal(await treeDigest(deps),before)
  console.log('AVA x2: cache separated; task scratch empty; dependency hash unchanged')
 }finally{await rm(base,{recursive:true,force:true})}
})
