import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inspectPackage, inspectDelivery } from './probe.mjs'
export const exec = promisify(execFile)
export const batchId = 'real-csv-stringify-476-v1'
export const taskId = 'csv-stringify-476-v1'
export const targets = join(homedir(), 'github_project/chaos-dogfood')
export const root = join(targets, taskId)
export const base = join(homedir(), '.local/state/chaos-harness/evals', batchId)
export const upstreamHead = '3591c0770f7235b203f7cbcd7805ddedfaaf3ce1'
export const upstreamTree = 'ff6f8187b39704546029aad8e682331eb5e5b6b1'
export const localHead = '8b8d610e1d2097837c0f92707e5662a99d34ff75'
export const tasks = [{ id: taskId, category: 'real-repository', title: 'Browser declaration ambient isolation' }]
export const getTask = id => { if (id !== taskId) throw new Error('Unknown task'); return tasks[0] }
const sha = value => createHash('sha256').update(value).digest('hex')
const harness = fileURLToPath(new URL('../../', import.meta.url))
export const digest = entries => sha(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))))
export async function snapshot(dir) {
  const entries = {}; let bytes = 0
  async function walk(path) {
    for (const name of await readdir(path)) {
      if (name === '.git' || name === 'node_modules') continue
      const file = join(path, name), info = await lstat(file)
      if (info.isSymbolicLink()) throw new Error('Unexpected target symlink')
      if (info.isDirectory()) { await walk(file); continue }
      if (!info.isFile() || (bytes += info.size) > 32 * 1024 * 1024) throw new Error('Target snapshot limit')
      entries[relative(dir, file)] = (await readFile(file)).toString('base64')
    }
  }
  await walk(dir); return entries
}
export async function identity() {
  const { stdout } = await exec('git', ['-C', harness, 'ls-files', '-c', '-o', '--exclude-standard', '-z', '--',
    'packages', 'bin', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'evals'], { maxBuffer: 1024 * 1024 })
  const files = [...new Set(stdout.split('\0').filter(Boolean))].sort(), entries = []
  for (const file of files) entries.push([file, sha(await readFile(join(harness, file)))])
  const deps = ['typescript/package.json', '@types/node/package.json']
  const compiler = await Promise.all(deps.map(async file => [file, sha(await readFile(join(harness, 'node_modules', file)))]))
  return { batchId, upstreamHead, upstreamTree, localHead, runtime: sha(JSON.stringify(entries)), compiler: sha(JSON.stringify(compiler)) }
}
export async function assertBaseline() {
  const { stdout: head } = await exec('git', ['-C', root, 'rev-parse', 'HEAD'])
  const { stdout: tree } = await exec('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'])
  const { stdout: status } = await exec('git', ['-C', root, 'status', '--porcelain'])
  const { stdout: branches } = await exec('git', ['-C', root, 'for-each-ref', 'refs/heads'])
  if (head.trim() !== localHead || tree.trim() !== upstreamTree || status.trim() || branches.trim()) throw new Error('Real task baseline identity changed; preserve it')
}
export const prompt = () => `Fix the public csv-stringify browser TypeScript declaration issue https://github.com/adaltas/node-csv/issues/476.
The browser/esm and browser/esm/sync entry points must not import Node ambient types into a DOM-only consumer: with types=[] and DOM lib, setTimeout must keep its number result.
Preserve the existing stringify APIs, useful option type errors, Node ESM/CJS stream and Buffer support, and runtime behavior. Fix maintainable source/build generation; editing generated dist alone is insufficient.
Work only in packages/csv-stringify: declaration sources, necessary declaration build scripts, tests and generated declarations. In this package manifest only change declaration build scripts and types/exports mappings if necessary. Keep dependencies, other packages and root configuration unchanged.
Add regressions, rebuild declarations, run the package tests and git diff --check, inspect the final diff, then close the task plan. Use each tool with the exact current repository root as workdir. No install, network, credentials, commit/push, reset/clean or branch/worktree changes. Do not read other workspaces or evaluators. Report blockers honestly.`

export async function grade(_task, candidate, signal) {
  const admission = JSON.parse(await readFile(join(base, taskId, 'admission.json'), 'utf8'))
  const before = await snapshot(candidate), initial = admission.baseline
  const changed = [...new Set([...Object.keys(initial), ...Object.keys(before)])].filter(p => initial[p] !== before[p])
  const failed = []
  if (!changed.length) failed.push('no-mutation')
  if (!changed.some(p => p.startsWith('packages/csv-stringify/test/'))) failed.push('regression-tests-missing')
  for (const p of changed) if (!p.startsWith('packages/csv-stringify/')) failed.push('scope')
  const manifest = 'packages/csv-stringify/package.json'
  const normalize = encoded => {
    const p = JSON.parse(Buffer.from(encoded, 'base64').toString());
    delete p.exports; delete p.types; delete p.typesVersions
    for (const k of Object.keys(p.scripts ?? {})) if (/^(?:pre|post)?build(?::|$)/.test(k)) delete p.scripts[k]
    return p
  }
  if (!before[manifest] || JSON.stringify(normalize(before[manifest])) !== JSON.stringify(normalize(initial[manifest]))) failed.push('manifest-boundary')
  if (failed.length) return { passed: false, failed: [...new Set(failed)] }
  const delivered = await inspectDelivery(candidate, signal)
  failed.push(...delivered.checks.filter(c => !c.passed).map(c => c.id))
  if (digest(before) !== digest(await snapshot(candidate))) failed.push('artifact-changed-during-grade')
  return { passed: delivered.passed && !failed.length, failed, artifact: digest(before) }
}

