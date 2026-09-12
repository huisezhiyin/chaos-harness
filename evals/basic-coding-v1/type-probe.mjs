import {createRequire} from 'node:module'
import {join} from 'node:path'
const root=process.argv[2],require=createRequire(import.meta.url)
// tsd 0.17's CLI ignores --files. Its public API supports explicit testFiles.
const tsd=require(join(root,'node_modules/tsd')).default
const diagnostics=await tsd({cwd:root,testFiles:['test/owner-queue.test-d.ts']})
console.log(JSON.stringify({testFile:'test/owner-queue.test-d.ts',diagnostics}))
if(diagnostics.length)process.exitCode=1
