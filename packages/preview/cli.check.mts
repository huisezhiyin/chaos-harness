import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,realpath,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {main} from './cli.mjs'
import {pluginPath} from './environment.mjs'
const exec=promisify(execFile)
const profile={apiKey:'fixture-only',baseUrl:'http://127.0.0.1:1/v1',model:'fixture'}
test('daily preview routes exact managed environment and preserves TUI exit and cleanup',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'chaos-preview-entry-'))),root=join(base,'repo'),state=join(base,'state'),binary=join(base,'host')
 try{
  await mkdir(root);await mkdir(state);await exec('git',['init','--quiet',root])
  await writeFile(binary,`#!${process.execPath}\nconst c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({...c,plugin_origins:c.plugin.map(spec=>({spec}))}));\n`,{mode:0o700})
  let closed=0,disposed=0,ran=0;const records:any[]=[]
  const code=await main(['--root',root,'--state-dir',state],{platform:'darwin',daily:{qwenProfileLoader:async()=>profile,opencodeCommand:binary,stdout:()=>{},stderr:()=>{},recordQwenEvent:async(_p,e)=>{records.push(e)}},host:{readVersion:async()=> '1.18.27',prepareHostProfile:async()=>({env:{PATH:dirname(process.execPath)+':/usr/bin:/bin'},dispose:async()=>{disposed++}}),startBridge:async()=>({baseUrl:'http://127.0.0.1:1/v1',apiKey:'local-only',observationToken:'f'.repeat(64),close:async()=>{closed++}}),runTui:async input=>{
   ran++;const config=JSON.parse(input.env.OPENCODE_CONFIG_CONTENT!)
   assert.equal(config.plugin.length,2);assert.equal(config.plugin[1],pluginPath)
   assert.equal(input.env.CHAOS_RUNTIME_WORKSPACE_ROOT,root)
   assert(input.env.TMPDIR!.startsWith(state+'/runtime-'))
   assert(input.env.NODE_COMPILE_CACHE!.startsWith(state+'/runtime-'))
   assert.equal(input.env.DASHSCOPE_API_KEY,undefined)
   assert.deepEqual(await readdir(join(root,'test/.chaos-tmp')),[])
   return 7
  }}})
  assert.equal(code,7);assert.equal(ran,1);assert.equal(closed,1);assert.equal(disposed,1)
  assert(records.some(e=>e.event==='session_ended'&&e.exitCode===7))
 }finally{await rm(base,{recursive:true,force:true})}
})
test('help and profile check do not prepare workspaces or launch Hosts',async()=>{
 let prepared=0,launched=0
 const daily:any={qwenProfileLoader:async()=>profile,prepare:async()=>{prepared++;throw Error('unexpected')},qwenLauncher:async()=>{launched++;return 0},stdout:()=>{},stderr:()=>{}}
 assert.equal(await main(['--help'],{daily,platform:'linux'}),0)
 assert.equal(await main(['--check-profile'],{daily,platform:'darwin'}),0)
 assert.equal(prepared,0);assert.equal(launched,0)
 assert.equal(await main([],{daily,platform:'linux'}),2)
})
test('Host profile drift fails before TUI, closes resources, preserves workspace files',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'chaos-preview-drift-'))),root=join(base,'repo'),state=join(base,'state'),binary=join(base,'host')
 try{
  await mkdir(root);await mkdir(state);await exec('git',['init','--quiet',root]);await writeFile(join(root,'keep.txt'),'user work')
  await writeFile(binary,`#!${process.execPath}\nconst c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);c.plugin.push('/untrusted');console.log(JSON.stringify({...c,plugin_origins:c.plugin.map(spec=>({spec}))}));\n`,{mode:0o700})
  let ran=0,closed=0,disposed=0
  const code=await main(['--root',root,'--state-dir',state],{platform:'darwin',daily:{qwenProfileLoader:async()=>profile,opencodeCommand:binary,confirmDirty:async()=>true,stdout:()=>{},stderr:()=>{},recordQwenEvent:async()=>{}},host:{readVersion:async()=> '1.18.27',prepareHostProfile:async()=>({env:{},dispose:async()=>{disposed++}}),startBridge:async()=>({baseUrl:'http://127.0.0.1:1/v1',apiKey:'local-only',observationToken:'f'.repeat(64),close:async()=>{closed++}}),runTui:async()=>{ran++;return 0}}})
  assert.equal(code,1);assert.equal(ran,0);assert.equal(closed,1);assert.equal(disposed,1)
  assert.equal(await readFile(join(root,'keep.txt'),'utf8'),'user work')
 }finally{await rm(base,{recursive:true,force:true})}
})
