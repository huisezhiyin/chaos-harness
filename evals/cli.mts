import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSuite } from './coding-batch-v2/suite.mjs'
import { createSuite as createV3Suite } from './coding-batch-v3/suite.mjs'
import { buildReport, renderReport } from './report.mjs'
import { isInterruption } from './coding-batch-v2/native.mjs'

export function parseArgs(args:string[]) {
  const positional:string[]=[]
  let batchId:string|undefined, source='company', json=false
  const seen=new Set<string>()
  for(let i=0;i<args.length;i++) {
    const arg=args[i]!
    if(arg.startsWith('--')) {
      if(seen.has(arg))throw new Error('Duplicate option: '+arg)
      seen.add(arg)
      if(arg==='--json'){json=true;continue}
      if(!['--batch','--source'].includes(arg))throw new Error('Unknown option: '+arg)
      const value=args[++i]
      if(!value||value.startsWith('--'))throw new Error('Missing value: '+arg)
      if(arg==='--batch')batchId=value
      else source=value
    } else positional.push(arg)
  }
  const [command='report',id,review]=positional
  if(!['list','report','qualify','prepare','run','run-all','grade','review'].includes(command))throw new Error('Unknown eval command')
  const count=command==='review'?3:['run','grade'].includes(command)?2:1
  if(positional.length>count || (count>1&&!id) || (command==='review'&&!review))throw new Error('Unexpected or missing positional arguments')
  if(!['company','personal','dogfood'].includes(source))throw new Error('Choose company, personal or dogfood')
  if(seen.has('--source')&&!['run','run-all'].includes(command))throw new Error('--source is only for run/run-all')
  if(json&&command!=='report')throw new Error('--json is only for report')
  const selected=batchId??'coding-batch-v1'
  if(selected!=='coding-batch-v1'&&!/^coding-batch-v[23](?:-[a-z0-9][a-z0-9-]{0,47})?$/.test(selected))throw new Error('Invalid batch ID')
  if(!selected.startsWith('coding-batch-v3')&&!['list','report','grade'].includes(command))throw new Error('v1 is completed and frozen; v2 is frozen. Use report, or explicitly qualify/prepare --batch coding-batch-v3-<name>. No provider started.')
  return {command,id,review,batchId:selected,source,json}
}

export async function main(args:string[]) {
  const options=parseArgs(args)
  const suite=options.batchId==='coding-batch-v1'
    ? {...await import('./coding-batch-v1/suite.mjs'),batchId:options.batchId}
    : options.batchId.startsWith('coding-batch-v3') ? createV3Suite(options.batchId) : createSuite(options.batchId)
  const showReport=async()=>{
    const report=await buildReport(suite)
    console.log(options.json?JSON.stringify(report,null,2):renderReport(report))
    return report
  }
  switch(options.command) {
    case 'list': console.log(suite.tasks.map((t:{id:string;category:string;title:string})=>`${t.id} | ${t.category} | ${t.title}`).join('\n'));return 0
    case 'report': await showReport();return 0
    case 'qualify': return await suite.qualify()?0:1
    case 'prepare': console.log(JSON.stringify(await suite.prepare(),null,2));return 0
    case 'grade': console.log(JSON.stringify(await suite.grade(suite.getTask(options.id!),join(suite.targets,options.id!),AbortSignal.timeout(30_000)),null,2));return 0
    case 'review': {
      if(!['claimed-complete','reported-incomplete','assisted'].includes(options.review!))throw new Error('Invalid review action')
      const task=suite.getTask(options.id!),state=join(suite.base,task.id)
      const raw=await readFile(join(state,'result.json'),'utf8')
      const hash=createHash('sha256').update(raw).digest('hex')
      let annotation={originalResultSha256:hash,claim:'unreviewed',assistance:0}
      try { annotation=JSON.parse(await readFile(join(state,'review.json'),'utf8')) }
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      if(annotation.originalResultSha256!==hash)throw new Error('Review/result hash mismatch; preserve both')
      if(options.review==='assisted')annotation.assistance++
      else annotation.claim=options.review!
      await writeFile(join(state,'review.json'),JSON.stringify(annotation,null,2),{mode:0o600})
      await showReport();return 0
    }
    case 'run':
    case 'run-all': {
      // Only explicit v2 run commands reach the module containing provider loaders.
      const {runTask,pendingTasks}=await import('./coding-batch-v3/run.mjs')
      const runSuite=createV3Suite(options.batchId)
      const ids=options.command==='run'?[options.id!]:await pendingTasks(runSuite)
      let exitCode=0
      for(const id of ids) {
        const result=await runTask(runSuite,id,options.source)
        if(isInterruption(result.category)){exitCode=2;break}
        if(result.category!=='independent_pass')exitCode=1
      }
      await showReport();return exitCode
    }
  }
  throw new Error('Unsupported eval command')
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try { process.exitCode=await main(process.argv.slice(2)) }
  catch(error){console.error(error instanceof Error?error.message:'Eval command failed');process.exitCode=2}
}
