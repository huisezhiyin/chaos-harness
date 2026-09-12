import * as suite from './suite.mjs'
import {buildReport,renderReport} from './report.mjs'
import {join} from 'node:path'
const [command='report',...args]=process.argv.slice(2)
try {
  if(!['bootstrap','qualify','prepare','preflight','run-all','report'].includes(command)||args.some(a=>command!=='run-all'||a!=='--continue-unrun')||args.length>1)throw Error('Use bootstrap, qualify, prepare, preflight, run-all [--continue-unrun], report')
  if(command==='bootstrap')await (await import('./bootstrap.mjs')).bootstrap()
  if(command==='qualify')process.exitCode=await suite.qualify()?0:1
  if(command==='prepare'){await suite.prepare();console.log('All pending tasks admitted; no provider started')}
  if(command==='preflight'){
    await suite.assertBatchAdmission()
    const {pendingTasks}=await import('./run.mts')
    const pending=await pendingTasks(suite)
    console.log(JSON.stringify({pending,providerCalls:0}))
  }
  if(command==='run-all') {
    const {runBatch}=await import('./batch.mjs'),runner=await import('./run.mts')
    const results=await runBatch(suite,runner,{continueUnrun:args.includes('--continue-unrun')})
    process.exitCode=results.every(r=>r.category==='independent_pass'&&r.assistance===0)?0:1
  }
  if(['report','run-all'].includes(command)) {
    console.log(renderReport(await buildReport(suite)).replace('自包含小项目；非真实开源 issue 分数。产物接受不改写端到端成功。','两个新仓库的普通维护任务；不代表跨语言或大型工程可靠性。产物接受不改写端到端结果。'))
    const q=await suite.readJson(join(suite.base,'qualification.json')).catch(()=>null)
    console.log(JSON.stringify({qualification:q?.passed?'passed':'pending',admitted:await suite.exists(join(suite.base,'batch-admission.json')),claims:'unreviewed unless separately hash-bound reviewed',experience:'unavailable unless explicitly observed'}))
  }
}catch(error){console.error(String(error.message));process.exitCode=2}
