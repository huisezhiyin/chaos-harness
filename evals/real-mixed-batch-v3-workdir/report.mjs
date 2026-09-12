import { buildReport as buildPrevious, renderReport as renderPrevious } from '../report.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { diagnoseTermination } from './native.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex')
export async function buildReport(suite) {
  const report=await buildPrevious(suite)
  for(const row of report.rows) {
    if(!row.termination?.lifecycleSha256)continue
    const rawText=await readFile(join(suite.base,row.task,'result.json'),'utf8')
    const text=await readFile(join(suite.base,row.task,'lifecycle.jsonl'),'utf8')
    if(sha(rawText)!==row.termination.originalResultSha256||sha(text)!==row.termination.lifecycleSha256)throw Error('Evidence changed while reporting')
    const raw=JSON.parse(rawText),events=text.split('\n').filter(Boolean).map(JSON.parse)
    const diagnosed=diagnoseTermination(raw,events)
    row.termination={...row.termination,...diagnosed}
    if((diagnosed.verificationFailureCode||raw.postGradeFailureCode)&&!raw.independentPassed&&row.artifactBasis==='raw') {
      row.artifactAcceptance='unknown';row.artifactBasis='verifier_unavailable'
    }
  }
  report.artifactAccepted=report.rows.filter(r=>r.artifactAcceptance==='passed').length
  return report
}
export function renderReport(report) {
  return renderPrevious({...report,rows:report.rows.map(r=>({...r,termination:r.termination?{...r.termination,failureCode:r.termination.verificationFailureCode??r.termination.failureCode}:undefined}))})
    .replace('控制器原因','控制器 / 验收原因')
}
