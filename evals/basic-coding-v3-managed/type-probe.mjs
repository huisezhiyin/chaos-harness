// Use the identity-bound Harness compiler; no ambient Node typings are needed.
import ts from 'typescript'
import {join} from 'node:path'
const root=process.argv[2],file=join(root,'test/owner-defer.ts')
const program=ts.createProgram([file],{noEmit:true,strict:true,types:[],target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext})
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?.fileName,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}))
console.log(JSON.stringify({diagnostics}))
if(diagnostics.length)process.exitCode=1
