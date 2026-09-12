import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {prepareRuntime} from './environment.mjs'
import plugin from './shell-environment-plugin.mjs'
import {scratchFindings} from './workdir.mjs'
async function fixture(fn) {const base=await realpath(await mkdtemp(join(tmpdir(),'chaos-managed-env-')));try{const root=join(base,'workspace'),cache=join(base,'cache');await mkdir(root);await mkdir(cache);await fn(root,cache,base)}finally{await rm(base,{recursive:true,force:true})}}
test('Host and tool tmp are disjoint; runtime cache cannot hide candidate leftovers',()=>fixture(async(root,cache)=>{
 const runtime=await prepareRuntime({workspaceRoot:root,cacheRoot:cache}),env=runtime.hostEnvironment({TMPDIR:'/wrong',NODE_COMPILE_CACHE:'/wrong'})
 assert.notEqual(env.TMPDIR,runtime.toolEnvironment.TMPDIR)
 const old={...process.env};Object.assign(process.env,env)
 try{
  const hooks=await plugin(),out={env:{KEEP:'yes'}};await hooks['shell.env']({cwd:root},out)
  assert.equal(out.env.KEEP,'yes');assert.equal(out.env.TMPDIR,join(root,'test/.chaos-tmp'));assert.equal(out.env.NODE_COMPILE_CACHE,join(cache,'managed-runtime/node-compile-cache'))
  await assert.rejects(()=>hooks['shell.env']({cwd:cache},{env:{}}),/escaped/)
  await writeFile(join(env.TMPDIR,'host.dylib'),'host');assert.deepEqual(await scratchFindings(root),[])
  await writeFile(join(root,'test/.chaos-tmp','user.log'),'user');assert.deepEqual(await scratchFindings(root),['temporary-files-remain'])
  assert.equal(await readFile(join(root,'test/.chaos-tmp','user.log'),'utf8'),'user')
 }finally{for(const k of Object.keys(env))if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k]}
}))
test('managed paths reject symlink destinations before writes',()=>fixture(async(root,cache,base)=>{
 const elsewhere=join(base,'elsewhere');await mkdir(elsewhere);await symlink(elsewhere,join(cache,'managed-runtime'))
 await assert.rejects(()=>prepareRuntime({workspaceRoot:root,cacheRoot:cache}),/physical/);assert.deepEqual(await readdir(elsewhere),[])
 await assert.rejects(()=>prepareRuntime({workspaceRoot:root,cacheRoot:root}),/separate/)
}))
