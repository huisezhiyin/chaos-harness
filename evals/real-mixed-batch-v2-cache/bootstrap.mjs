// Explicit preparation only. Never imported by run-all; never loads a provider.
import { readFile, mkdir, writeFile, symlink, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tasks, base, rootFor, depsFor, exec, exists, writeOnce, snapshot, digest, dependenciesIdentity, mountDependencies } from './common.mjs'

export async function bootstrap() {
  await mkdir(base,{recursive:true,mode:0o700})
  if(!await exists(join(base,'tools/node_modules/yarn/bin/yarn.js')))await exec('npm',['install','--prefix',join(base,'tools'),'--save-exact','yarn@1.22.22','--ignore-scripts','--no-audit','--no-fund'],{timeout:120000})
  for(const task of tasks) {
    const root=rootFor(task),deps=depsFor(task),record=join(base,task.id,'bootstrap.json')
    if(await exists(record)) {console.log(task.id+' source/dependencies already frozen');continue}
    if(await exists(root))throw Error('Target exists without bootstrap record; preserve and inspect: '+task.id)
    await mkdir(root,{recursive:true})
    const repo=task.repository.replace('https://github.com/','')
    const archive=join(base,task.id+'.tar.gz')
    await exec('/usr/bin/curl',['--fail','--location','--silent','--show-error','--max-time','120','https://codeload.github.com/'+repo+'/tar.gz/'+task.head,'-o',archive],{timeout:130000})
    await exec('/usr/bin/tar',['-xzf',archive,'--strip-components=1','-C',root])
    // Import the official tracked tree; no named branch or worktree is created.
    const {stdout:treeText}=await exec('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','30','https://api.github.com/repos/'+repo+'/git/trees/'+task.tree+'?recursive=1'],{maxBuffer:8*1024*1024})
    const tree=JSON.parse(treeText);if(tree.truncated)throw Error('Incomplete official tree')
    await exec('git',['init','--quiet',root])
    let index=''
    for(const entry of tree.tree) {
      if(entry.type==='tree')continue
      if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode))throw Error('Unsupported upstream tree entry')
      const {stdout}=await exec('git',['-C',root,'hash-object','-w','--',entry.path])
      if(stdout.trim()!==entry.sha)throw Error('Archive content differs from official Git object')
      index+=entry.mode+' '+entry.sha+'\t'+entry.path+'\n'
    }
    const indexing=exec('git',['-C',root,'update-index','--index-info']);indexing.child.stdin.end(index);await indexing
    const {stdout:treeId}=await exec('git',['-C',root,'write-tree']);if(treeId.trim()!==task.tree)throw Error('Official tree mismatch')
    const {stdout:head}=await exec('git',['-C',root,'-c','user.name=Chaos Evaluation','-c','user.email=eval@localhost','commit-tree',task.tree,'-m','Independent archive baseline '+task.head])
    await exec('git',['-C',root,'update-ref','--no-deref','HEAD',head.trim()])
    await exec('git',['-C',root,'remote','add','origin',task.repository])
    await mkdir(deps,{recursive:true})
    // Dependency scripts are disabled. Upstream source remains byte-identical.
    await cp(join(root,'package.json'),join(deps,'package.json'))
    if(task.lockfile)await cp(join(root,task.lockfile),join(deps,task.lockfile))
    const install=task.lockfile==='yarn.lock'
      ? [join(base,'tools/node_modules/.bin/yarn'),['install','--frozen-lockfile','--ignore-scripts','--non-interactive']]
      : ['npm',[task.lockfile?'ci':'install','--ignore-scripts','--no-audit','--no-fund']]
    try {const out=await exec(install[0],install[1],{cwd:deps,timeout:300000,maxBuffer:8*1024*1024,env:{...process.env,COREPACK_ENABLE_PROJECT_SPEC:'0',PUPPETEER_SKIP_DOWNLOAD:'true'}});await writeFile(join(deps,'install.log'),out.stdout+out.stderr,{mode:0o600})}
    catch(e){await writeFile(join(deps,'install.log'),String(e.stdout??'')+String(e.stderr??''),{mode:0o600});throw Error('Dependency install failed; preserve '+task.id)}
    await mountDependencies(task,root)
    const baseline=await snapshot(root)
    await writeOnce(record,{task:task.id,upstreamHead:task.head,upstreamTree:task.tree,head:head.trim(),artifact:digest(baseline),baseline,dependencies:await dependenciesIdentity(task)})
    console.log(task.id+' official tree imported; dependencies frozen; no provider started')
  }
}
