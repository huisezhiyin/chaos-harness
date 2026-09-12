// Explicit model-free integration check. Never modifies historical targets or deps.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink, readdir, realpath, rm } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { homedir } from 'node:os'
import { commandEnvironment } from './environment.mjs'
import { exec, treeDigest, sha, assertDependencyTree } from './common.mjs'
import { inspectCopy } from './probe.mjs'

export async function checkEnvironment() {
  const state=join(homedir(),'.local/state/chaos-harness/evals'),previous=join(state,'real-mixed-batch-v1')
  const id='real-mixed-v1-02-async-mutex-90',before=JSON.parse(await readFile(join(previous,id,'bootstrap.json'),'utf8'))
  const output=join(state,'real-mixed-batch-v2-cache','checks');await mkdir(output,{recursive:true,mode:0o700})
  const scratch=await realpath(await mkdtemp(join(output,'cache-integration-'))),root=join(scratch,'repo'),dep=join(scratch,'dependencies/node_modules')
  const task={kind:'semaphore'},sourceDeps=join(previous,'dependencies',id,'node_modules'),checks=[]
  const originalDeps=await treeDigest(sourceDeps)
  let completed=false
  const originalRecord=sha(await readFile(join(previous,id,'result.json')))
  const strictDeps=()=>assertDependencyTree(dep,before.dependencies.tree)
  try {
    await mkdir(root);await mkdir(dirname(dep))
    await cp(sourceDeps,dep,{recursive:true,verbatimSymlinks:true,filter:path=>{
      const key=relative(sourceDeps,path);return key!=='.cache/nyc'&&!key.startsWith('.cache/nyc/')
    }})
    // The exclusion is evidence-specific, and the entire resulting tree must match.
    await strictDeps()
    for(const [path,encoded] of Object.entries(before.baseline)) {await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),Buffer.from(encoded,'base64'))}
    await symlink(dep,join(root,'node_modules'))
    const toolsRoot=join(previous,'tools'),liveCache=join(scratch,'live-cache'),qualifierCache=join(scratch,'qualifier-cache')
    const run=async(label,cmd,args,cacheRoot,sandbox=false)=>{
      const env=commandEnvironment({cacheRoot,toolsRoot,workspaceRoot:root,inherited:{TMPDIR:scratch,CI:'true'}})
      const command=sandbox?'/usr/bin/sandbox-exec':cmd
      const argv=sandbox?['-p',`(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(scratch)}))`,cmd,...args]:args
      let stdout,stderr
      try { ({stdout,stderr}=await exec(command,argv,{cwd:root,env,timeout:60000,maxBuffer:8*1024*1024})) }
      catch(error) { await writeFile(join(scratch,label+'-failure.json'),JSON.stringify({label,exitCode:error.code,stdout:error.stdout,stderr:error.stderr}),{mode:0o600});throw error }
      checks.push({label,passed:true,exitCode:0,output:stdout+stderr})
    }
    const result=await inspectCopy(task,{scratch,copy:root},{signal:AbortSignal.timeout(120000),fixture:'fixed',exerciseLive:true,toolsRoot})
    checks.push(...result.checks)
    assert(result.passed,'Production qualification must pass live tests, cache checks and independent verification')
    await strictDeps();checks.push({label:'live-and-qualifier-cache-generated-dependencies-unchanged',passed:true})
    // A live-looking pipeline is not evidence of a test exit: explicit pipefail fails.
    await assert.rejects(()=>run('failing-pipeline','/bin/bash',['-o','pipefail','-c','exit 7 | cat'],liveCache),e=>e.code===7)
    checks.push({label:'pipeline-failure-propagates',passed:true})
    await writeFile(join(dep,'tslib/tslib.js'),'tampered copied dependency')
    await assert.rejects(strictDeps,e=>e.code==='dependencies_changed')
    checks.push({label:'actual-package-mutation-rejected',passed:true})
    assert.equal(await treeDigest(sourceDeps),originalDeps)
    assert.equal(sha(await readFile(join(previous,id,'result.json'))),originalRecord)
    const report={passed:true,providerCalls:0,historicalSourceAndDependenciesUnchanged:true,checks}
    const path=join(output,'environment-check-'+Date.now()+'.json');await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
    completed=true;console.log(JSON.stringify({passed:true,checks:checks.map(c=>c.label??c.id),evidence:path}));return report
  } finally { if(completed)await rm(scratch,{recursive:true,force:true}) }
}
await checkEnvironment()
