"""New tests used as reference deliveries for the four test-only tasks."""
TESTS = {
    'map-aborted-listener': '''import {getEventListeners} from 'node:events';
import test from 'ava';
import pMap from '../index.js';

test('already aborted input leaves no listeners or mapper calls', async t => {
	const controller = new AbortController();
	const reason = new Error('cancel');
	controller.abort(reason);
	let calls = 0;
	await t.throwsAsync(pMap([1], () => {
		calls++;
	}, {signal: controller.signal}), {is: reason});
	t.is(calls, 0);
	t.is(getEventListeners(controller.signal, 'abort').length, 0);
});
''',
    'map-iterable-index': '''import test from 'ava';
import {pMapIterable} from '../index.js';

test('mapper indices remain source positions', async t => {
	const output = [];
	for await (const value of pMapIterable([Promise.resolve('a'), Promise.resolve('b')], (value, index) => [value, index])) {
		output.push(value);
	}

	t.deepEqual(output, [['a', 0], ['b', 1]]);
});
''',
    'map-iterable-signal': '''import {getEventListeners} from 'node:events';
import test from 'ava';
import {pMapIterable} from '../index.js';

test('iterable rejects cancellation reason and releases listener', async t => {
	const controller = new AbortController();
	const reason = new Error('cancel');
	controller.abort(reason);
	const iterator = pMapIterable([1], value => value, {signal: controller.signal})[Symbol.asyncIterator]();
	await t.throwsAsync(iterator.next(), {is: reason});
	t.is(getEventListeners(controller.signal, 'abort').length, 0);
});
''',
    'map-validation-helper': '''import test from 'ava';
import pMap, {pMapIterable} from '../index.js';

test('both mapping APIs reject invalid concurrency', async t => {
	await t.throwsAsync(pMap([], value => value, {concurrency: 0}), {instanceOf: TypeError});
	t.throws(() => pMapIterable([], value => value, {concurrency: 0}), {instanceOf: TypeError});
});
''',
    'queue-size-wakeup': '''import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import PQueue from '../source/index.js';

test('size waiter wakes before running work finishes', async () => {
	const queue = new PQueue({concurrency: 2, autoStart: false});
	const barrier = Promise.withResolvers<void>();
	const jobs = Array.from({length: 3}, async () => queue.add(async () => barrier.promise));
	let notified = false;
	const waiting = (async () => {
		await queue.onSizeLessThan(2);
		notified = true;
	})();
	queue.start();
	await nextTurn();
	try {
		assert.equal(notified, true);
	} finally {
		barrier.resolve();
		await Promise.all(jobs);
		await waiting;
	}
});
''',
    'queue-timeout-validation': '''import {test} from 'node:test';
import assert from 'node:assert/strict';
import PQueue from '../source/index.js';

test('invalid per-task timeout rejects before invocation', async () => {
	const queue = new PQueue();
	let called = false;
	await assert.rejects(queue.add(() => {
		called = true;
	}, {timeout: 0}), TypeError);
	assert.equal(called, false);
	assert.equal(queue.size, 0);
});
''',
    'queue-has-id': '''import {test} from 'node:test';
import assert from 'node:assert/strict';
import PQueue from '../source/index.js';

test('identified task is present while queued and absent after completion', async () => {
	const queue = new PQueue({autoStart: false});
	const job = queue.add(() => 1, {id: 'task'});
	assert.equal(queue.has('task'), true);
	queue.start();
	await job;
	await queue.onIdle();
	assert.equal(queue.has('task'), false);
});
''',
    'query-own-types': '''import test from 'ava';
import queryString from '../index.js';

test('prototype names remain query data while own types apply', t => {
	t.is(queryString.parse('toString=value', {types: {}}).toString, 'value');
	t.is(queryString.parse('n=2', {types: {n: 'number'}}).n, 2);
});
''',
    'query-relative-fragment': '''import test from 'ava';
import queryString from '../index.js';

test('relative URL selection preserves its fragment', t => {
	t.is(queryString.pick('/a?x=1&y=2#part', ['x']), '/a?x=1#part');
	t.is(queryString.exclude('/a?x=1&y=2#part', ['y']), '/a?x=1#part');
});
''',
    'query-value-helper': '''import test from 'ava';
import queryString from '../index.js';

test('explicit conversion takes precedence over global parsing', t => {
	t.is(queryString.parse('x=012', {types: {x: 'string'}, parseNumbers: true}).x, '012');
	t.is(queryString.parse('x=2', {types: {x: value => `custom:${value}`}, parseNumbers: true}).x, 'custom:2');
});
''',
    'normalize-query-predicate': '''import test from 'ava';
import normalizeUrl from '../index.js';

test('predicate removes matching duplicate values only', t => {
	t.is(normalizeUrl('https://example.com/?x=1&x=2', {removeQueryParameters: (name, value) => name === 'x' && value === '2'}), 'https://example.com/?x=1');
});
''',
    'normalize-data-helper': '''import test from 'ava';
import normalizeUrl from '../index.js';

test('data metadata normalizes without changing payload bytes', t => {
	t.is(normalizeUrl('data:TEXT/PLAIN;charset=US-ASCII,AbC%2f'), 'data:,AbC%2f');
	t.is(normalizeUrl('data:TEXT/HTML;charset=UTF-8,AbC'), 'data:text/html;charset=utf-8,AbC');
});
''',
    'normalize-query-helper': '''import test from 'ava';
import normalizeUrl from '../index.js';

test('query filtering retains escaped reserved characters', t => {
	t.is(normalizeUrl('https://example.com/?x=%2F&drop=1', {removeQueryParameters: ['drop']}), 'https://example.com/?x=%2F');
	t.is(normalizeUrl('https://example.com/?z=1&a=2', {sortQueryParameters: false}), 'https://example.com/?z=1&a=2');
});
''',
    'uri-reserved-path': ''''use strict'

const test = require('tape')
const uri = require('..')

test('literal and escaped reserved path characters stay distinct', t => {
  t.equal(uri.serialize({ scheme: 'http', host: 'example.com', path: '/a;b' }), 'http://example.com/a;b')
  t.equal(uri.serialize({ scheme: 'http', host: 'example.com', path: '/a%3Ab' }), 'http://example.com/a%3Ab')
  t.end()
})
''',
    'uri-component-case': ''''use strict'

const test = require('tape')
const uri = require('..')

test('URI comparison preserves path case while normalizing host case', t => {
  t.equal(uri.equal('http://EXAMPLE.com/a', 'http://example.com/a'), true)
  t.equal(uri.equal('http://example.com/A', 'http://example.com/a'), false)
  t.end()
})
''',
    'uri-resolve-many': ''''use strict'

const test = require('tape')
const uri = require('..')

test('multiple references resolve independently in order', t => {
  t.deepEqual(uri.resolveMany('http://example.com/a/b', ['../c', 'd']), ['http://example.com/c', 'http://example.com/a/d'])
  t.deepEqual(uri.resolveMany('http://example.com/a/b', []), [])
  t.end()
})
''',
    'queue-priority-lifecycle': '''import {test} from 'node:test';
import assert from 'node:assert/strict';
import PQueue from '../source/index.js';

test('stable ties and explicit queued priority updates', async () => {
	const queue = new PQueue({concurrency: 1, autoStart: false});
	const order: string[] = [];
	const jobs = ['a', 'b', 'c'].map(async id => queue.add(() => {
		order.push(id);
	}, {id, priority: 1}));
	queue.setPriority('c', 2);
	queue.start();
	await Promise.all(jobs);
	await queue.onIdle();
	assert.deepEqual(order, ['c', 'a', 'b']);
	assert.equal(queue.size, 0);
	assert.equal(queue.pending, 0);
});

test('pause and rejection preserve queued and running counts', async () => {
	const queue = new PQueue({concurrency: 1, autoStart: false});
	const barrier = Promise.withResolvers<void>();
	const first = queue.add(async () => barrier.promise);
	const error = new Error('expected');
	const second = queue.add(() => {
		throw error;
	});
	const rejection = assert.rejects(second, candidate => candidate === error);
	assert.equal(queue.size, 2);
	assert.equal(queue.pending, 0);
	queue.start();
	assert.equal(queue.size, 1);
	assert.equal(queue.pending, 1);
	queue.pause();
	barrier.resolve();
	await first;
	await queue.onPendingZero();
	assert.equal(queue.size, 1);
	assert.equal(queue.pending, 0);
	queue.start();
	await rejection;
	await queue.onIdle();
	assert.equal(queue.pending, 0);
	assert.equal(queue.size, 0);
});
''',
    'query-replacer-arrays': '''import test from 'ava';
import queryString from '../index.js';

test('replacer observes falsy and array values before serialization', t => {
	const calls = [];
	const result = queryString.stringify({
		a: [0, false],
		b: null,
		c: undefined,
		d: '',
	}, {
		sort: false,
		replacer(key, value) {
			calls.push([key, value]);
			return key === 'b' ? 'replaced' : value;
		},
	});
	t.deepEqual(calls, [['a', [0, false]], ['a[0]', 0], ['a[1]', false], ['b', null], ['c', undefined], ['d', '']]);
	t.is(result, 'a=0&a=false&b=replaced&d=');
});

test('skip options retain zero and false while removing null and empty output', t => {
	t.is(queryString.stringify({
		a: null,
		b: '',
		c: 0,
		d: false,
		e: undefined,
	}, {skipNull: true, skipEmptyString: true}), 'c=0&d=false');
	t.is(queryString.stringify({a: 1, b: 2}, {replacer: (key, value) => key === 'a' ? undefined : value}), 'b=2');
});
''',
    'normalize-options-interactions': '''import test from 'ava';
import normalizeUrl from '../index.js';

test('keep list wins over remove-all and preserves duplicate order without sorting', t => {
	t.is(normalizeUrl('https://example.com/?z=1&a=2&z=3', {keepQueryParameters: ['z'], removeQueryParameters: true, sortQueryParameters: false}), 'https://example.com/?z=1&z=3');
	t.is(normalizeUrl('https://example.com/?z=1&a=2&z=3', {removeQueryParameters: false, sortQueryParameters: false}), 'https://example.com/?z=1&a=2&z=3');
	t.is(normalizeUrl('https://example.com/?z=1', {keepQueryParameters: [], removeQueryParameters: false}), 'https://example.com');
});

test('hash stripping takes precedence over text-fragment preservation', t => {
	const url = 'https://example.com/a#section:~:text=Hello';
	t.is(normalizeUrl(url, {stripHash: true, stripTextFragment: false}), 'https://example.com/a');
	t.is(normalizeUrl(url, {stripHash: false, stripTextFragment: true}), 'https://example.com/a#section');
	t.is(normalizeUrl(url, {stripHash: false, stripTextFragment: false}), url);
});
''',
    'uri-resolution-components': ''''use strict'

const test = require('tape')
const uri = require('..')

test('resolution preserves escaped delimiters and explicit empty components', t => {
  const base = 'http://example.com/a/b?old#before'
  t.equal(uri.resolve(base, '../x%2Fy'), 'http://example.com/x%2Fy')
  t.equal(uri.resolve(base, '../x/y'), 'http://example.com/x/y')
  t.equal(uri.resolve(base, '?'), 'http://example.com/a/b?')
  t.equal(uri.resolve(base, '#'), 'http://example.com/a/b?old#')
  t.equal(uri.resolve(base, '%E4%B8%AD?x=%26#%23'), 'http://example.com/a/%E4%B8%AD?x=%26#%23')
  t.end()
})
''',
}


def apply(task, root):
    path = root / task['delivery']['requiredNewTestFile']
    if path.exists():
        raise RuntimeError('New regression filename already exists')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(TESTS[task['slug']])
