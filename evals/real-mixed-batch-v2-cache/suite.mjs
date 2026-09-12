import { environmentError } from './environment.mjs'
import { readFile, writeFile, lstat, readlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as common from './common.mjs'
import { inspect } from './probe.mjs'
import { mutants } from './fixtures.mjs'
export * from './common.mjs'
const {tasks,base,rootFor,depsFor,readJson,writeOnce,exists,digest,snapshot,identity,dependenciesIdentity,allowed,exec,sha}=common
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)

export async function assertMount(task) {
  const root=rootFor(task),dep=join(depsFor(task),'node_modules'),mount=join(root,'node_modules')
  if(task.kind!=='fjs') {if(!(await lstat(mount)).isSymbolicLink()||await readlink(mount)!==dep)throw environmentError('dependency_mount_changed');return}
  const names=await readdir(dep),actual=await readdir(mount)
  if(!same(names.sort(),actual.sort()))throw environmentError('dependency_mount_changed')
  for(const name of names)if(!(await lstat(join(mount,name))).isSymbolicLink()||await readlink(join(mount,name))!==(name==='fast-json-stringify'?root:join(dep,name)))throw environmentError('dependency_mount_changed')
}
export async function checkDependencies(id,_root,admission) {
  const task=common.getTask(id);await assertMount(task)
  if(sha(await readFile(join(depsFor(task),task.lockfile??'package-lock.json')))!==admission.dependencies.lock)throw environmentError('dependencies_changed')
  await common.assertDependencyTree(join(depsFor(task),'node_modules'),admission.dependencies.tree)
  const {stdout}=await exec('git',['-C',rootFor(task),'for-each-ref','--format=%(refname)','refs/heads'])
  if(stdout.trim())throw Error('Target branch boundary changed')
}
async function baseline(task) {
  const b=await readJson(join(base,task.id,'bootstrap.json'))
  const {stdout}=await exec('git',['-C',rootFor(task),'rev-parse','HEAD','HEAD^{tree}'])
  if(stdout.trim()!==b.head+'\n'+task.tree||b.upstreamTree!==task.tree||digest(await snapshot(rootFor(task)))!==b.artifact)throw Error('Prepared source baseline changed')
  await checkDependencies(task.id,rootFor(task),b);return b
}
export function boundary(task,initial,current) {
  const changed=[...new Set([...Object.keys(initial),...Object.keys(current)])].filter(p=>initial[p]!==current[p])
  const failed=[]
  if(!changed.length)failed.push('no-mutation')
  if(!changed.some(p=>p.startsWith('test/')&&!(p in initial)&&p in current))failed.push('regression-tests-missing')
  if(!changed.some(p=>!p.startsWith('test/')&&allowed(task,p)))failed.push('implementation-missing')
  for(const p of changed) {
    if(!allowed(task,p))failed.push('scope:'+p)
    if(p.startsWith('test/')&&p in initial)failed.push('protected-test:'+p)
  }
  return {changed,failed:[...new Set(failed)]}
}
export async function grade(task,candidate,signal) {
  if(candidate!==rootFor(task))throw environmentError('candidate_identity_mismatch')
  const admission=await readJson(join(base,task.id,'admission.json'))
  await checkDependencies(task.id,candidate,admission)
  const before=await snapshot(candidate),scoped=boundary(task,admission.baseline,before)
  if(scoped.failed.length)return {passed:false,failed:scoped.failed}
  const {stdout:modeChanges}=await exec('git',['-C',candidate,'diff','--summary'])
  if(modeChanges.includes('mode change'))return {passed:false,failed:['file-mode-change']}
  const result=await inspect(task,before,{signal})
  const failed=result.checks.filter(c=>!c.passed).map(c=>c.id.startsWith('upstream:')?'public-tests':c.id==='build'?'build':'behavior')
  if(digest(before)!==digest(await snapshot(candidate)))failed.push('artifact-changed-during-grade')
  await checkDependencies(task.id,candidate,admission)
  return {passed:result.passed&&!failed.length,failed:[...new Set(failed)],artifact:digest(before)}
}
export async function qualify() {
  if(await exists(join(base,'qualification.json')))throw Error('Qualification already frozen; preserve it')
  const started=await identity(),results=[]
  for(const task of tasks) {
    const b=await baseline(task),root=rootFor(task),record={id:task.id,artifact:b.artifact,dependencies:b.dependencies}
    record.baseline=await inspect(task,root,{signal:AbortSignal.timeout(120000)})
    const expected=task.kind==='semaphore'?['empty','sparse','priority']:['defect']
    const failures=record.baseline.checks.filter(c=>!c.passed)
    record.baselineQualified=expected.every(id=>failures.some(c=>c.id===id))&&failures.every(c=>expected.includes(c.id)&&(task.kind==='semaphore'?c.timedOut:c.output.includes('AssertionError')))
    record.fixed=await inspect(task,root,{signal:AbortSignal.timeout(120000),fixture:'fixed',exerciseLive:true})
    record.mutants=[]
    for(const id of mutants(task)) {
      const check=await inspect(task,root,{signal:AbortSignal.timeout(30000),fixture:id,full:false})
      const rejected=check.checks.some(c=>c.id!=='build'&&!c.passed&&(c.timedOut||c.output.includes('AssertionError')))&&check.checks.every(c=>c.id!=='build'||c.passed)
      record.mutants.push({id,rejected,check})
    }
    await baseline(task)
    record.passed=record.baselineQualified&&record.fixed.passed&&record.mutants.every(m=>m.rejected)
    results.push(record)
    console.log(JSON.stringify({task:task.id,qualified:record.passed,fixedMs:record.fixed.elapsedMs,mutantsRejected:record.mutants.filter(m=>m.rejected).length}))
  }
  if(!same(started,await identity()))throw Error('Harness/toolchain changed during qualification')
  const result={schemaVersion:1,identity:started,passed:results.length===3&&results.every(r=>r.passed),tasks:results,providerCalls:0,performanceProcessTimeoutMs:3000}
  await writeOnce(join(base,'qualification-attempt-'+Date.now()+'.json'),result)
  if(result.passed)await writeOnce(join(base,'qualification.json'),result)
  return result.passed
}
export async function prepare() {
  const q=await readJson(join(base,'qualification.json')),current=await identity()
  if(!q.passed||!same(q.identity,current)||q.tasks.length!==tasks.length)throw Error('Qualification missing or stale')
  if(await exists(join(base,'batch-admission.json')))throw Error('Batch already admitted; use report')
  const prepared=[]
  for(const task of tasks) {
    if(await exists(join(base,task.id,'run.started.json'))||await exists(join(base,task.id,'result.json')))throw Error('Task consumed')
    const b=await baseline(task),proof=q.tasks.find(t=>t.id===task.id)
    if(!proof?.passed||proof.artifact!==b.artifact||!same(proof.dependencies,b.dependencies))throw Error('Task qualification differs from baseline')
    prepared.push({id:task.id,root:rootFor(task),head:b.head,suite:current,artifact:b.artifact,baseline:b.baseline,dependencies:b.dependencies})
  }
  const admissions={}
  for(const a of prepared){const path=join(base,a.id,'admission.json');if(await exists(path)){if(!same(await readJson(path),a))throw Error('Partial admission differs; preserve')}else await writeOnce(path,a);admissions[a.id]=sha(await readFile(path))}
  await writeOnce(join(base,'batch-admission.json'),{batchId:common.batchId,suite:current,qualification:sha(await readFile(join(base,'qualification.json'))),admissions})
}
export async function assertBatchAdmission() {
  const a=await readJson(join(base,'batch-admission.json'))
  if(a.batchId!==common.batchId||!same(a.suite,await identity())||a.qualification!==sha(await readFile(join(base,'qualification.json'))))throw Error('Batch admission stale')
  if(!same(Object.keys(a.admissions).sort(),tasks.map(t=>t.id).sort()))throw Error('Batch membership changed')
  for(const task of tasks)if(a.admissions[task.id]!==sha(await readFile(join(base,task.id,'admission.json'))))throw Error('Task admission changed')
}

