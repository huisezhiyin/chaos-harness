import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandEnvironment } from './environment.mjs'
import { prepareScratch, scratchFindings, scratchPath, workspaceGuidance } from './workdir.mjs'
import { boundary, tasks } from './suite.mjs'
import { inspectReadiness } from './readiness.mjs'
import { command } from './common.mjs'

const exec = promisify(execFile)
async function fixture(fn) {
  // Match makeCopy: macOS sandbox subpath rules require the physical path.
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'chaos-workdir-check-')))
  const root = join(parent, 'repo')
  await mkdir(root)
  try { await fn(root, parent) } finally { await rm(parent, { recursive: true, force: true }) }
}

test('real shell captures and reads local logs without losing a failing command status', () => fixture(async (root, parent) => {
  const scratch = await prepareScratch(root)
  const env = commandEnvironment({ workspaceRoot: root, cacheRoot: join(parent, 'cache'), toolsRoot: join(parent, 'tools'), inherited: { TMPDIR: '/ambient', TMP: '/ambient', TEMP: '/ambient', PWD: '/ambient' } })
  const child = await exec(process.execPath, ['--input-type=module', '-e', 'import {tmpdir} from "node:os"; console.log(tmpdir())'], { cwd: root, env })
  assert.equal(child.stdout.trim(), scratch)
  assert.equal(env.TMP, scratch); assert.equal(env.TEMP, scratch); assert.equal(env.PWD, root)
  await assert.rejects(exec('/bin/bash', ['-c', 'printf "local-test-failed\\n" > "$TMPDIR/test.log"; (exit 7) >> "$TMPDIR/test.log" 2>&1; status=$?; cat "$TMPDIR/test.log"; exit "$status"'], { cwd: root, env }), error => {
    assert.equal(error.code, 7); assert.equal(error.stdout, 'local-test-failed\n'); return true
  })
  assert.deepEqual(await scratchFindings(root), ['temporary-files-remain'])
  const result = await exec('/bin/bash', ['-c', 'cat "$TMPDIR/test.log"; rm -- "$TMPDIR/test.log"'], { cwd: root, env })
  assert.equal(result.stdout, 'local-test-failed\n')
  assert.deepEqual(await scratchFindings(root), [])
}))

test('directory links and file collisions are rejected without changing the destination', () => fixture(async (root, parent) => {
  const outside = join(parent, 'outside'); await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'untouched')
  await symlink(outside, join(root, 'test'))
  await assert.rejects(prepareScratch(root), /physical workspace/)
  assert.deepEqual(await scratchFindings(root), ['temporary-directory-invalid'])
  await rm(join(root, 'test')); await mkdir(join(root, 'test'))
  await symlink(outside, scratchPath(root))
  await assert.rejects(prepareScratch(root), /physical workspace/)
  await rm(scratchPath(root)); await writeFile(scratchPath(root), 'collision')
  await assert.rejects(prepareScratch(root), /physical workspace/)
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
}))

test('temporary files cannot satisfy regressions or disappear through a filtered artifact snapshot', () => fixture(async (root, parent) => {
  const task = tasks[0], source = task.allowed.find(path => !path.endsWith('/'))
  const initial = { [source]: 'original' }, current = { [source]: 'fixed', 'test/.chaos-tmp/probe.test.ts': 'temporary' }
  const findings = boundary(task, initial, current).failed
  assert(findings.includes('regression-tests-missing')); assert(findings.includes('temporary-files-remain'))
  await prepareScratch(root); await writeFile(join(scratchPath(root), 'ignored.log'), 'temporary')
  const state = join(parent, 'state', task.id); await mkdir(state, { recursive: true })
  await writeFile(join(state, 'admission.json'), JSON.stringify({ root, baseline: initial }))
  const suite = { base: join(parent, 'state'), getTask: () => task, boundary, snapshot: async () => ({ [source]: 'fixed', 'test/regression.ts': 'new' }) }
  const result = await inspectReadiness(suite, task.id, root, AbortSignal.timeout(5000))
  assert.equal(result.passed, false); assert.deepEqual(result.failed, ['temporary-files-remain'])
  await rm(join(scratchPath(root), 'ignored.log'))
  assert.equal((await inspectReadiness(suite, task.id, root, AbortSignal.timeout(5000))).passed, true)
}))

test('new batch excludes the consumed task and gives concrete workspace guidance', () => {
  assert.deepEqual(tasks.map(task => task.kind), ['semaphore', 'fjs'])
  const guidance = workspaceGuidance('/task repo')
  assert(guidance.includes('"/task repo/test/.chaos-tmp"'))
  assert(guidance.includes('return that saved status'))
  assert(guidance.includes('Do not request broader permissions'))
})

test('production qualifier and live-equivalent commands receive the same local temporary directory', () => fixture(async (root, parent) => {
  for (const live of [false, true]) {
    const result = await command({}, parent, root, process.execPath, ['--input-type=module', '-e', 'import {tmpdir} from "node:os"; import {writeFileSync} from "node:fs"; import {join} from "node:path"; writeFileSync(join(tmpdir(),"qualifier.log"), "ok"); console.log(JSON.stringify({tmp:tmpdir(),pwd:process.env.PWD,cwd:process.cwd(),cache:process.env.CACHE_DIR}))'], AbortSignal.timeout(5000), 5000, live, join(parent, 'tools'))
    assert.equal(result.passed, true, result.output)
    const output = JSON.parse(result.output)
    assert.equal(output.tmp, scratchPath(root)); assert.equal(output.pwd, root)
    assert.equal(output.cache, join(parent, 'cache', live ? 'live' : 'verifier'))
    assert.equal(await readFile(join(scratchPath(root), 'qualifier.log'), 'utf8'), 'ok')
    await rm(join(scratchPath(root), 'qualifier.log'))
  }
}))
