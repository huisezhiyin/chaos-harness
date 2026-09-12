import {realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {contains,physical} from './environment.mjs'
export default async function ManagedRuntimeEnvironment() {
 const root=process.env.CHAOS_RUNTIME_WORKSPACE_ROOT,cache=process.env.CHAOS_RUNTIME_CACHE_ROOT
 if(!root||!cache||contains(root,cache)||contains(cache,root))throw Error('Managed runtime environment missing or overlapping')
 await physical(root);await physical(cache)
 const scratch=join(root,'test/.chaos-tmp'),compile=join(cache,'node-compile-cache')
 return {'shell.env':async(input,output)=>{
  await physical(root);await physical(cache);await physical(join(root,'test'));await physical(scratch);await physical(compile)
  if(!contains(root,await realpath(input.cwd)))throw Error('Shell cwd escaped workspace')
  Object.assign(output.env,{TMPDIR:scratch,TMP:scratch,TEMP:scratch,NODE_COMPILE_CACHE:compile})
 }}
}
