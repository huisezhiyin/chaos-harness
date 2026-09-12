import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
export async function inspectReadiness(suite,id,root,signal) {
  signal.throwIfAborted()
  const a=JSON.parse(await readFile(join(suite.base,id,'admission.json'),'utf8'))
  if(a.root!==root)throw Error('Readiness target mismatch')
  const task=suite.getTask(id),current=await suite.snapshot(root)
  const {failed}=suite.boundary(task,a.baseline,current)
  signal.throwIfAborted()
  return {passed:!failed.length,failed,guidance:'Keep changes within the declared source scope, preserve existing tests, add regressions in a new test file, run all required package checks and git diff --check, inspect the final diff, and close your plan before proposing completion.'}
}
