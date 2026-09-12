// Offline preparation from hash-checked original bootstrap baselines, never candidate edits.
import {readFile,mkdir,cp,readdir,lstat,writeFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tasks,base,rootFor,depsFor,exec,exists,writeOnce,snapshot,digest,dependenciesIdentity,mountDependencies,readJson,treeDigest} from './common.mjs'
export async function bootstrap() {
 const prior=join(base,'..','basic-coding-v1')
 await mkdir(base,{recursive:true,mode:0o700})
 const oldTools=join(prior,'tools'),newTools=join(base,'tools')
 if(!await exists(newTools))await cp(oldTools,newTools,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false})
 if(await treeDigest(oldTools)!==await treeDigest(newTools))throw Error('Tools differ from frozen original')
 for(const task of tasks) {
  const oldId=task.id.replace('basic-coding-v2-host-scratch','basic-coding-v1')
  const original=await readJson(join(prior,oldId,'bootstrap.json')),admission=await readJson(join(prior,oldId,'admission.json'))
  if(original.artifact!==admission.artifact||digest(original.baseline)!==admission.artifact||original.upstreamTree!==task.tree||original.upstreamHead!==task.head)throw Error('Original baseline identity differs')
  if(await exists(join(prior,oldId,'run.started.json')))throw Error('Only previously unrun tasks may be imported')
  const oldRoot=join(dirname(rootFor(task)),oldId)
  const {stdout}=await exec('git',['-C',oldRoot,'ls-tree','-rz',task.tree],{maxBuffer:8*1024*1024})
  const entries=stdout.split('\0').filter(Boolean).map(x=>{const [header,path]=x.split('\t');const [mode,type,sha]=header.split(' ');return {mode,type,sha,path}})
  if(entries.some(e=>e.type!=='blob'||!['100644','100755'].includes(e.mode))||entries.length!==Object.keys(original.baseline).length)throw Error('Unsupported original tree')
  const root=rootFor(task),deps=depsFor(task),record=join(base,task.id,'bootstrap.json')
  if(await exists(record)){console.log(task.id+' already frozen');continue}
  await mkdir(root,{recursive:true})
  // A prior archive-download failure may leave exact original files, without Git.
  // Validate every existing entry before completing this preparation; never overwrite.
  async function inspect(dir,relative='') {
   for(const name of await readdir(dir)) {
    const path=relative?relative+'/'+name:name,stat=await lstat(join(dir,name))
    if(stat.isDirectory())await inspect(join(dir,name),path)
    else if(!stat.isFile()||!(path in original.baseline)||(await readFile(join(dir,name))).toString('base64')!==original.baseline[path])throw Error('Partial target differs; preserve '+path)
   }
  }
  await inspect(root)
  for(const entry of entries) {
   const path=join(root,entry.path)
   await mkdir(dirname(path),{recursive:true})
   if(!await exists(path))await writeFile(path,Buffer.from(original.baseline[entry.path],'base64'),{flag:'wx',mode:parseInt(entry.mode,8)&0o777})
   if(((await lstat(path)).mode&0o777)!==(parseInt(entry.mode,8)&0o777))throw Error('Original mode differs')
  }
  await exec('git',['init','--quiet',root])
  let index=''
  for(const entry of entries) {
   const {stdout}=await exec('git',['-C',root,'hash-object','-w','--',entry.path])
   if(stdout.trim()!==entry.sha)throw Error('Original Git blob differs')
   index+=entry.mode+' '+entry.sha+'\t'+entry.path+'\n'
  }
  const indexing=exec('git',['-C',root,'update-index','--index-info']);indexing.child.stdin.end(index);await indexing
  const {stdout:tree}=await exec('git',['-C',root,'write-tree']);if(tree.trim()!==task.tree)throw Error('Original Git tree differs')
  const {stdout:head}=await exec('git',['-C',root,'-c','user.name=Chaos Evaluation','-c','user.email=eval@localhost','commit-tree',task.tree,'-m','Independent original baseline '+task.head])
  await exec('git',['-C',root,'update-ref','--no-deref','HEAD',head.trim()])
  await exec('git',['-C',root,'remote','add','origin',task.repository])
  if(await exists(deps))throw Error('Dependency destination already exists; preserve')
  await cp(join(prior,'dependencies',oldId),deps,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false})
  const dependencies=await dependenciesIdentity(task)
  if(JSON.stringify(dependencies)!==JSON.stringify(admission.dependencies))throw Error('Copied dependencies differ')
  await mountDependencies(task,root)
  const baseline=await snapshot(root);if(digest(baseline)!==admission.artifact)throw Error('Imported baseline differs')
  await writeOnce(record,{task:task.id,upstreamHead:task.head,upstreamTree:task.tree,head:head.trim(),artifact:digest(baseline),baseline,dependencies,source:'hash-checked original v1 bootstrap, previously unrun'})
  console.log(task.id+' original source and dependency copy verified; no provider started')
 }
}
