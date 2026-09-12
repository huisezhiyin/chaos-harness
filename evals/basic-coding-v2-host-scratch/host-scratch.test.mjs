import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,symlink,realpath,readFile} from 'node:fs/promises'
import {tmpdir,homedir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {prepareScratch,scratchFindings} from './workdir.mjs'
const exec=promisify(execFile)
async function temporary(fn) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'chaos-host-scratch-v2-')))
  try {await prepareScratch(root);await fn(root,join(root,'test/.chaos-tmp'))} finally {await rm(root,{recursive:true,force:true})}
}
test('only the exact empty physical Host directory is accepted',async()=>{
 await temporary(async(root,scratch)=>{
  assert.deepEqual(await scratchFindings(root),[])
  const host=join(scratch,'opencode');await mkdir(host)
  assert.deepEqual(await scratchFindings(root),[])
  await writeFile(join(host,'.hidden'),'x');assert.deepEqual(await scratchFindings(root),['temporary-files-remain'])
  await rm(join(host,'.hidden'));await mkdir(join(host,'nested'));assert.deepEqual(await scratchFindings(root),['temporary-files-remain'])
  await rm(host,{recursive:true});await writeFile(host,'x');assert.deepEqual(await scratchFindings(root),['temporary-directory-invalid'])
  await rm(host);await mkdir(join(root,'outside'));await symlink(join(root,'outside'),host)
  assert.deepEqual(await scratchFindings(root),['temporary-directory-invalid'])
  await rm(host);await mkdir(join(scratch,'unknown'));assert.deepEqual(await scratchFindings(root),['temporary-files-remain'])
  await rm(join(scratch,'unknown'),{recursive:true});await rm(scratch,{recursive:true});await symlink(join(root,'outside'),scratch)
  assert.deepEqual(await scratchFindings(root),['temporary-directory-invalid'])
 })
})
test('actual OpenCode initialization creates acceptable Host scratch without a provider',async()=>{
 await temporary(async(root,scratch)=>{
  const binary=process.env.OPENCODE_BIN?.trim()||join(homedir(),'.opencode/bin/opencode')
  const env={PATH:'/usr/bin:/bin:/opt/homebrew/bin',HOME:root,OPENCODE_TEST_HOME:root,TMPDIR:scratch,TMP:scratch,TEMP:scratch,XDG_DATA_HOME:join(root,'data'),XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true'}
  const policy=`(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath ${JSON.stringify(root)})))`
  const result=await exec('/usr/bin/sandbox-exec',['-p',policy,binary,'--help'],{cwd:root,env,timeout:20000,maxBuffer:1024*1024})
  assert.match(result.stdout+result.stderr,/opencode/)
  assert.equal(await realpath(join(scratch,'opencode')),join(scratch,'opencode'))
  assert.deepEqual(await scratchFindings(root),[])
  console.log(JSON.stringify({hostInitialization:'passed',providerCalls:0,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex')}))
 })
})
test('delivery readiness uses the same Host-directory rule',async()=>{
 const {inspectReadiness}=await import('./readiness.mjs')
 await temporary(async(root,scratch)=>{
  await mkdir(join(root,'state/task'),{recursive:true})
  await writeFile(join(root,'state/task/admission.json'),JSON.stringify({root,baseline:{}}))
  const suite={base:join(root,'state'),getTask:()=>({}),snapshot:async()=>({}),boundary:()=>({failed:[]})}
  await mkdir(join(scratch,'opencode'))
  assert.equal((await inspectReadiness(suite,'task',root,AbortSignal.timeout(1000))).passed,true)
  await writeFile(join(scratch,'opencode','leftover'),'x')
  assert.equal((await inspectReadiness(suite,'task',root,AbortSignal.timeout(1000))).passed,false)
 })
})
