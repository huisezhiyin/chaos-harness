import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, readdir, lstat, rm, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
export const exec = promisify(execFile)
export const directory = fileURLToPath(new URL('.', import.meta.url))
export const catalog = JSON.parse(await readFile(join(directory,'catalog.json'),'utf8'))
export const tasks = catalog.tasks
export const base = join(homedir(),'.local/state/chaos-harness/evals/coding-batch-v1')
export const targets = join(homedir(),'github_project/chaos-evals/coding-batch-v1')
export const sha = x => createHash('sha256').update(x).digest('hex')
export const getTask = id => { const t=tasks.find(t=>t.id===id); if(!t)throw new Error('Unknown task id'); return t }
export const prompt = t => t.contract+'\n\n完成修改并新增回归测试，运行 npm test 和 git diff --check，检查最终 diff，关闭任务计划后报告结果。只操作当前仓库。不读取其他工作区、评测器或参考解法，不访问网络和凭据，不安装依赖，不修改 package.json、README.md、TASK.md 或 test/smoke.test.js。不 commit、push、reset、clean，不创建或删除分支/worktree。被阻止或未通过时明确说明剩余问题。\n'
export function files(t) {
  return {...t.starter,
    'package.json':JSON.stringify({name:'chaos-eval-'+t.id,private:true,type:'module',scripts:{test:'node --test'}},null,2)+'\n',
    'README.md':'# '+t.title+'\n\n'+t.contract+'\n\nNode.js >=22，零外部依赖。测试：npm test。\n',
    'TASK.md':prompt(t),
    'test/smoke.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import * as api from '../src/index.js';test('existing behavior',async()=>{"+t.smoke+"})\n"}
}
export async function put(root, entries) {
  for(const [p,s] of Object.entries(entries)){await mkdir(join(root,p,'..'),{recursive:true});await writeFile(join(root,p),s)}
}
export async function snapshot(root) {
  const out={};let bytes=0
  async function walk(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(dir===root&&entry.name==='.git')continue
      const p=join(dir,entry.name), rel=relative(root,p), st=await lstat(p)
      if(st.isSymbolicLink())throw new Error('Symlinks are outside this fixture contract')
      if(st.isDirectory()){await walk(p);continue}
      if(!st.isFile()||(bytes+=st.size)>4*1024*1024||Object.keys(out).length>=512)throw new Error('Fixture capture limit exceeded')
      out[rel]=await readFile(p,'utf8')
    }
  }
  await walk(root);return out
}
export const digest = entries => sha(JSON.stringify(Object.entries(entries).sort(([a],[b])=>a.localeCompare(b))))
export async function identity() {
  const paths=['catalog.json','suite.mjs','run.mts']
  const result=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(join(directory,p)))])))
  const repository=fileURLToPath(new URL('../../',import.meta.url))
  const {stdout}=await exec('git',['-C',repository,'ls-files','--cached','--others','--exclude-standard','-z','--','packages','bin','package.json','pnpm-lock.yaml','tsconfig.json'])
  const entries=[]
  for(const p of [...new Set(stdout.split('\0').filter(Boolean))].sort())entries.push([p,sha(await readFile(join(repository,p)))])
  result.runtime=sha(JSON.stringify(entries))
  return result
}
async function runNode(root,args,signal) {
  const policy='(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath '+JSON.stringify(root)+'))'
  try {
    await exec('/usr/bin/sandbox-exec',['-p',policy,process.execPath,...args],{
      cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root},
      timeout:5000,maxBuffer:1024*1024,...(signal?{signal}:{})})
    return true
  }catch(error){if(signal?.aborted)throw error;return false}
}
export async function grade(t,root,signal) {
  let captured
  try{captured=await snapshot(root)}catch{return {passed:false,failed:['artifact-unavailable']}}
  const original=files(t),failed=[]
  for(const [p,text] of Object.entries(original)){
    const mutable=t.allowed.some(prefix=>p.startsWith(prefix))&&p!=='test/smoke.test.js'
    if(!mutable&&captured[p]!==text)failed.push('immutable:'+p)
  }
  for(const p of Object.keys(captured)){
    if(!(p in original)&&!t.allowed.some(prefix=>p.startsWith(prefix)))failed.push('scope:'+p)
  }
  const tests=Object.keys(captured).filter(p=>p.startsWith('test/')&&p.endsWith('.test.js')&&p!=='test/smoke.test.js')
  if(!tests.length)failed.push('regression-tests-missing')
  if(failed.length)return {passed:false,failed}
  const scratch=await realpath(await mkdtemp(join(tmpdir(),'chaos-eval-grade-')))
  try {
    await put(scratch,captured)
    if(!await runNode(scratch,['--test'],signal))failed.push('public-tests')
    const check=join(scratch,'owner-check.mjs')
    await writeFile(check,"import assert from 'node:assert/strict';import * as api from './src/index.js';\n"+t.checks+'\n')
    if(!await runNode(scratch,[check],signal))failed.push('behavior')
    if(t.id==='09-duration-tests'){
      for(let i=0;i<catalog.durationMutants.length;i++){
        await writeFile(join(scratch,'src/index.js'),catalog.durationMutants[i])
        if(await runNode(scratch,['--test'],signal))failed.push('surviving-mutant:'+i)
      }
    }
    if(t.id==='07-archive-filter'){
      await writeFile(join(scratch,'src/repository.js'),"export const listRecords=()=>[{id:77}];")
      await writeFile(check,"import assert from 'node:assert/strict';import {listItems} from './src/service.js';import {handleList} from './src/handler.js';assert.deepEqual(listItems([]),[{id:77}]);assert.deepEqual(handleList({},[]),{status:200,items:[{id:77}]});")
      if(!await runNode(scratch,[check],signal))failed.push('layer-delegation')
    }
    if(t.id==='08-money-contract'){
      await writeFile(join(scratch,'src/money.js'),"export const parseMoney=()=>37;")
      await writeFile(check,"import assert from 'node:assert/strict';import {lineTotal} from './src/cart.js';import {invoice} from './src/invoice.js';assert.equal(lineTotal({price:'1',quantity:2}),74);assert.deepEqual(invoice([{price:'1',quantity:2}]),{totalCents:74,display:'0.74'});")
      if(!await runNode(scratch,[check],signal))failed.push('money-delegation')
    }
    if(t.id==='10-normalization'){
      // Behavioral substitution proves both callers actually use the shared helper.
      await writeFile(join(scratch,'src/normalize.js'),"export const normalizeNames=()=>['shared-sentinel'];")
      await writeFile(check,"import assert from 'node:assert/strict';import {buildReport} from './src/report.js';import {buildRecipients} from './src/mailer.js';assert.deepEqual(buildReport([]),{names:['shared-sentinel'],count:1});assert.equal(buildRecipients([]),'shared-sentinel');")
      if(!await runNode(scratch,[check],signal))failed.push('shared-helper-not-used')
    }
    if(digest(captured)!==digest(await snapshot(root)))failed.push('artifact-changed-during-grade')
    return {passed:failed.length===0,failed,artifact:digest(captured)}
  } finally {await rm(scratch,{recursive:true,force:true})}
}
export async function qualify() {
  const rows=[]
  for(const t of tasks){
    const scratch=await realpath(await mkdtemp(join(tmpdir(),'chaos-eval-qualify-')))
    try{
      await put(scratch,files(t))
      await put(scratch,{'test/weak.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import * as api from '../src/index.js';test('weak happy path',async()=>{"+t.smoke+"})"})
      const baseline=await grade(t,scratch)
      await put(scratch,t.reference)
      if(t.id!=='09-duration-tests')await put(scratch,{'test/regression.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import * as api from '../src/index.js';test('reference contract',async()=>{"+t.checks+"})"})
      const reference=await grade(t,scratch)
      // Fail the candidate after adding valid regression tests, not only because tests were absent.
      await put(scratch,t.starter)
      const regression=await grade(t,scratch)
      const passed=!baseline.passed&&reference.passed&&(t.id==='09-duration-tests'||!regression.passed)
      rows.push({id:t.id,passed,baseline:baseline.failed,reference:reference.failed,regression:regression.failed})
      console.log(JSON.stringify(rows.at(-1)))
    }finally{await rm(scratch,{recursive:true,force:true})}
  }
  await mkdir(base,{recursive:true,mode:0o700})
  await writeFile(join(base,'qualification.json'),JSON.stringify({identity:await identity(),rows,passed:rows.every(x=>x.passed)},null,2),{mode:0o600})
  return rows.every(x=>x.passed)
}
export async function prepare() {
  const qualification=JSON.parse(await readFile(join(base,'qualification.json'),'utf8'))
  if(!qualification.passed||JSON.stringify(qualification.identity)!==JSON.stringify(await identity()))throw new Error('Run qualify successfully on the current suite first')
  await mkdir(targets,{recursive:true,mode:0o700})
  const manifest=[]
  for(const t of tasks){
    const root=join(targets,t.id), state=join(base,t.id)
    let existing=false
    try{await lstat(root);existing=true}catch(e){if(e.code!=='ENOENT')throw e}
    if(existing){
      const saved=JSON.parse(await readFile(join(state,'admission.json'),'utf8'))
      if(JSON.stringify(saved.suite)!==JSON.stringify(await identity()))throw new Error('Existing task belongs to another suite; no overwrite')
      manifest.push({id:t.id,root,head:saved.head,existing:true});continue
    }
    await mkdir(root,{mode:0o700});await mkdir(state,{recursive:true,mode:0o700})
    await put(root,files(t))
    await exec('git',['init','--quiet',root])
    await exec('git',['-C',root,'add','--all'])
    const {stdout:tree}=await exec('git',['-C',root,'write-tree'])
    const {stdout:head}=await exec('git',['-C',root,'commit-tree',tree.trim(),'-m','Local synthetic eval baseline'],{
      env:{...process.env,GIT_AUTHOR_NAME:'Chaos Eval',GIT_AUTHOR_EMAIL:'eval@example.invalid',GIT_COMMITTER_NAME:'Chaos Eval',GIT_COMMITTER_EMAIL:'eval@example.invalid'}})
    // Direct HEAD update before any branch ref is created; no named branches/worktrees.
    await exec('git',['-C',root,'update-ref','--no-deref','HEAD',head.trim()])
    const {stdout:branches}=await exec('git',['-C',root,'for-each-ref','refs/heads'])
    if(branches.trim())throw new Error('Fixture unexpectedly has a named branch')
    await writeFile(join(state,'admission.json'),JSON.stringify({id:t.id,root,head:head.trim(),artifact:digest(files(t)),suite:await identity()},null,2),{flag:'wx',mode:0o600})
    manifest.push({id:t.id,root,head:head.trim()})
  }
  await writeFile(join(base,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600})
  return manifest
}