const contracts={
  yargs:`Fix yargs-parser issue #385: strings from configObjects and JSON config files must preserve their literal quotes regardless of whether argv is a string or a pre-tokenized array. Preserve CLI string tokenization, literal array arguments, CLI/environment/config/default precedence, aliases, nested keys, array combination and declared value types. Run npm test, npm run test:typescript and npm run check.`,
  semaphore:`Fix async-mutex issue #90: release/setValue and unlock-waiter dispatch must scale with actual pending work rather than the numeric semaphore capacity, including large capacities with no waiters, sparse large weights and queued acquisitions. Preserve weight/priority ordering, non-consuming waitForUnlock notifications, cancellation error identity, idempotent releasers, runExclusive cleanup and Mutex behavior. Run yarn test and yarn build; NODE_OPTIONS=--no-experimental-strip-types is required with this Node version for the existing ts-node test loader.`,
  fjs:`Fix fast-json-stringify issue #684: a parent additionalProperties:false combined with allOf must retain declared-property serialization, nested array field conversion and required-field errors. Remove undeclared fields according to each schema. Preserve flat schema behavior, true/schema-valued additionalProperties, null branches, independent serializer state and input objects. Fix source generation, not generated output or dependencies. Run npm test and npm run lint without reducing coverage thresholds.`
}
export function prompt(task) {
  return `${contracts[task.kind]}\nPublic issue: ${task.issue}\nWork only in ${task.allowed.join(', ')}. Keep all existing tests unchanged; add meaningful regressions in a NEW test file matching this project's test discovery. Keep manifests, dependencies, locks, public API signatures and root configuration unchanged. Dependency installation and toolchain preparation are already complete; Yarn 1.22.22 is available on PATH where needed. Run test/build commands directly and preserve their exit status; if using pipelines, invoke bash with pipefail. Never use tail or echo success as proof of a test/build exit code. Build and run the package checks, inspect the full git diff and run git diff --check, close your task plan, then report the actual result and any blockers honestly. Use the exact current repository root as tool workdir and keep temporary reproductions inside your allowed test directory. No network, install, credentials, other workspaces/evaluators, commit/push, reset/clean or branch/worktree changes. This task has a shared 900-second deadline with a final 180-second closure window; recovery does not renew it.`
}