// Qualification-only minimal type fixture. Kept outside the target and model prompt.
export async function fixedFixture(dir) {
  const pkg = join(dir, 'packages/csv-stringify')
  let declaration = await readFile(join(pkg, 'lib/index.d.ts'), 'utf8')
  declaration = declaration.replace('/// <reference types="node" />', '').replace('import * as stream from "stream";', `declare namespace stream {
    interface TransformOptions { highWaterMark?: number; objectMode?: boolean; encoding?: string }
    class Transform { write(chunk: unknown): boolean; end(): this; on(event: string, listener: (...args: unknown[]) => void): this }
  }`).replace(/\bBuffer\b/g, 'Uint8Array')
  await writeFile(join(pkg, 'lib/browser.d.ts'), declaration)
  const sync = (await readFile(join(pkg, 'lib/sync.d.ts'), 'utf8')).replaceAll('./index.js', './browser.js')
  await writeFile(join(pkg, 'lib/browser-sync.d.ts'), sync)
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  manifest.scripts['build:ts'] += ' && cp lib/browser.d.ts dist/esm/index.d.ts && cp lib/browser-sync.d.ts dist/esm/sync.d.ts'
  await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest, null, 2))
}
export async function qualify() {
  await assertBaseline()
  const starting = digest(await snapshot(root)), signal = AbortSignal.timeout(240_000)
  const baseline = await inspectPackage(root, signal)
  const expected = baseline.checks.every(c => c.id.startsWith('browser') ? !c.passed && c.codes.includes('TS2322') && c.codes.every(code => ['TS2322', 'TS2578'].includes(code)) : c.passed)
  const scratch = await mkdtemp(join(tmpdir(), 'chaos-csv476-qualification-')), copy = join(scratch, 'repo')
  try {
    await cp(root, copy, { recursive: true, filter: p => !['.git', 'node_modules'].includes(p.split('/').at(-1)) })
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
    await symlink(join(root, 'packages/csv-stringify/node_modules'), join(copy, 'packages/csv-stringify/node_modules'))
    await fixedFixture(copy)
    const fixed = await inspectDelivery(copy, signal)
    const declaration = join(copy, 'packages/csv-stringify/lib/browser.d.ts')
    const originalDeclaration = await readFile(declaration, 'utf8')
    await writeFile(declaration, '/// <reference types="node" />\n'+originalDeclaration)
    const leak = await inspectDelivery(copy, signal)
    await writeFile(declaration, originalDeclaration.replace('quoted?: boolean;', 'quoted?: boolean | string;'))
    const lax = await inspectDelivery(copy, signal)
    await writeFile(declaration, originalDeclaration)
    // Generated-file-only patches must disappear when the original build runs.
    const pkg = join(copy, 'packages/csv-stringify')
    await writeFile(join(pkg, 'dist/esm/index.d.ts'), originalDeclaration)
    await writeFile(join(pkg, 'dist/esm/browser.d.ts'), originalDeclaration)
    await writeFile(join(pkg, 'dist/esm/sync.d.ts'), await readFile(join(pkg, 'lib/browser-sync.d.ts')))
    await writeFile(join(pkg, 'package.json'), await readFile(join(root, 'packages/csv-stringify/package.json')))
    const distOnly = await inspectDelivery(copy, signal)
    const mutants = [
      { id: 'ambient-leak', rejected: !leak.passed && leak.checks.some(c => c.id === 'browser' && !c.passed) },
      { id: 'loosened-option', rejected: !lax.passed && lax.checks.some(c => c.id === 'browser' && !c.passed) },
      { id: 'generated-only', rejected: !distOnly.passed && distOnly.checks.some(c => c.id === 'browser' && !c.passed) },
    ]
    const passed = expected && fixed.passed && mutants.every(m => m.rejected) && starting === digest(await snapshot(root))
    const result = { passed, baseline, fixed: { passed: fixed.passed, checks: fixed.checks, packageTests: fixed.packageTests }, mutants, identity: await identity() }
    console.log(JSON.stringify(result, null, 2))
    if (!fixed.passed && fixed.prerequisiteOutput) console.log(fixed.prerequisiteOutput)
    await mkdir(base, { recursive: true, mode: 0o700 })
    await writeFile(join(base, 'qualification.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
    return passed
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
export async function prepare() {
  await assertBaseline()
  const q = JSON.parse(await readFile(join(base, 'qualification.json'), 'utf8'))
  if (!q.passed || JSON.stringify(q.identity) !== JSON.stringify(await identity())) throw new Error('Qualification missing or stale; no model started')
  const baseline = await snapshot(root)
  await mkdir(join(base, taskId), { mode: 0o700 })
  await writeFile(join(base, taskId, 'admission.json'), JSON.stringify({ id: taskId, root, head: localHead,
    suite: await identity(), artifact: digest(baseline), baseline }), { flag: 'wx', mode: 0o600 })
}
