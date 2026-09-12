import {buildReport as previous,renderReport} from '../real-mixed-batch-v3-workdir/report.mjs'
import {diagnoseTermination} from './native.mjs'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
export {renderReport}
export async function buildReport(suite) {
  const report = await previous(suite)
  for (const row of report.rows) {
    if (!row.termination?.lifecycleSha256) continue
    const result = await readFile(join(suite.base,row.task,'result.json'),'utf8')
    const journal = await readFile(join(suite.base,row.task,'lifecycle.jsonl'),'utf8')
    if (suite.sha(result) !== row.termination.originalResultSha256 || suite.sha(journal) !== row.termination.lifecycleSha256) throw Error('Evidence changed while reporting')
    row.termination = {...row.termination,...diagnoseTermination(JSON.parse(result),journal.trim().split('\n').map(JSON.parse))}
  }
  return report
}
