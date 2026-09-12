import * as suite from './suite.mjs'
import { buildReport, renderReport } from '../report.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const args = process.argv.slice(2), command = args[0] ?? 'report'
const show = async () => {
  console.log(renderReport(await buildReport(suite)).replace(
  '自包含小项目；非真实开源 issue 分数。产物接受不改写端到端成功。',
  '单个真实开源仓库 Issue 任务；不是汇总 benchmark 分数。产物接受不改写端到端成功。'))
  try {
    const r = JSON.parse(await readFile(join(suite.base, suite.taskId, 'result.json'), 'utf8'))
    console.log(`上下文继续 ${r.contextContinuations ?? 0}/1；Unit turns ${r.unitBudget?.turns ?? '—'}/${r.unitBudget?.maxTurns ?? '—'}；Unit charged actions ${r.unitBudget?.actions ?? '—'}/${r.unitBudget?.maxActions ?? '—'}。`)
    console.log(`Length 恢复 ${r.modelLengthRecoveries ?? 0}/1；最终停止原因 ${r.lastStopReason ?? '—'}；模型终止 ${r.modelTermination?.finishReason ?? '—'}。`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
try {
  if (args.length > 1 || !['qualify', 'prepare', 'report', 'run'].includes(command)) throw new Error('Use qualify, prepare, report or run')
  if (command === 'qualify') process.exitCode = await suite.qualify() ? 0 : 1
  if (command === 'prepare') { await suite.prepare(); console.log('Prepared '+suite.batchId+'; no model started') }
  if (command === 'report') await show()
  if (command === 'run') {
    // v4 opts into bounded context continuation and explicit Unit total budget.
    const { runTask } = await import('./run.mts')
    const result = await runTask(suite, suite.taskId, 'company')
    await show()
    process.exitCode = result.category === 'independent_pass' ? 0 : 1
  }
} catch { console.error('Real task preflight/operation failed; preserve the target and evidence. No automatic retry.'); process.exitCode = 2 }
