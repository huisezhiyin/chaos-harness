import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {assertIsolatedOpenCodeConfig} from '../../packages/adapters/opencode-codex-bridge/src/opencode-host-profile.js'
import {pluginPath} from './environment.mjs'
const exec=promisify(execFile)
export function appendRuntimePlugin(env:NodeJS.ProcessEnv,observationPlugin:string) {
 const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT??'null')
 if(!config||JSON.stringify(config.plugin)!==JSON.stringify([observationPlugin]))throw Error('Unexpected original Host plugin list')
 return {...env,OPENCODE_CONFIG_CONTENT:JSON.stringify({...config,plugin:[observationPlugin,pluginPath]})}
}
export function assertRuntimeProfile(config:any,observationPlugin:string) {
 const names=[observationPlugin,pluginPath],same=(value:any,name:string)=>value===name||value==='file://'+name
 if(!Array.isArray(config?.plugin)||config.plugin.length!==2||!config.plugin.every((p:any,i:number)=>same(p,names[i]!))||!Array.isArray(config.plugin_origins)||config.plugin_origins.length!==2||!config.plugin_origins.every((p:any,i:number)=>same(p?.spec,names[i]!)))throw Error('Unexpected managed Host plugin list')
 assertIsolatedOpenCodeConfig({...config,plugin:[config.plugin[0]],plugin_origins:[config.plugin_origins[0]]},observationPlugin)
}
export async function verifyManagedProfile(input:{command:string;root:string;env:NodeJS.ProcessEnv;observationPlugin:string},runtime:any) {
 Object.assign(input.env,runtime.hostEnvironment(appendRuntimePlugin(input.env,input.observationPlugin)))
 try {
  const {stdout}=await exec(input.command,['debug','config'],{cwd:input.root,env:input.env,timeout:30000,maxBuffer:2*1024*1024})
  assertRuntimeProfile(JSON.parse(stdout),input.observationPlugin)
 }catch {throw Error('Managed Host profile isolation failed; provider run not started')}
}
