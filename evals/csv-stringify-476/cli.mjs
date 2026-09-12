import * as suite from './suite.mjs'
import { buildReport, renderReport } from '../report.mjs'
const args = process.argv.slice(2), command = args[0] ?? 'report'
const show = async () => console.log(renderReport(await buildReport(suite)).replace(
  '自包含小项目；非真实开源 issue 分数。产物接受不改写端到端成功。',
  '单个真实开源仓库 Issue 任务；不是汇总 benchmark 分数。产物接受不改写端到端成功。'))
try {
  if (args.length > 1 || !['qualify', 'prepare', 'report', 'run'].includes(command)) throw new Error('Use qualify, prepare, report or run')
  if (command === 'qualify') process.exitCode = await suite.qualify() ? 0 : 1
  if (command === 'prepare') { await suite.prepare(); console.log('Prepared '+suite.batchId+'; no model started') }
  if (command === 'report') await show()
  if (command === 'run') {
    // Reuse the frozen v3 execution policy, immutable admission, native accounting
    // and stream capture; this real task supplies its own target and verifier.
    const { runTask } = await import('../coding-batch-v3/run.mts')
    const result = await runTask(suite, suite.taskId, 'company')
    await show()
    process.exitCode = result.category === 'independent_pass' ? 0 : 1
  }
} catch { console.error('Real task preflight/operation failed; preserve the target and evidence. No automatic retry.'); process.exitCode = 2 }
