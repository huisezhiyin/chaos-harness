import { diagnoseTermination } from './termination-diagnostics.mjs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const sha = text => createHash('sha256').update(text).digest('hex')
async function optional(path) {
  try { return await readFile(path, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

// Reading a report never rewrites result.json, report.json or the audit.
export async function buildReport({ batchId, base, tasks }) {
  const legacyText = batchId === 'coding-batch-v1' ? await optional(join(base, 'review-2026-09-04.json')) : undefined
  const audit = legacyText ? JSON.parse(legacyText) : undefined
  if (audit && (audit.schema !== 1 || audit.kind !== 'post_run_review' || audit.original_results_preserved !== true)) throw new Error('Unsupported historical audit')
  /** @type {Array<{task:string, rawCategory:string, review:string, artifactAcceptance:string, artifactBasis?:string, seconds?:number, attempts?:number, actions?:number, assistance?:number, nativeFailedTools?:number, permissionRejections?:number, workspaceRejectedActions?:number, claim?:string, reviewedCategory?:string, annotation?:string, termination?:any}>} */
  const rows = []
  for (const task of tasks) {
    const text = await optional(join(base, task.id, 'result.json'))
    if (text === undefined) {
      const started = await optional(join(base, task.id, 'run.started.json'))
      rows.push({ task: task.id, rawCategory: started ? 'started_without_result' : 'not_run', review: 'unreviewed', artifactAcceptance: 'unknown' })
      continue
    }
    const raw = JSON.parse(text)
    if (raw.task !== task.id) throw new Error('Result task identity mismatch')
    /** @type {typeof rows[number]} */
    const row = {
      task: task.id, rawCategory: raw.category, review: 'unreviewed',
      artifactAcceptance: raw.independentPassed ? 'passed' : 'failed',
      artifactBasis: 'raw', seconds: raw.seconds, attempts: raw.attempts,
      actions: raw.actions, assistance: raw.assistance,
      nativeFailedTools: raw.nativeFailedTools, permissionRejections: raw.permissionRejections,
      workspaceRejectedActions: raw.workspaceRejectedActions,
    }
    const lifecycleText = await optional(join(base, task.id, 'lifecycle.jsonl'))
    if (lifecycleText !== undefined) {
      try {
        const events = lifecycleText.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
        row.termination = { ...diagnoseTermination(raw, events), originalResultSha256: sha(text), lifecycleSha256: sha(lifecycleText) }
      } catch { row.termination = { category: 'unknown', diagnosticError: 'invalid_lifecycle', originalResultSha256: sha(text), lifecycleSha256: sha(lifecycleText) } }
    }
    if (audit) {
      if (audit.original_result_sha256?.[task.id] !== sha(text)) {
        row.review = 'hash_mismatch'
      } else {
        const reviewed = audit.tasks?.[task.id]
        if (reviewed?.review === 'permission_interruption') {
          row.review = 'permission_interruption'
          row.artifactAcceptance = 'failed'
          row.artifactBasis = 'audit'
        } else if (reviewed?.review === 'grader_false_rejection; runtime timeout preserved' && reviewed.corrected_delegation_pass === true && reviewed.independent_behavior_pass === true && reviewed.tests_failed === 0 && reviewed.target_unchanged === true) {
          row.review = 'grader_false_rejection_timeout_preserved'
          row.artifactAcceptance = 'passed'
          row.artifactBasis = 'audit'
        }
      }
    }
    const annotationText = await optional(join(base, task.id, 'review.json'))
    if (annotationText) {
      const annotation = JSON.parse(annotationText)
      if (annotation.originalResultSha256 !== sha(text)) row.annotation = 'hash_mismatch'
      else {
        row.claim = annotation.claim
        row.assistance = annotation.assistance
        row.reviewedCategory = raw.category
        if (raw.category === 'independent_pass' && annotation.assistance > 0) row.reviewedCategory = 'assisted_pass'
        if (raw.category === 'failed_pending_review') {
          if (annotation.claim === 'claimed-complete') row.reviewedCategory = 'false_completion'
          if (annotation.claim === 'reported-incomplete') row.reviewedCategory = 'honest_failure'
        }
      }
    }
    rows.push(row)
  }
  return {
    batchId, rows, total: tasks.length,
    completed: rows.filter(r => !['not_run', 'started_without_result'].includes(r.rawCategory)).length,
    rawIndependentPass: rows.filter(r => r.rawCategory === 'independent_pass').length,
    artifactAccepted: rows.filter(r => r.artifactAcceptance === 'passed').length,
    auditHashMismatches: rows.filter(r => r.review === 'hash_mismatch').length,
  }
}

export function renderReport(report) {
  const cell = value => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')
  return [`# ${report.batchId}`, '自包含小项目；非真实开源 issue 分数。产物接受不改写端到端成功。',
    report.completed
      ? `原始独立通过 ${report.rawIndependentPass}/${report.completed}；产物接受（原验收 + 有效复核）${report.artifactAccepted}/${report.completed}；已完成 ${report.completed}/${report.total}。`
      : `尚无已完成结果（0/${report.total}）；未运行不计失败。`,
    ...(report.auditHashMismatches ? [`审计哈希不匹配 ${report.auditHashMismatches} 项，相关复核未应用。`] : []), '',
    '| 任务 | 原始结果 | 复核 | 产物接受 / 依据 | 声明复核结果 | 秒 | Attempts | 工具动作 | 人工介入 | 原生失败 / 权限拒绝 | 路径预检拒绝 |',
    '|---|---|---|---|---|---:|---:|---:|---:|---|---:|',
    ...report.rows.map(r => '| ' + [r.task, r.rawCategory, r.review, `${r.artifactAcceptance} / ${r.artifactBasis ?? '—'}`, r.annotation ?? r.reviewedCategory, r.seconds, r.attempts, r.actions, r.assistance, `${r.nativeFailedTools ?? '—'} / ${r.permissionRejections ?? '—'}`, r.workspaceRejectedActions].map(cell).join(' | ') + ' |'),
    ...(report.rows.some(r => r.termination) ? ['', '停止诊断（只读派生，不改写原始分类或产物接受；JSON 包含结果与 lifecycle 哈希绑定）：', '',
      '| 任务 | 停止诊断 | 控制器原因 | 收尾原因 | 提出 / Host 转发 / Host 观察 / 控制器拦截 |',
      '|---|---|---|---|---|',
      ...report.rows.filter(r => r.termination).map(r => {
        const d = r.termination, a = d.actionAccounting
        return '| ' + [r.task, d.category, d.failureCode, d.cleanupReason,
          a ? `${a.proposed} / ${a.hostForwarded} / ${a.hostObserved} / ${a.controllerBlocked}` : '— / — / — / —'].map(cell).join(' | ') + ' |'
      }), '旧日志缺少动作账本时显示 —；Host 转发不等于已执行，Host 观察包含失败返回。'] : []),
  ].join('\n') + '\n'
}
