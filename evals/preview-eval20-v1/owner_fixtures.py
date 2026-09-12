"""Owner-authored reference transforms, applied only to disposable qualification copies."""
import re


def replace(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError('Reference anchor drift: ' + before[:70])
    return text.replace(before, after)


def apply(task, root):
    slug = task['slug']
    file = root / ('source/index.ts' if slug.startswith('queue-') else 'base.js' if slug.startswith('query-') else 'index.js')
    text = file.read_text()
    if slug == 'queue-has-id':
        text = replace(text, '\t#pending = 0;', '\t#pending = 0;\n\n\treadonly #identifiedTasks = new Map<symbol, {id: string; running: boolean}>();\n\n\thas(id: string): boolean {\n\t\tfor (const task of this.#identifiedTasks.values()) {\n\t\t\tif (task.id === id) {\n\t\t\t\treturn true;\n\t\t\t}\n\t\t}\n\n\t\treturn false;\n\t}')
        text = replace(text, '\t\t// Create a copy to avoid mutating the original options object', '\t\tconst explicitId = options.id;\n\n\t\t// Create a copy to avoid mutating the original options object')
        text = replace(text, '\t\t\tconst run = async () => {', '\t\t\tconst run = async () => {\n\t\t\t\tconst tracked = this.#identifiedTasks.get(taskSymbol);\n\t\t\t\tif (tracked) {\n\t\t\t\t\ttracked.running = true;\n\t\t\t\t}\n')
        text = replace(text, '\t\t\t\t\tconst result = await operation;', '\t\t\t\t\tconst result = await operation;\n\t\t\t\t\tthis.#identifiedTasks.delete(taskSymbol);')
        text = replace(text, '\t\t\t\t} catch (error: unknown) {', '\t\t\t\t} catch (error: unknown) {\n\t\t\t\t\tthis.#identifiedTasks.delete(taskSymbol);')
        text = replace(text, '\t\t\tthis.#queue.enqueue(run, options);', '''\t\t\tif (explicitId !== undefined) {
				this.#identifiedTasks.set(taskSymbol, {id: explicitId, running: false});
			}

			try {
				this.#queue.enqueue(run, options);
			} catch (error) {
				this.#identifiedTasks.delete(taskSymbol);
				throw error;
			}''')
        text = replace(text, '\t\t\t\tconst queueAbortHandler = () => {', '\t\t\t\tconst queueAbortHandler = () => {\n\t\t\t\t\tthis.#identifiedTasks.delete(taskSymbol);')
        text = replace(text, '\tclear(): void {', '\tclear(): void {\n\t\tfor (const [key, task] of this.#identifiedTasks) {\n\t\t\tif (!task.running) {\n\t\t\t\tthis.#identifiedTasks.delete(key);\n\t\t\t}\n\t\t}\n')
        docs = root / 'readme.md'
        docs.write_text(docs.read_text() + '\n### has(id)\n\nReturns whether at least one task with this explicit id is queued or running. Duplicate ids remain present until all matching tasks finish or abort. clear() removes queued matches and retains running ones. This query does not change queue order or counters and supports custom queues. Automatically generated ids are not included.\n')
    elif slug == 'uri-resolve-many':
        text = replace(text, 'const fastUri = {', 'function resolveMany (base, references, options) {\n  return Array.from(references, reference => resolve(base, reference, options))\n}\n\nconst fastUri = {\n  resolveMany,')
        types = root / 'types/index.d.ts'
        types.write_text(replace(types.read_text(), 'declare namespace fastUri {', 'declare namespace fastUri {\n  export function resolveMany (base: string, references: Iterable<string>, options?: Options): string[]'))
        docs = root / 'README.md'
        docs.write_text(docs.read_text() + '\n### resolveMany(base, references, options)\n\nResolves each reference independently against the same base, in iteration order. Accepts any iterable of strings and returns a string array. Options are forwarded to resolve; iteration and resolution errors propagate.\n')
    elif slug == 'normalize-query-predicate':
        anchor = '\t// Remove query unwanted parameters'
        text = replace(text, anchor, '''\tif (!hasKeepQueryParameters && typeof options.removeQueryParameters === 'function') {
		const kept = [...searchParams].filter(([name, value]) => !options.removeQueryParameters(decodeReservedTokens(name, encodedReservedTokenRegex), decodeReservedTokens(value, encodedReservedTokenRegex)));
		urlObject.search = '';
		for (const [name, value] of kept) {
			searchParams.append(name, value);
		}
	}

''' + anchor)
        types = root / 'index.d.ts'
        types.write_text(replace(types.read_text(), 'readonly removeQueryParameters?: ReadonlyArray<RegExp | string> | boolean;', 'readonly removeQueryParameters?: ReadonlyArray<RegExp | string> | boolean | ((name: string, value: string) => boolean);'))
        docs = root / 'readme.md'
        docs.write_text(docs.read_text() + '\n### removeQueryParameters predicate\n\nA function `(name, value) => boolean` removes individual query pairs for which it returns true. Duplicate names are evaluated for each value. Names and values are decoded. An explicit keepQueryParameters array takes precedence. Array, regular expression and boolean forms retain their existing behavior.\n')
    elif slug == 'map-validation-helper':
        start = text.index("\tif (typeof mapper !== 'function')", text.index('export function pMapIterable'))
        end = text.index('\n\tif (!((Number.isSafeInteger(backpressure)', start)
        block = text[start:end].rstrip()
        if text.count(block) != 1 or text.count('\n'.join('\t'+line if line else '' for line in block.splitlines())) != 1:
            raise RuntimeError('Duplicated validation source changed')
        indented = '\n'.join('\t'+line if line else '' for line in block.splitlines())
        text = text.replace(indented, '\t\tvalidateMapperOptions(mapper, concurrency);').replace(block, '\tvalidateMapperOptions(mapper, concurrency);')
        text = 'function validateMapperOptions(mapper, concurrency) {\n' + block + '\n}\n\n' + text
    elif slug == 'query-value-helper':
        start = text.index('function parseValue(value, options, type) {')
        fallback = text.index('\tif (options.parseBooleans', start)
        end = text.index('\nexport function extract(', fallback)
        explicit = text[start:fallback].replace('function parseValue(', 'function parseExplicitValue(')
        explicit = re.sub(r'return (.*);', r'return {matched: true, value: \1};', explicit)
        explicit = explicit.replace('value: value}', 'value}')
        explicit += '\treturn {matched: false};\n}\n\n'
        fallback_text = 'function parseFallbackValue(value, options) {\n' + text[fallback:end]
        dispatcher = '''function parseValue(value, options, type) {
	const explicit = parseExplicitValue(value, options, type);
	return explicit.matched ? explicit.value : parseFallbackValue(value, options);
}
'''
        text = text[:start] + explicit + fallback_text + '\n' + dispatcher + text[end:]
    elif slug == 'normalize-data-helper':
        start = text.index("\tconst mediaType = type.split(';');")
        end = text.index('\n\tconst hashPart =', start)
        body = text[start:end]
        text = text[:start] + '\tconst {normalizedMediaType, isBase64} = normalizeDataMetadata(type);\n' + text[end:]
        helper = 'const normalizeDataMetadata = type => {\n' + body + '\n\treturn {normalizedMediaType, isBase64};\n};\n\n'
        text = replace(text, 'const normalizeDataURL =', helper + 'const normalizeDataURL =')
    elif slug == 'normalize-query-helper':
        start = text.index('\tconst hasKeepQueryParameters =')
        end = text.index('\n\t// Normalize empty query parameter values', start)
        body = text[start:end].rstrip()
        text = text[:start] + '\tnormalizeQueryParameters(urlObject, options, encodedReservedTokenRegex);\n' + text[end:]
        helper = 'const normalizeQueryParameters = (urlObject, options, encodedReservedTokenRegex) => {\n' + body + '\n};\n\n'
        text = replace(text, 'export default function normalizeUrl(', helper + 'export default function normalizeUrl(')
    elif slug == 'map-iterable-signal':
        begin = text.index('export function pMapIterable(')
        head, body = text[:begin], text[begin:]
        body = replace(body, '\t\tbackpressure = concurrency,', '\t\tbackpressure = concurrency,\n\t\tsignal,')
        body = replace(body, '\t\tasync * [Symbol.asyncIterator]() {', '\t\tasync * [Symbol.asyncIterator]() {\n\t\t\tsignal?.throwIfAborted();')
        body = replace(body, '\t\t\tlet index = 0;', '''\t\t\tlet index = 0;
			let rejectAbort;
			const aborted = new Promise((resolve, reject) => {
				rejectAbort = reject;
			});
			aborted.catch(() => {});

			const onAbort = () => {
				isDone = true;
				rejectAbort(signal.reason);
			};

			signal?.addEventListener('abort', onAbort, {once: true});''')
        body = replace(body, '\t\t\t\t\t\tconst returnValue = await mapper(await value, currentIndex);', '\t\t\t\t\t\tconst input = await value;\n\t\t\t\t\t\tsignal?.throwIfAborted();\n\t\t\t\t\t\tif (isDone) {\n\t\t\t\t\t\t\tpendingPromisesCount--;\n\t\t\t\t\t\t\treturn {done: true};\n\t\t\t\t\t\t}\n\n\t\t\t\t\t\tconst returnValue = await mapper(input, currentIndex);')
        start = body.index('\n\t\t\ttrySpawn();\n\n\t\t\twhile')
        end = body.index('\n\t\t},', start)
        loop = body[start:end].rstrip().lstrip('\n').replace('await promises[0]', 'await Promise.race([promises[0], aborted])')
        body = body[:start] + '\n\t\t\ttry {\n' + '\n'.join('\t'+line if line else '' for line in loop.splitlines()) + "\n\t\t\t} finally {\n\t\t\t\tisDone = true;\n\t\t\t\tsignal?.removeEventListener('abort', onAbort);\n\t\t\t}" + body[end:]
        text = head + body
        types = root / 'index.d.ts'
        types.write_text(replace(types.read_text(), 'export type IterableOptions = BaseOptions & {', 'export type IterableOptions = BaseOptions & {\n\t/** Abort iteration and reject pending consumer reads with signal.reason. */\n\treadonly signal?: AbortSignal | undefined;\n'))
        docs = root / 'readme.md'
        docs.write_text(docs.read_text() + '\n### pMapIterable signal\n\nThe optional AbortSignal stops scheduling new mapper calls and rejects pending consumer reads with its reason. An already-aborted signal performs no iteration. Already-started mapper calls may finish; their rejections are handled. Abort listeners are removed when consumption completes or is cancelled.\n')
    else:
        raise NotImplementedError(slug)
    file.write_text(text)
