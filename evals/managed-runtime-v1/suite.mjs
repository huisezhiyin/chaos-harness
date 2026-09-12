import {scratchFindings,workspaceGuidance} from './workdir.mjs'
import {workspaceGuidance as priorGuidance} from '../basic-coding-v2-host-scratch/workdir.mjs'
export function withManagedRuntime(suite) {
 return {...suite,
  prompt:task=>suite.prompt(task).replace(priorGuidance(suite.rootFor(task)),workspaceGuidance(suite.rootFor(task)))+' Host temporary files and Node compilation caches are managed by the runner outside the source artifact. Do not inspect or clean those runtime directories. Keep only your intentional deliverables and remove your own temporary reproductions/logs.',
  grade:async(task,root,signal)=>{
   const before=await scratchFindings(root)
   if(before.length)return {passed:false,failed:before}
   const result=await suite.grade(task,root,signal),after=await scratchFindings(root)
   return after.length?{...result,passed:false,failed:[...result.failed,...after]}:result
  }
 }
}
