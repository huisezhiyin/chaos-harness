import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshot, digest } from './suite.mjs'
import { inspectReadiness } from './readiness.mjs'

test('public structural feedback stays read-only and ignores unchanged baseline files', async () => {
  const scratch=await mkdtemp(join(tmpdir(),'chaos-readiness-'))
  const root=join(scratch,'repo'),base=join(scratch,'state'),taskId='fake-readiness'
  try {
    await mkdir(join(root,'packages/csv-stringify/test'),{recursive:true})
    await mkdir(join(base,taskId),{recursive:true})
    await writeFile(join(root,'README.md'),'pre-existing user work')
    const baseline=await snapshot(root)
    await writeFile(join(base,taskId,'admission.json'),JSON.stringify({root,baseline}))
    const suite={base,taskId,snapshot}
    await writeFile(join(root,'repro.ts'),'public regression')
    const before=digest(await snapshot(root))
    assert.deepEqual((await inspectReadiness(suite,root,new AbortController().signal)).failed,['scope','regression-tests-missing'])
    assert.equal(digest(await snapshot(root)),before)
    await rename(join(root,'repro.ts'),join(root,'packages/csv-stringify/test/repro.ts'))
    const corrected=digest(await snapshot(root))
    assert.equal((await inspectReadiness(suite,root,new AbortController().signal)).passed,true)
    assert.equal(digest(await snapshot(root)),corrected)
    await assert.rejects(inspectReadiness(suite,root+'-other',new AbortController().signal),/target mismatch/)
    await assert.rejects(inspectReadiness(suite,root,AbortSignal.abort()))
  } finally {await rm(scratch,{recursive:true,force:true})}
})
