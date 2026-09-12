import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const harness = fileURLToPath(new URL('../../', import.meta.url))
const compiler = join(harness, 'node_modules/typescript/bin/tsc')
const nodeTypes = join(harness, 'node_modules/@types')

const browser = entry => `import { stringify } from 'csv-stringify/${entry}';
const timer: number = setTimeout(() => {}, 1);
const interval: number = setInterval(() => {}, 1);
clearTimeout(timer); clearInterval(interval);
// @ts-expect-error Node globals must not be introduced by a browser import
process.cwd();
// @ts-expect-error Node Buffer must not become ambient in a browser consumer
Buffer.from('x');
stringify([['x', 1]], { header: true, columns: ['a', 'b'] });
// @ts-expect-error quoted must be boolean
stringify([['x']], { quoted: 'yes' });
// @ts-expect-error input must be an array
stringify(42);
export { timer };
`
const node = `import { stringify } from 'csv-stringify';
import { stringify as sync } from 'csv-stringify/sync';
import { Transform } from 'node:stream';
const stream: Transform = stringify([['x']], { delimiter: Buffer.from(',') });
stream.on('data', chunk => String(chunk)); stream.end();
const value: string = sync([['x']], { record_delimiter: Buffer.from('\\n') });
// @ts-expect-error quoted must be boolean
stringify([['x']], { quoted: 'yes' });
export { value };
`

async function command(scratch, cwd, cmd, args, signal, timeout = 30_000) {
  const policy = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}))`
  try {
    const result = await exec('/usr/bin/sandbox-exec', ['-p', policy, cmd, ...args], {
      cwd, env: { PATH: `${join(harness,'node_modules/.bin')}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        HOME: scratch, TMPDIR: scratch, npm_config_cache: join(scratch, 'npm-cache'), npm_config_offline: 'true' },
      timeout, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}),
    })
    return { passed: true, codes: [], output: result.stdout }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    const text = String(error.stdout ?? '') + String(error.stderr ?? '')
    return { passed: false, codes: [...new Set(text.match(/TS\d+/g) ?? [])], output: text }
  }
}

/** Public type/runtime contract; no reference implementation is used here. */
export async function inspectPackage(root, signal) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'chaos-csv476-types-')))
  const checks = []
  try {
    for (const [id, source, extension, types] of [
      ['browser', browser('browser/esm'), 'mts', []],
      ['browser-sync', browser('browser/esm/sync'), 'mts', []],
      ['node-esm', node, 'mts', ['node']], ['node-cjs', node, 'cts', ['node']],
    ]) {
      const dir = join(scratch, id)
      await mkdir(join(dir, 'node_modules'), { recursive: true })
      await symlink(join(root, 'packages/csv-stringify'), join(dir, 'node_modules/csv-stringify'))
      await symlink(nodeTypes, join(dir, 'node_modules/@types'))
      await writeFile(join(dir, `consumer.${extension}`), source)
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types,
        lib: ['ES2022', 'DOM'], strict: true, noEmit: true, skipLibCheck: false,
        typeRoots: [join(dir, 'node_modules/@types')],
      }, files: [`consumer.${extension}`] }))
      const result = await command(scratch, dir, process.execPath, [compiler, '-p', 'tsconfig.json'], signal)
      checks.push({ id, passed: result.passed, codes: result.codes })
    }
    const runtime = join(scratch, 'runtime.mjs')
    await writeFile(runtime, `import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=${JSON.stringify(root)};
for (const path of ['lib/sync.js','dist/esm/sync.js','dist/cjs/sync.cjs']) {
 const { stringify }=await import(pathToFileURL(root+'/packages/csv-stringify/'+path));
 assert.equal(stringify([['a,b','x'],['z','q']]), '"a,b",x\\nz,q\\n');
}
for (const path of ['lib/index.js','dist/esm/index.js','dist/cjs/index.cjs']) {
 const { stringify }=await import(pathToFileURL(root+'/packages/csv-stringify/'+path));
 const out=await new Promise((resolve,reject)=>stringify([['a,b','x']],(err,text)=>err?reject(err):resolve(text)));
 assert.equal(out, '"a,b",x\\n');
}`)
    const result = await command(scratch, scratch, process.execPath, [runtime], signal)
    checks.push({ id: 'public-runtime', passed: result.passed, codes: [] })
    return { passed: checks.every(c => c.passed), checks }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Rebuild declarations and run delivery checks on a copy; target stays untouched. */
export async function inspectDelivery(root, signal) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'chaos-csv476-delivery-'))), copy = join(scratch, 'repo')
  try {
    await cp(root, copy, { recursive: true, filter: path => !['.git', 'node_modules'].includes(path.split('/').at(-1)) })
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
    const pkg = join(copy, 'packages/csv-stringify')
    try { await symlink(join(root, 'packages/csv-stringify/node_modules'), join(pkg, 'node_modules')) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    // Force regeneration: hand-edited generated declarations cannot satisfy this gate.
    for (const dir of ['esm', 'cjs']) {
      for (const name of await readdir(join(pkg, 'dist', dir))) {
        if (/\.d\.(?:ts|cts)$/.test(name)) await rm(join(pkg, 'dist', dir, name))
      }
    }
    // Upstream pipe tests use a shared absolute /tmp filename. Relocate only
    // that fixture path on this private copy; preserve every test/assertion.
    const pipeTest = join(pkg, 'test/api.pipe.js')
    await writeFile(pipeTest, (await readFile(pipeTest, 'utf8')).replaceAll('/tmp/large.out', join(scratch, 'large.out')))
    // Invoke the build command from the candidate's manifest, with no network or
    // writes outside this scratch. Do not accept a hand-edited dist alone.
    const build = await command(scratch, pkg, '/usr/bin/env', ['npm', 'run', 'build:ts'], signal)
    const behavior = build.passed ? await inspectPackage(copy, signal) : { passed: false, checks: [] }
    const tests = await command(scratch, pkg, '/usr/bin/env', ['npm', 'test'], signal, 120_000)
    return { passed: build.passed && behavior.passed && tests.passed,
      checks: [{ id: 'declaration-build', passed: build.passed }, ...behavior.checks, { id: 'package-tests', passed: tests.passed }],
      packageTests: { passed: Number(/(\d+) passing/.exec(tests.output)?.[1] ?? 0), pending: Number(/(\d+) pending/.exec(tests.output)?.[1] ?? 0) },
      // caller may retain this only locally when preparing prerequisites; never forward it to the model
      prerequisiteOutput: [build.passed ? '' : build.output, tests.passed ? '' : tests.output].join('\n').slice(-4000) }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
