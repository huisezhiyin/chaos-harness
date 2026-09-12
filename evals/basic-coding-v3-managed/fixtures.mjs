import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
async function replace(file,before,after){const s=await readFile(file,'utf8');if(!s.includes(before))throw Error('Fixture drift');await writeFile(file,s.replace(before,after))}
export const mutants=task=>task.kind==='defer'?['never-settled','mutable-status','later-wins']:['drop-receiver-args','wrong-count','drop-cache']
export async function repair(task,root){
 await mkdir(join(root,'test'),{recursive:true})
 if(task.kind==='defer'){
  await writeFile(join(root,'index.js'),`export default function pDefer() {
	let settled = false;
	const deferred = {};
	Object.defineProperty(deferred, 'settled', {get: () => settled, enumerable: true});
	deferred.promise = new Promise((resolve, reject) => {
		deferred.resolve = value => {
			settled = true;
			resolve(value);
		};
		deferred.reject = reason => {
			settled = true;
			reject(reason);
		};
	});
	return deferred;
}
`)
  await replace(join(root,'index.d.ts'),'export interface DeferredPromise<ValueType> {','export interface DeferredPromise<ValueType> {\n\treadonly settled: boolean;')
  await writeFile(join(root,'readme.md'),(await readFile(join(root,'readme.md'),'utf8'))+'\n### settled\n\nReadonly boolean, initially false. True synchronously after the first resolve or reject invocation, even while adopting a pending thenable. It does not report eventual fulfillment.\n')
  await writeFile(join(root,'test/settled.test.js'),`import test from 'ava';
import pDefer from '../index.js';

test('settled records a detached invocation before adoption', async t => {
	const deferred = pDefer();
	const inner = pDefer();
	t.false(deferred.settled);
	const {resolve} = deferred;
	resolve(inner.promise);
	t.true(deferred.settled);
	inner.resolve(4);
	t.is(await deferred.promise, 4);
	t.throws(() => { deferred.settled = false; }, {instanceOf: TypeError});
});
`)
 }else{
  await writeFile(join(root,'test/behavior.test.js'),`import test from 'ava';
import onetime from '../index.js';

test('synchronous failures permit retry; cached calls retain first success', t => {
	const error = new Error('first');
	let attempts = 0;
	const receiver = {value: 7};
	const wrapped = onetime(function (argument) {
		attempts++;
		if (attempts === 1) {
			throw error;
		}

		return [this.value, argument];
	});
	t.is(onetime.callCount(wrapped), 0);
	t.is(t.throws(() => wrapped.call(receiver, 1)), error);
	t.is(onetime.callCount(wrapped), 1);
	const result = wrapped.call(receiver, 2);
	t.deepEqual(result, [7, 2]);
	t.is(onetime.callCount(wrapped), 2);
	t.is(wrapped.call({value: 0}, 3), result);
	t.is(onetime.callCount(wrapped), 3);
	t.is(attempts, 2);
});

test('resolved and rejected promises retain identity', async t => {
	await Promise.all([false, true].map(async reject => {
		const error = new Error('promise');
		const promise = reject ? Promise.reject(error) : Promise.resolve(9);
		let calls = 0;
		const wrapped = onetime(() => {
			calls++;
			return promise;
		});
		const check = reject ? t.throwsAsync(promise, {is: error}) : t.notThrowsAsync(promise);
		t.is(wrapped(), promise);
		t.is(wrapped(), promise);
		await check;
		t.is(wrapped(), promise);
		t.is(calls, 1);
		t.is(onetime.callCount(wrapped), 3);
	}));
});
`)
 }
}
export async function mutate(task,root,id){
 const p=join(root,'index.js')
 if(id==='never-settled')await replace(p,'get: () => settled','get: () => false')
 if(id==='mutable-status')await replace(p,'enumerable: true','enumerable: true, configurable: true')
 if(id==='later-wins')await replace(p,'resolve(value);','queueMicrotask(() => resolve(value));')
 if(id==='drop-receiver-args')await replace(p,'function_.apply(this, arguments_)','function_()')
 if(id==='wrong-count')await replace(p,'calledFunctions.set(onetime, ++callCount);','calledFunctions.set(onetime, 0);')
 if(id==='drop-cache')await replace(p,'return returnValue;','return callCount > 1 ? undefined : returnValue;')
}
