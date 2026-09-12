import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,chmod,lstat,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {prepareRuntime} from './environment.mjs'
import plugin from './shell-environment-plugin.mjs'
async function fixture(fn){
 const base=await realpath(await mkdtemp(join(tmpdir(),'scratch-recovery-'))),root=join(base,'root'),cache=join(base,'cache'),outside=join(base,'outside')
 const old={...process.env}
 try{
  await mkdir(root);await mkdir(cache);await mkdir(outside)
  const runtime=await prepareRuntime({workspaceRoot:root,cacheRoot:cache}),scratch=runtime.toolEnvironment.TMPDIR
  await chmod(scratch,0o755);Object.assign(process.env,runtime.hostEnvironment({}))
  const hooks=await plugin(),run=(cwd=root)=>hooks['shell.env']({cwd},{env:{}})
  await fn({root,cache:join(cache,'managed-runtime'),outside,scratch,run})
 }finally{for(const key of ['TMPDIR','TMP','TEMP','NODE_COMPILE_CACHE','CHAOS_RUNTIME_WORKSPACE_ROOT','CHAOS_RUNTIME_CACHE_ROOT'])if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];await rm(base,{recursive:true,force:true})}
}
test('deleted leaf is restored with original mode and concurrent hooks succeed',()=>fixture(async({scratch,run})=>{
 await rm(scratch,{recursive:true});await Promise.all([run(),run()]);assert.deepEqual(await readdir(scratch),[]);assert.equal((await lstat(scratch)).mode&0o777,0o755)
 await writeFile(join(scratch,'keep.log'),'keep');await run();assert.equal(await readFile(join(scratch,'keep.log'),'utf8'),'keep')
}))
for(const kind of ['symlink','dangling-symlink','file'])test('rejects '+kind+' at scratch without replacing it',()=>fixture(async({scratch,outside,run})=>{
 await rm(scratch,{recursive:true})
 if(kind==='file')await writeFile(scratch,'keep')
 else await symlink(kind==='symlink'?outside:join(outside,'missing'),scratch)
 await assert.rejects(run);assert.deepEqual(await readdir(outside),[])
 if(kind==='file')assert.equal(await readFile(scratch,'utf8'),'keep');else assert((await lstat(scratch)).isSymbolicLink())
}))
test('does not recreate a missing test parent',()=>fixture(async({root,run})=>{
 await rm(join(root,'test'),{recursive:true});await assert.rejects(run);await assert.rejects(lstat(join(root,'test')),{code:'ENOENT'})
}))
test('rejects linked parent before creating the leaf',()=>fixture(async({root,outside,run})=>{
 await rm(join(root,'test'),{recursive:true});await symlink(outside,join(root,'test'));await assert.rejects(run);assert.deepEqual(await readdir(outside),[])
}))
test('outside cwd cannot trigger directory creation',()=>fixture(async({outside,scratch,run})=>{
 await rm(scratch,{recursive:true});await assert.rejects(()=>run(outside),/escaped/);await assert.rejects(lstat(scratch),{code:'ENOENT'})
}))
test('invalid compile cache cannot trigger directory creation',()=>fixture(async({cache,outside,scratch,run})=>{
 await rm(scratch,{recursive:true});await rm(join(cache,'node-compile-cache'),{recursive:true});await symlink(outside,join(cache,'node-compile-cache'));await assert.rejects(run);await assert.rejects(lstat(scratch),{code:'ENOENT'});assert.deepEqual(await readdir(outside),[])
}))
