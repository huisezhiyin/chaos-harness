import { prepareScratch } from './workdir.mjs'
import { commandEnvironment, environmentError } from './environment.mjs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, readlink, mkdir, cp, symlink, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const exec = promisify(execFile)
export const harness = fileURLToPath(new URL('../../', import.meta.url))
export const catalog = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8'))
export const batchId = catalog.batchId
export const tasks = catalog.tasks
export const targets = join(homedir(), 'github_project/chaos-dogfood')
export const base = join(homedir(), '.local/state/chaos-harness/evals', batchId)
export const rootFor = task => join(targets, task.id)
export const depsFor = task => join(base, 'dependencies', task.id)
export const sha = value => createHash('sha256').update(value).digest('hex')
export const digest = entries => sha(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))))
export const getTask = id => { const t = tasks.find(t => t.id === id); if (!t) throw Error('Unknown task'); return t }
export const allowed = (task, path) => task.allowed.some(p => p.endsWith('/') ? path.startsWith(p) : path === p)
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
export async function exists(path) { try { await lstat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
export async function writeOnce(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(value, null, 2)+'\n', { flag: 'wx', mode: 0o600 }) }

// Git-visible artifact: generated ignored outputs are rebuilt in the verifier.
// Never accept modified ignore rules, manifests, locks, symlinks or non-files.
export async function snapshot(root) {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '-c', '-o', '--exclude-standard', '-z'], { maxBuffer: 4*1024*1024 })
  const result = {}; let bytes = 0
  for (const path of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    if (path.split('/').includes('node_modules')) continue
    if (resolve(root, path) !== join(root, path)) throw Error('Invalid artifact path')
    let info
    try {info=await lstat(join(root,path))}catch(e){if(e.code==='ENOENT')continue;throw e}
    if (!info.isFile() || (bytes += info.size) > 64*1024*1024) throw Error('Invalid artifact file')
    result[path] = (await readFile(join(root, path))).toString('base64')
  }
  return result
}
export async function treeDigest(root) {
  const entries = {}
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir,name), info = await lstat(path), key = relative(root,path)
      if (info.isDirectory()) await walk(path)
      else if (info.isSymbolicLink()) entries[key] = 'link:'+await readlink(path)
      else if (info.isFile()) entries[key] = sha(await readFile(path))
      else throw Error('Unsupported dependency entry')
    }
  }
  await walk(root); return digest(entries)
}
export async function assertDependencyTree(root, expected) {
  if (await treeDigest(root) !== expected) throw environmentError('dependencies_changed')
}
export async function identity() {
  const {stdout} = await exec('git', ['-C',harness,'ls-files','-c','-o','--exclude-standard','-z','--','packages','bin','evals','package.json','pnpm-lock.yaml','tsconfig.json'],{maxBuffer:4*1024*1024})
  const files={};for(const p of [...new Set(stdout.split('\0').filter(Boolean))].sort())files[p]=sha(await readFile(join(harness,p)))
  return {batchId,runtime:digest(files),node:process.version,compiler:sha(await readFile(join(harness,'node_modules/typescript/lib/typescript.js'))),tools:await treeDigest(join(base,'tools'))}
}
export async function dependenciesIdentity(task) {
  return {lock:sha(await readFile(join(depsFor(task),task.lockfile??'package-lock.json'))),tree:await treeDigest(join(depsFor(task),'node_modules'))}
}
export async function mountDependencies(task,root) {
  if(task.kind==='fjs') {
    await mkdir(join(root,'node_modules'))
    for(const name of await readdir(join(depsFor(task),'node_modules'))) {
      if(name==='fast-json-stringify')continue
      await symlink(join(depsFor(task),'node_modules',name),join(root,'node_modules',name))
    }
    await symlink(root,join(root,'node_modules/fast-json-stringify'))
  } else await symlink(join(depsFor(task),'node_modules'),join(root,'node_modules'))
}
export async function makeCopy(task, source) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(),'chaos-mixed-verifier-'))), copy = join(scratch,'repo')
  await mkdir(copy)
  const entries = typeof source === 'string' ? await snapshot(source) : source
  for(const [path,encoded] of Object.entries(entries)) {await mkdir(dirname(join(copy,path)),{recursive:true});await writeFile(join(copy,path),Buffer.from(encoded,'base64'))}
  // Restore executable bits for upstream CLI fixtures from the official index.
  const {stdout}=await exec('git',['-C',rootFor(task),'ls-files','-s','-z'])
  const {chmod}=await import('node:fs/promises')
  for(const line of stdout.split('\0'))if(line.startsWith('100755 ')){const path=line.split('\t')[1];if(path in entries)await chmod(join(copy,path),0o755)}
  await mountDependencies(task,copy)
  return {scratch,copy,dispose:()=>rm(scratch,{recursive:true,force:true})}
}
export async function command(task, scratch, cwd, cmd, args, signal, timeout=30_000, liveEnvironment=false, toolsRoot=join(base,'tools')) {
  signal?.throwIfAborted()
  await prepareScratch(cwd)
  const policy=liveEnvironment?"(version 1)(allow default)(deny network*)":`(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(scratch)}))`
  try {
    const {stdout,stderr}=await exec('/usr/bin/sandbox-exec',['-p',policy,cmd,...args],{
      cwd,env:commandEnvironment({cacheRoot:join(scratch,'cache',liveEnvironment?'live':'verifier'),toolsRoot,workspaceRoot:cwd,inherited:{TMPDIR:scratch,CI:'true'}}),
      signal,timeout,maxBuffer:8*1024*1024,killSignal:'SIGKILL'})
    return {passed:true,exitCode:0,output:stdout+stderr}
  } catch(e) {if(signal?.aborted)throw signal.reason;if(typeof e.code!=='number'&&!e.killed)throw environmentError('verifier_exception');return {passed:false,exitCode:typeof e.code==='number'?e.code:null,timedOut:!!e.killed,output:String(e.stdout??'')+String(e.stderr??'')}}
}
