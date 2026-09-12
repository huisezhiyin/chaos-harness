"""Independent behavioral fault injections for disposable reference copies."""
MUTANTS = {
    'map-aborted-listener': [
        ('early-abort-ignored', 'index.js', 'if (signal.aborted)', 'if (false)'),
        ('listener-cleanup-broken', 'index.js', "signal?.removeEventListener('abort', signalListener);", "signal?.addEventListener('abort', signalListener);")],
    'map-iterable-index': [
        ('constant-index', 'index.js', 'const currentIndex = index++;', 'const currentIndex = 0;'),
        ('settlement-order-index', 'index.js', 'const currentIndex = index++;\n\t\t\t\t\t\tconst returnValue = await mapper(await value, currentIndex);', 'const resolvedValue = await value;\n\t\t\t\t\t\tconst currentIndex = index++;\n\t\t\t\t\t\tconst returnValue = await mapper(resolvedValue, currentIndex);')],
    'queue-size-wakeup': [
        ('completion-only-wakeup', 'source/index.ts', "this.#onEvent(['next', 'active'],", "this.#onEvent(['next'],"),
        ('non-strict-threshold', 'source/index.ts', 'this.#queue.size < limit', 'this.#queue.size <= limit')],
    'queue-timeout-validation': [
        ('zero-bypass', 'source/index.ts', 'options.timeout !== undefined && !(Number.isFinite(options.timeout)', 'options.timeout !== undefined && options.timeout !== 0 && !(Number.isFinite(options.timeout)'),
        ('negative-bypass', 'source/index.ts', 'options.timeout !== undefined && !(Number.isFinite(options.timeout)', 'options.timeout !== undefined && options.timeout >= 0 && !(Number.isFinite(options.timeout)')],
    'query-own-types': [
        ('inherited-types', 'base.js', 'options.types = {__proto__: null, ...options.types};', 'options.types = {...options.types};'),
        ('own-types-dropped', 'base.js', 'options.types = {__proto__: null, ...options.types};', 'options.types = {__proto__: null};')],
    'query-relative-fragment': [
        ('fragment-dropped', 'base.js', 'urlObjectForFragmentEncode.hash = object.fragmentIdentifier;', "urlObjectForFragmentEncode.hash = '';"),
        ('fragment-double-encoded', 'base.js', 'urlObjectForFragmentEncode.hash = object.fragmentIdentifier;', 'urlObjectForFragmentEncode.hash = encodeURIComponent(encodeURIComponent(object.fragmentIdentifier));')],
    'uri-reserved-path': [
        ('literal-semicolon-escaped', 'lib/utils.js', "if (isPathCharacter(ch) && (ch !== ':' || !firstSegment))", "if (ch !== ';' && isPathCharacter(ch) && (ch !== ':' || !firstSegment))"),
        ('reserved-escape-opened', 'index.js', 'serializePathEncoding(component.path, pathNoScheme)', 'serializePathEncoding(decodeURIComponent(component.path), pathNoScheme)')],
    'uri-component-case': [
        ('whole-uri-lowercased', 'index.js', 'normalizedA === normalizedB', 'normalizedA.toLowerCase() === normalizedB.toLowerCase()'),
        ('normalization-bypassed', 'index.js', 'normalizedA === normalizedB', 'uriA === uriB')],
    'map-iterable-signal': [
        ('already-aborted-iteration', 'index.js', '\t\t\tsignal?.throwIfAborted();', ''),
        ('listener-leak', 'index.js', "signal?.removeEventListener('abort', onAbort);", "signal?.addEventListener('abort', onAbort);")],
    'queue-has-id': [
        ('queued-only', 'source/index.ts', 'if (task.id === id)', 'if (task.id === id && !task.running)'),
        ('stale-completed', 'source/index.ts', 'this.#identifiedTasks.delete(taskSymbol);', 'void taskSymbol;')],
    'normalize-query-predicate': [
        ('predicate-ignored', 'index.js', "typeof options.removeQueryParameters === 'function'", 'false'),
        ('value-not-forwarded', 'index.js', 'decodeReservedTokens(value, encodedReservedTokenRegex)', "''")],
    'uri-resolve-many': [
        ('chained-base', 'index.js', 'reference => resolve(base, reference, options)', 'reference => (base = resolve(base, reference, options))'),
        ('reversed-results', 'index.js', 'return Array.from(references, reference => resolve(base, reference, options))', 'return Array.from(references, reference => resolve(base, reference, options)).reverse()')],
    'map-validation-helper': [
        ('zero-concurrency', 'index.js', 'concurrency >= 1', 'concurrency >= 0'),
        ('null-mapper-accepted', 'index.js', "typeof mapper !== 'function'", 'mapper === undefined')],
    'query-value-helper': [
        ('converter-bypass', 'base.js', 'value: type(value)', 'value'),
        ('explicit-type-loses', 'base.js', "type === 'string' && typeof value === 'string'", "false && typeof value === 'string'")],
    'normalize-data-helper': [
        ('payload-lowercase', 'index.js', 'data.trim() : data}', 'data.trim() : data.toLowerCase()}'),
        ('default-mime-retained', 'index.js', 'mimeType !== DATA_URL_DEFAULT_MIME_TYPE', 'mimeType === DATA_URL_DEFAULT_MIME_TYPE')],
    'normalize-query-helper': [
        ('unconditional-sort', 'index.js', 'if (options.sortQueryParameters) {', 'if (true) {'),
        ('removal-ignored', 'index.js', 'if (testParameter(decodeReservedTokens(key, encodedReservedTokenRegex), options.removeQueryParameters))', 'if (false && testParameter(decodeReservedTokens(key, encodedReservedTokenRegex), options.removeQueryParameters))')],
    'queue-priority-lifecycle': [
        ('ties-reversed', 'source/priority-queue.ts', 'this.#queue.push(element);\n\t\t\treturn;\n\t\t}\n\n\t\t// Binary insertion', 'this.#queue.splice(this.#head, 0, element);\n\t\t\treturn;\n\t\t}\n\n\t\t// Binary insertion'),
        ('priority-ignored', 'source/priority-queue.ts', 'setPriority(id: string, priority: number) {', 'setPriority(id: string, priority: number) {\n\t\treturn;'),
        ('pending-count', 'source/index.ts', 'return this.#pending;', 'return this.#pending + 1;')],
    'query-replacer-arrays': [
        ('replacer-ignored', 'base.js', 'if (options.replacer)', 'if (false)'),
        ('skip-all-values', 'base.js', 'options.skipNull && isNullOrUndefined(object[key])', 'options.skipNull && true')],
    'normalize-options-interactions': [
        ('remove-overrides-keep', 'index.js', '!hasKeepQueryParameters && options.removeQueryParameters === true', 'options.removeQueryParameters === true'),
        ('unconditional-sort', 'index.js', 'if (options.sortQueryParameters) {', 'if (true) {')],
    'uri-resolution-components': [
        ('empty-query-dropped', 'index.js', 'if (relative.query !== undefined)', 'if (relative.query)'),
        ('empty-fragment-dropped', 'index.js', 'target.fragment = relative.fragment', 'target.fragment = relative.fragment || base.fragment')],
}


def apply(task, root, mutant):
    name, file, before, after = mutant
    path = root / file
    original = path.read_text()
    if before not in original:
        raise RuntimeError('Mutant source anchor missing: ' + name)
    path.write_text(original.replace(before, after))
    return path, original
