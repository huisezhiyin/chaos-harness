import {dirname,join} from 'node:path'
import {mkdtemp} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {main as dailyMain,prepareChaosDailyLaunch} from '../adapters/opencode-codex-bridge/src/daily-cli.js'
import {launchOpenCodeQwen} from '../adapters/opencode-codex-bridge/src/qwen.js'
import {prepareRuntime} from './environment.mjs'
import {verifyManagedProfile} from './host-profile.mjs'

type DailyDependencies=NonNullable<Parameters<typeof dailyMain>[1]>
type HostDependencies=NonNullable<Parameters<typeof launchOpenCodeQwen>[1]>
export async function main(argv:readonly string[]=process.argv.slice(2),dependencies:{daily?:DailyDependencies;host?:HostDependencies;platform?:string}={}) {
 const supplied=dependencies.daily??{},stderr=supplied.stderr??((s:string)=>process.stderr.write(s))
 if(argv.includes('--help')||argv.includes('-h')){
  (supplied.stdout??((s:string)=>process.stdout.write(s)))(`Chaos Preview (v0.1 candidate)
Usage: node bin/chaos-preview.mjs [--root <git-repository>]
       [--env-file <private-config>] [--state-dir <outside-workspace-directory>]
       [--model <model>] [--check-profile]
       [--profiles <json-file> --profile <chat-api-profile>]
macOS / OpenCode chat-api only. Runtime isolation is enabled.
Check configuration with --check-profile; model calls begin only after submitting a task.
See PREVIEW.md for installation, supported versions and acceptance limits.
`)
  return 0
 }
 if((dependencies.platform??process.platform)!=='darwin'){
  stderr('Chaos preview currently supports macOS only. Other platforms are not qualified.\n');return 2
 }
 let stateDirectory:string|undefined
 return dailyMain(argv,{
  ...supplied,
  prepare:async args=>{
   const prepared=await (supplied.prepare??prepareChaosDailyLaunch)(args)
   stateDirectory=dirname(prepared.recordPath)
   return prepared
  },
  advancedLauncher:async()=>{stderr('Chaos preview currently supports the OpenCode chat-api path only.\n');return 2},
  qwenLauncher:async options=>{
   if(!stateDirectory)throw Error('Preview state was not prepared')
   const cacheRoot=await mkdtemp(join(stateDirectory,'runtime-'))
   const runtime=await prepareRuntime({workspaceRoot:options.root,cacheRoot})
   // Environment verification also configures the env object used by the real TUI.
   return (supplied.qwenLauncher??launchOpenCodeQwen)(options,{
    ...dependencies.host,
    verifyHostProfile:input=>verifyManagedProfile(input,runtime),
   })
  },
 })
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().then(code=>{process.exitCode=code},()=>{process.stderr.write('Chaos preview startup failed. Check the supported Host version and private state directory.\n');process.exitCode=1})
}
