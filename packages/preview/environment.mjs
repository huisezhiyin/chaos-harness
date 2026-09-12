import {mkdir,lstat,realpath} from 'node:fs/promises'
import {join,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {prepareScratch,scratchPath} from './workdir.mjs'
export const pluginPath=fileURLToPath(new URL('./shell-environment-plugin.mjs',import.meta.url))
export function contains(root,path) {const p=relative(root,path);return p===''||p!=='..'&&!p.startsWith('../')&&!isAbsolute(p)}
export async function physical(path) {
 const stat=await lstat(path)
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path)throw Error('Runtime path must be a physical directory')
 if(process.getuid&&stat.uid!==process.getuid())throw Error('Runtime directory owner differs')
}
export async function prepareRuntime({workspaceRoot,cacheRoot}) {
 if(!isAbsolute(workspaceRoot)||!isAbsolute(cacheRoot)||contains(workspaceRoot,cacheRoot)||contains(cacheRoot,workspaceRoot))throw Error('Runtime cache and workspace must be separate absolute paths')
 await physical(workspaceRoot)
 // Caller owns cacheRoot creation. Never traverse a link to create managed children.
 await physical(cacheRoot)
 const managed=join(cacheRoot,'managed-runtime')
 for(const path of [managed,join(managed,'host-tmp'),join(managed,'node-compile-cache')]) {
  try{await mkdir(path,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}
  await physical(path)
 }
 await prepareScratch(workspaceRoot)
 return {workspaceRoot,cacheRoot:managed,hostEnvironment:inherited=>({...inherited,
  TMPDIR:join(managed,'host-tmp'),TMP:join(managed,'host-tmp'),TEMP:join(managed,'host-tmp'),
  NODE_COMPILE_CACHE:join(managed,'node-compile-cache'),
  CHAOS_RUNTIME_WORKSPACE_ROOT:workspaceRoot,CHAOS_RUNTIME_CACHE_ROOT:managed,
 }),toolEnvironment:{TMPDIR:scratchPath(workspaceRoot),TMP:scratchPath(workspaceRoot),TEMP:scratchPath(workspaceRoot),NODE_COMPILE_CACHE:join(managed,'node-compile-cache')}}
}
