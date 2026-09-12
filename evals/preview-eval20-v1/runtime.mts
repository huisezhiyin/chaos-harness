// The evaluator adds its contract, verifier and budget; daily Host setup belongs to the product.
import {main as previewMain} from '../../packages/preview/cli.mjs'
import {launchOpenCodeQwen} from '../../packages/adapters/opencode-codex-bridge/src/qwen.js'
type Options=Parameters<typeof launchOpenCodeQwen>[0]
type Host=NonNullable<Parameters<typeof launchOpenCodeQwen>[1]>
export function launchUsingPreview(options:Options,stateDirectory:string,host:Host={}) {
 return previewMain(['--root',options.root,'--state-dir',stateDirectory],{
  daily:{
   qwenProfileLoader:async()=>options.profile,
   opencodeCommand:options.opencodeCommand,
   qwenLauncher:async(resolved,managedHost)=>launchOpenCodeQwen({
    ...options,root:resolved.root,profile:resolved.profile,opencodeCommand:resolved.opencodeCommand,
   },managedHost),
  },
  host,
 })
}
