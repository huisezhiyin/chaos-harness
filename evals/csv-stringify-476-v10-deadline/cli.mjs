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
    console.log(`路径纠错 ${r.pathCorrections ?? 0}/1；预检原因 ${(r.workspaceBoundaryRejections ?? []).map(x=>x.reason+'/'+x.detail).join(', ') || '—'}。`)
    console.log(`早期交付检查 ${(r.deliveryReadinessChecks ?? []).length}/1；缺口 ${(r.deliveryReadinessFindings ?? []).flat().join(', ') || '—'}。`)
    console.log(`退出补收认证错误 ${(r.hostTerminalErrors ?? []).length}；分类 ${(r.hostTerminalErrors ?? []).join(', ') || '—'}；不计作模型已消费工具观察。`)
    if(r.timing)console.log(`模型调用 ${r.timing.modelRequests}；ModelPort 累计 ${r.timing.modelPortTotalMs}ms；最大单次 ${r.timing.maxModelRequestMs}ms；最大首事件等待 ${r.timing.maxFirstEventMs}ms；Host 往返累计 ${r.timing.hostRoundTripTotalMs}ms。`)
    if(r.executionDeadline)console.log(`时间收尾窗口 ${r.executionDeadline.closureWindowMs/1000} 秒；硬截止 ${new Date(r.executionDeadline.deadlineAtMs).toISOString()}；截止不因恢复延长。`)
    console.log(`Length 恢复 ${r.modelLengthRecoveries ?? 0}/1；最终停止原因 ${r.lastStopReason ?? '—'}；模型终止 ${r.modelTermination?.finishReason ?? '—'}。`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
try {
  if (args.length > 1 || !['qualify', 'prepare', 'report', 'run'].includes(command)) throw new Error('Use qualify, prepare, report or run')
  if (command === 'qualify') process.exitCode = await suite.qualify() ? 0 : 1
  if (command === 'prepare') { await suite.prepare(); console.log('Prepared '+suite.batchId+'; no model started') }
  if (command === 'report') await show()
  if (command === 'run') {
    // Independent direct personal API evaluation; historical runs remain frozen.
    const { runTask } = await import('./run.mts')
    const result = await runTask(suite, suite.taskId, 'personal')
    await show()
    process.exitCode = result.category === 'independent_pass' ? 0 : 1
  }
} catch { console.error('Real task preflight/operation failed; preserve the target and evidence. No automatic retry.'); process.exitCode = 2 }
