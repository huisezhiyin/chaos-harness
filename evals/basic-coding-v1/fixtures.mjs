// Owner-only reference implementations and evaluator controls; never target input.
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {join} from 'node:path'
async function replace(file, before, after) {
  const source = await readFile(file, 'utf8')
  if (!source.includes(before)) throw Error('Fixture source drift')
  await writeFile(file, source.replace(before, after))
}
export const mutants = task => ({equal:['view-always-equal','ignore-offset'],queue:['reverse-input','drop-undefined'],retry:['unfrozen-context','wrong-attempt'],limit:['wrong-abort','wrong-pending','drop-arguments']})[task.kind]
export async function repair(task, root) {
  await mkdir(join(root, 'test'), {recursive:true})
  if (task.kind === 'equal') {
    await replace(join(root,'src/index.jst'),'    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {', `    if ((a instanceof DataView) && (b instanceof DataView)) {
      if (a.byteLength !== b.byteLength) return false;
      for (i = a.byteLength; i-- !== 0;)
        if (a.getUint8(i) !== b.getUint8(i)) return false;
      return true;
    }

    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {`)
    await writeFile(join(root,'spec/dataview-regression.spec.js'), `'use strict';
var assert = require('assert');
describe('DataView visible bytes', function() {
  ['../es6', '../es6/react'].forEach(function(path) {
    it(path, function() {
      var equal = require(path);
      assert.strictEqual(equal(new DataView(new Uint8Array([8, 1, 2]).buffer, 1), new DataView(new Uint8Array([1, 2, 9]).buffer, 0, 2)), true);
      assert.strictEqual(equal(new DataView(new Uint8Array([1]).buffer), new DataView(new Uint8Array([2]).buffer)), false);
      assert.strictEqual(equal(new DataView(new ArrayBuffer(0)), new DataView(new ArrayBuffer(0))), true);
    });
  });
});
`)
  } else if (task.kind === 'queue') {
    await replace(join(root,'index.js'),'\tdequeue() {', '\tenqueueAll(iterable) {\n\t\tfor (const value of iterable) {\n\t\t\tthis.enqueue(value);\n\t\t}\n\t}\n\n\tdequeue() {')
    await replace(join(root,'index.d.ts'),'enqueue(value: ValueType): void;', 'enqueue(value: ValueType): void;\n\tenqueueAll(iterable: Iterable<ValueType>): void;')
    const readme=join(root,'readme.md');await writeFile(readme,(await readFile(readme,'utf8'))+'\n### queue.enqueueAll(iterable)\n\nAppend iterable values in order. Returns undefined. An iterator error propagates after keeping the already appended prefix.\n')
    await writeFile(join(root,'test/enqueue-all.test.js'), `import test from 'ava';
import Queue from '../index.js';

test('enqueueAll appends iterable values without losing undefined', t => {
	const queue = new Queue();
	queue.enqueue('old');
	t.is(queue.enqueueAll(['a', undefined, 'b']), undefined);
	t.deepEqual([...queue], ['old', 'a', undefined, 'b']);
	t.is(queue.size, 4);
});
`)
  } else if (task.kind === 'retry') {
    const file=join(root,'index.js'),source=await readFile(file,'utf8')
    if ((source.match(/Object\.freeze\(/g)||[]).length!==3) throw Error('Retry baseline drift')
    await writeFile(file,source.replaceAll('Object.freeze({','createRetryContext({')+'\nfunction createRetryContext(context) {\n\treturn Object.freeze(context);\n}\n')
    await writeFile(join(root,'test/retry-context.test.js'), `import test from 'ava';
import pRetry from '../index.js';

test('retry contexts stay frozen and count attempts', async t => {
	const contexts = [];
	const result = await pRetry(attempt => {
		if (attempt < 2) {
			throw new Error('retry');
		}

		return 7;
	}, {
		minTimeout: 0,
		onFailedAttempt(context) {
			contexts.push(context);
		},
	});
	t.is(result, 7);
	t.true(Object.isFrozen(contexts[0]));
	t.is(contexts[0].attemptNumber, 1);
});
`)
  } else if (task.kind === 'limit') {
    await writeFile(join(root,'test/limit-contract.test.js'), `import {AsyncLocalStorage} from 'node:async_hooks';
import test from 'ava';
import pLimit from '../index.js';

test('queued calls retain caller context and arguments', async t => {
	const storage = new AsyncLocalStorage();
	const limit = pLimit(1);
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});
	const first = storage.run('first', () => limit(async value => {
		await gate;
		return [storage.getStore(), value];
	}, 1));
	const second = storage.run('second', () => limit(value => [storage.getStore(), value], 2));
	t.is(limit.activeCount, 1);
	t.is(limit.pendingCount, 1);
	release();
	t.deepEqual(await Promise.all([first, second]), [['first', 1], ['second', 2]]);
});

test('rejectOnClear rejects queued work without cancelling active work', async t => {
	const limit = pLimit({concurrency: 1, rejectOnClear: true});
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});
	const active = limit(() => gate);
	let called = false;
	const pending = limit(() => {
		called = true;
	});
	const rejected = t.throwsAsync(pending, {name: 'AbortError'});
	t.is(limit.pendingCount, 1);
	limit.clearQueue();
	t.is(limit.activeCount, 1);
	t.is(limit.pendingCount, 0);
	release(9);
	t.is(await active, 9);
	await rejected;
	t.false(called);
});
`)
  }
}
export async function mutate(task, root, id) {
  const path=join(root,task.kind==='equal'?'src/index.jst':'index.js')
  if(id==='view-always-equal')await replace(path,'if (a.byteLength !== b.byteLength) return false;','return true;\n      if (a.byteLength !== b.byteLength) return false;')
  if(id==='ignore-offset')await replace(path,'a.getUint8(i) !== b.getUint8(i)','new Uint8Array(a.buffer)[i] !== new Uint8Array(b.buffer)[i]')
  if(id==='reverse-input')await replace(path,'for (const value of iterable)','for (const value of [...iterable].reverse())')
  if(id==='drop-undefined')await replace(path,'this.enqueue(value);','if (value !== undefined) this.enqueue(value);')
  if(id==='unfrozen-context')await replace(path,'return Object.freeze(context);','return context;')
  if(id==='wrong-attempt')await replace(path,'return Object.freeze(context);','return Object.freeze({...context, attemptNumber: 0});')
  if(id==='wrong-abort')await replace(path,'queue.dequeue().reject(abortError);',"queue.dequeue().reject(new Error('wrong abort')); ")
  if(id==='wrong-pending')await replace(path,'get: () => queue.size,','get: () => 0,')
  if(id==='drop-arguments')await replace(path,'function_(...arguments_)','function_()')
}
