// Owner-only qualification repairs/mutants. Never copied to a model target.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
async function replace(file,before,after){const text=await readFile(file,'utf8');if(!text.includes(before))throw Error('Fixture source drift');await writeFile(file,text.replace(before,after))}
export async function repair(task,root) {
  if(task.kind==='yargs') {
    await replace(join(root,'lib/yargs-parser.ts'),'setArg(fullKey, value)','setArg(fullKey, value, false)')
  } else if(task.kind==='semaphore') {
    const file=join(root,'src/Semaphore.ts')
    let source=await readFile(file,'utf8')
    source=source.replaceAll('for (let weight = this._value; weight > 0; weight--) {','for (const index of Object.keys(this._weightedWaiters)) {\n                const weight = Number(index) + 1;\n                if (weight > this._value) continue;')
    source=source.replace('waiters.forEach((waiter) => waiter.resolve());\n                this._weightedWaiters[weight - 1] = [];','waiters.forEach((waiter) => waiter.resolve());\n                delete this._weightedWaiters[weight - 1];')
    source=source.replace('.forEach((waiter => waiter.resolve()));','.forEach((waiter => waiter.resolve()));\n                if (i === -1 || waiters.length === 0) delete this._weightedWaiters[weight - 1];')
    await writeFile(file,source)
  } else if(task.kind==='fjs') {
    const file=join(root,'index.js')
    await replace(file,'const { allOf, ...schemaWithoutAllOf } = location.schema','const { allOf, ...schemaWithoutAllOf } = location.schema\n  const forbidAdditional = schemaWithoutAllOf.additionalProperties === false\n  if (forbidAdditional) delete schemaWithoutAllOf.additionalProperties')
    await replace(file,'const mergedLocation = mergeLocations(context, mergedSchemaId, locations)\n  return buildValue','const mergedLocation = mergeLocations(context, mergedSchemaId, locations)\n  if (forbidAdditional) mergedLocation.schema.additionalProperties = false\n  return buildValue')
    await writeFile(join(root,'test/qualification-allof.test.js'),`'use strict'\nconst { test } = require('node:test')\nconst build = require('..')\ntest('allOf preserves nested declarations with a closed parent', (t) => {\n  const schema = { additionalProperties: false, allOf: [{ type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } } }, required: ['rows'] }] }\n  const stringify = build(schema)\n  t.assert.deepStrictEqual(JSON.parse(stringify({ rows: [{ enabled: 1 }], extra: 1 })), { rows: [{ enabled: true }] })\n  t.assert.throws(() => stringify({ rows: [{}] }))\n})\n`)
  } else throw Error('No qualified repair for '+task.kind)
}
export const mutants=task=>task.kind==='yargs'?['global-no-strip','objects-only','config-overrides-cli']:task.kind==='semaphore'?['empty-only','smallest-only','ignore-priority','double-release']:['raw-json','allow-extra','skip-required','nested-raw']
export async function mutate(task,root,id) {
  const file=join(root,task.kind==='yargs'?'lib/yargs-parser.ts':'src/Semaphore.ts')
  if(id==='global-no-strip')await replace(file,'if (shouldStripQuotes) {','if (shouldStripQuotes && key.length < 0) {')
  if(id==='objects-only') {
    await replace(file,'setConfigObject(config)\n','setConfigObject(config, undefined, true)\n')
    await replace(file,'prev?: string): void {','prev?: string, fromFile = false): void {')
    await replace(file,'setConfigObject(value, fullKey)','setConfigObject(value, fullKey, fromFile)')
    await replace(file,'setArg(fullKey, value, false)','setArg(fullKey, value, fromFile ? inputIsString : false)')
  }
  if(id==='config-overrides-cli')await replace(file,"if (!hasKey(argv, fullKey.split('.')) || (checkAllAliases(fullKey, flags.arrays) && configuration['combine-arrays'])) {",'if (true) {')
  if(id==='empty-only') {
    let text=await readFile(file,'utf8');text=text.replaceAll('for (const index of Object.keys(this._weightedWaiters)) {\n                const weight = Number(index) + 1;\n                if (weight > this._value) continue;','for (let weight = this._value; weight > 0; weight--) {');text=text.replace('private _drainUnlockWaiters(): void {','private _drainUnlockWaiters(): void {\n        if (Object.keys(this._weightedWaiters).length === 0) return;');await writeFile(file,text)
  }
  if(id==='smallest-only'){let text=await readFile(file,'utf8');text=text.replaceAll('Object.keys(this._weightedWaiters))','Object.keys(this._weightedWaiters).slice(0, 1))');await writeFile(file,text)}
  if(id==='ignore-priority')await replace(file,'waiter.priority <= queuedPriority','waiter.priority <= queuedPriority - Number.MAX_VALUE')
  if(id==='double-release')await replace(file,'if (called) return;','if (called && weight < 0) return;')
  if(task.kind==='fjs') {
    const file=join(root,'index.js')
    if(id==='raw-json')await replace(file,'function buildAllOf (context, location, input) {','function buildAllOf (context, location, input) {\n  return `json += JSON.stringify(${input})`\n')
    if(id==='allow-extra')await replace(file,'mergedLocation.schema.additionalProperties = false','mergedLocation.schema.additionalProperties = true')
    if(id==='skip-required')await replace(file,"requiredProperties.includes(key)",'false')
    if(id==='nested-raw')await replace(file,'function buildArray (context, location, input) {','function buildArray (context, location, input) {\n  return `json += JSON.stringify(${input})`\n')
  }
}
