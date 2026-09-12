import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {launchUsingPreview} from './runtime.mjs'
import {startOpenCodeQwenLoopBridge,QWEN_LOOP_MODEL_ID} from '../../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import {encodeOpenCodeToolObservation} from '../../packages/adapters/opencode-codex-bridge/src/opencode-observation-envelope.js'
const exec=promisify(execFile)
const directory=new URL('.',import.meta.url).pathname
async function exercise(timeout:number|undefined,verify:(context:any)=>Promise<any>){
 const temp=await realpath(await mkdtemp(join(tmpdir(),'eval16-online-'))),root=join(temp,'repo'),state=join(temp,'state'),binary=join(temp,'host'),events:any[]=[]
 let bridge:any
 try{
  await mkdir(root);await mkdir(state);await exec('git',['init','--quiet',root]);await writeFile(join(root,'README.md'),'fixture');await exec('git',['add','README.md'],{cwd:root});const tree=(await exec('git',['write-tree'],{cwd:root})).stdout.trim();const head=(await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit-tree',tree,'-m','fixture'],{cwd:root})).stdout.trim();await exec('git',['update-ref','--no-deref','HEAD',head],{cwd:root})
  await writeFile(binary,`#!${process.execPath}\nconst c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({...c,plugin_origins:c.plugin.map(spec=>({spec}))}));\n`,{mode:0o700})
  const code=await launchUsingPreview({root,profile:{apiKey:'fixture',baseUrl:'http://127.0.0.1:1/v1',model:'fixture'},opencodeCommand:binary,completionVerifier:{id:'online-fixture',verify},...(timeout===undefined?{}:{completionVerifierTimeoutMs:timeout}),recordEvent:async e=>{events.push(e)}},state,{
   readVersion:async()=> '1.18.27',prepareHostProfile:async()=>({env:{},dispose:async()=>{}}),
   startBridge:async options=>{
    assert.equal(options.completionVerifierTimeoutMs,timeout)
    bridge=await startOpenCodeQwenLoopBridge({...options,modelFactory:()=>({async *stream(request){
     if(request.turn===1)yield {type:'tool_call' as const,call:{toolCallId:'fixture-read',name:'read',arguments:{filePath:'README.md'}}}
     else yield {type:'text_delta' as const,delta:'Repository inspected.'}
     yield {type:'usage' as const,usage:{inputTokens:1,outputTokens:1,cost:0}}
     yield {type:'finish' as const,reason:request.turn===1?'tool_calls' as const:'stop' as const}
    }})});return bridge
   },
   runTui:async()=>{
    const user={role:'user',content:'Read README.md and describe the repository without changing files.'}
    const request=async(messages:any[])=>{const response=await fetch(bridge.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+bridge.apiKey,'content-type':'application/json'},body:JSON.stringify({model:QWEN_LOOP_MODEL_ID,stream:false,messages,tools:[{type:'function',function:{name:'read',description:'read file',parameters:{type:'object',additionalProperties:true}}}]})});assert.equal(response.status,200);return response.json()}
    const first:any=await request([user]);assert.equal(first.choices[0].message.tool_calls[0].id,'fixture-read')
    await request([user,{role:'tool',tool_call_id:'fixture-read',content:encodeOpenCodeToolObservation({token:bridge.observationToken,toolCallId:'fixture-read',ok:true,content:'fixture README'})}]);return 0
   },
  })
  assert.equal(code,0);return events
 }finally{await bridge?.close();await rm(temp,{recursive:true,force:true})}
}
test('product entry and real bridge accept a full grader after the old 30-second limit',{timeout:300000},async()=>{
 let elapsed=0
 const events=await exercise(240000,async context=>{
  const start=Date.now()
  // A real wall-clock delay catches the historical default; the full candidate grader follows.
  await delay(31000,undefined,{signal:context.signal})
  const {stdout}=await exec('python3',[directory+'online-fixture.py','queue-has-id'],{signal:context.signal,killSignal:'SIGTERM',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:4*1024*1024})
  const result=JSON.parse(stdout.trim().split('\n').at(-1)!);assert.equal(result.passed,true);elapsed=Date.now()-start;return result
 })
 assert(elapsed>30000&&elapsed<240000)
 assert(events.some(e=>e.event==='external_verification_completed'&&e.passed===true))
 assert(events.some(e=>e.event==='mission_finished'&&e.outcome==='succeeded'))
 console.log(JSON.stringify({onlineFullGraderMs:elapsed,remoteModelCalls:0}))
})
test('omitted timeout retains product default and succeeds',async()=>{
 const events=await exercise(undefined,async()=>({passed:true}));assert(events.some(e=>e.event==='mission_finished'&&e.outcome==='succeeded'))
})
test('online timeout cancels verifier and kills its child process group',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eval16-cancel-')),pidFile=join(dir,'pid');let execution:Promise<any>|undefined,aborted=false
 try{
  const events=await exercise(1500,async context=>{
   context.signal.addEventListener('abort',()=>{aborted=true},{once:true})
   const source=`import importlib.util,sys,os;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('p',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p);p.install_stop_handlers();p.run([sys.executable,'-c','import os,time;open('+repr(sys.argv[2])+',"w").write(str(os.getpid()));time.sleep(90)'],cwd=os.getcwd(),env=os.environ,output=sys.stdout,timeout=90)`
   execution=exec('python3',['-c',source,directory+'processes.py',pidFile],{signal:context.signal,killSignal:'SIGTERM'})
   await execution;return {passed:true}
  })
  await execution?.catch(()=>{});assert(aborted)
  const pid=Number(await readFile(pidFile,'utf8'))
  for(let i=0;i<50;i++){try{process.kill(pid,0)}catch{break}await delay(20)}
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
  assert(events.some(e=>e.event==='external_verification_completed'&&e.failureCode==='verifier_timeout'))
  assert(!events.some(e=>e.event==='recovery_started'||e.event==='mission_finished'&&e.outcome==='succeeded'))
 }finally{await rm(dir,{recursive:true,force:true})}
})
