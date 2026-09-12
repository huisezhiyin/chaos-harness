import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,realpath,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {launchUsingPreview} from './runtime.mjs'
import {pluginPath} from '../../packages/preview/environment.mjs'
const exec=promisify(execFile)
test('evaluation traverses product preparation and preserves verifier, budget and Host cleanup',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'chaos-eval20-runtime-'))),root=join(base,'repo'),state=join(base,'state'),binary=join(base,'host')
 try{
  await mkdir(root);await mkdir(state);await exec('git',['init','--quiet',root])
  await writeFile(binary,`#!${process.execPath}\nconst c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({...c,plugin_origins:c.plugin.map(spec=>({spec}))}));\n`,{mode:0o700})
  let closed=0,ran=0
  const verifier={id:'fixture-verifier',verify:async()=>({passed:true as const})},budget={maxTurns:12,maxActions:20}
  const code=await launchUsingPreview({root,profile:{apiKey:'fixture-only',baseUrl:'http://127.0.0.1:1/v1',model:'fixture'},opencodeCommand:binary,completionVerifier:verifier,attemptBudget:budget},state,{
   readVersion:async()=> '1.18.27',prepareHostProfile:async()=>({env:{},dispose:async()=>{}}),
   startBridge:async options=>{assert.equal(options.completionVerifier,verifier);assert.equal(options.attemptBudget,budget);return {baseUrl:'http://127.0.0.1:1/v1',apiKey:'local-only',observationToken:'f'.repeat(64),close:async()=>{closed++}}},
   runTui:async input=>{ran++;assert.equal(JSON.parse(input.env.OPENCODE_CONFIG_CONTENT!).plugin[1],pluginPath);assert(input.env.TMPDIR!.startsWith(state+'/runtime-'));assert.equal(input.env.CHAOS_RUNTIME_WORKSPACE_ROOT,root);assert.deepEqual(await readdir(join(root,'test/.chaos-tmp')),[]);return 9},
  })
  assert.equal(code,9);assert.equal(ran,1);assert.equal(closed,1)
 }finally{await rm(base,{recursive:true,force:true})}
})
