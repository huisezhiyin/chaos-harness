import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Structural public requirements only. Never run candidate code or accept completion here.
export async function inspectReadiness(suite, root, signal) {
  signal.throwIfAborted()
  const admission=JSON.parse(await readFile(join(suite.base,suite.taskId,'admission.json'),'utf8'))
  if(admission.root!==root)throw new Error('Readiness target mismatch')
  const current=await suite.snapshot(root), baseline=admission.baseline
  signal.throwIfAborted()
  const changed=[...new Set([...Object.keys(baseline),...Object.keys(current)])].filter(path=>baseline[path]!==current[path])
  const failed=[]
  if(changed.some(path=>!path.startsWith('packages/csv-stringify/')))failed.push('scope')
  if(!changed.some(path=>path.startsWith('packages/csv-stringify/test/')))failed.push('regression-tests-missing')
  const guidance=[
    ...(failed.includes('scope')?['Keep all task changes within packages/csv-stringify/. Inspect git status and correct only this Unit’s own out-of-scope changes; preserve pre-existing user work.']:[]),
    ...(failed.includes('regression-tests-missing')?['Add the required regressions under packages/csv-stringify/test/. A standalone reproduction outside this package does not satisfy the task.']:[]),
    'Rebuild declarations, run package tests and git diff --check, inspect the final diff, and close the task plan before proposing completion.',
  ].join(' ')
  return {passed:failed.length===0,failed,guidance}
}
