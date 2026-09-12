import ts from 'typescript'
import {join} from 'node:path'

const [root,slug]=process.argv.slice(2)
const cases={
 'map-iterable-signal': `import {pMapIterable} from '../index.js';
const output: AsyncIterable<number> = pMapIterable([1], value => value + 1, {signal: new AbortController().signal});
// @ts-expect-error invalid signal
pMapIterable([1], value => value, {signal: 'invalid'});
void output;`,
 'queue-has-id': `import PQueue from '../source/index.js';
const queue = new PQueue();
const result: boolean = queue.has('id');
// @ts-expect-error id must be a string
queue.has(1);
void result;`,
 'normalize-query-predicate': `import normalizeUrl from '../index.js';
const output: string = normalizeUrl('https://example.com', {removeQueryParameters: (name, value) => name.length > value.length});
// @ts-expect-error predicate must return boolean
normalizeUrl('https://example.com', {removeQueryParameters: (name: string, value: string) => name + value});
void output;`,
 'uri-resolve-many': `import uri from '../types/index.js';
const output: string[] = uri.resolveMany('https://example.com', new Set(['a','b']), {skipEscape: true});
// @ts-expect-error references must be strings
uri.resolveMany('https://example.com', [1]);
void output;`,
}
if (!cases[slug]) throw new Error('Unknown type contract')
const filename=join(root,'test','owner-type-contract.ts')
const options={noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:slug==='queue-has-id'?['node']:[],typeRoots:[join(root,'node_modules/@types')]}
const host=ts.createCompilerHost(options)
const originalRead=host.readFile.bind(host),originalExists=host.fileExists.bind(host)
host.readFile=path=>path===filename?cases[slug]:originalRead(path)
host.fileExists=path=>path===filename||originalExists(path)
const program=ts.createProgram([filename],options,host)
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({code:d.code,file:d.file?.fileName.startsWith(root)?d.file.fileName.slice(root.length+1):'toolchain',message:ts.flattenDiagnosticMessageText(d.messageText,' ')}))
console.log(JSON.stringify({passed:diagnostics.length===0,slug,compiler:ts.version,diagnostics}))
process.exitCode=diagnostics.length?1:0
