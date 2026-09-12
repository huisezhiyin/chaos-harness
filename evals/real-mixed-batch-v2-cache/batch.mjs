import {mkdir,rm,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'

// Pure orchestration with an injected runner; tests never import a provider.
export async function runBatch(suite,runner,{continueUnrun=false}={}) {
  const lock=join(suite.base,'execution.lock'),owner=randomUUID()
  try {await mkdir(lock)}catch(e){if(e.code==='EEXIST')throw Error('Batch is locked; inspect the active or interrupted process, do not auto-clear');throw e}
  try {
    await writeFile(join(lock,'owner.json'),JSON.stringify({owner,pid:process.pid}),{flag:'wx',mode:0o600})
    await suite.assertBatchAdmission()
    const pending=[],previousFailures=[]
    for(const t of suite.tasks) {
      const state=join(suite.base,t.id)
      if(await suite.exists(join(state,'run.started.json'))||await suite.exists(join(state,'result.json'))) {
        const r=await suite.readJson(join(state,'result.json')).catch(()=>null)
        if(!r||r.category!=='independent_pass'||r.assistance>0)previousFailures.push(t.id)
      } else pending.push(t.id)
    }
    if(previousFailures.length&&!continueUnrun)throw Error('Earlier task did not succeed; review it first. Explicit --continue-unrun skips consumed tasks without retrying them.')
    if(!pending.length)throw Error('Batch consumed; use report')
    // Preflight every remaining item before any credentials or Host are loaded.
    for(const id of pending)await runner.assertFresh(suite,id)
    const results=[]
    for(const id of pending) {
      const r=await runner.runTask(suite,id,'personal');results.push(r)
      if(r.category!=='independent_pass'||r.assistance>0)break
    }
    return results
  } finally {
    const held=JSON.parse(await readFile(join(lock,'owner.json'),'utf8').catch(()=>'null'))
    if(held?.owner===owner)await rm(lock,{recursive:true})
  }
}
