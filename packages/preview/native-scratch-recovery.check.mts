import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,chmod} from 'node:fs/promises'
import {tmpdir,homedir} from 'node:os'
import {join,dirname} from 'node:path'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {createOpenCodeQwenLoopConfig} from '../adapters/opencode-codex-bridge/src/qwen-loop-bridge.js'
import {prepareRuntime,pluginPath} from './environment.mjs'
import {scratchFindings} from './workdir.mjs'
import {verifyManagedProfile} from './host-profile.mjs'
import {fileURLToPath} from 'node:url'
const execute=promisify(execFile)
const exec=(command:string,args:string[],options:any)=>{const child=execute(command,args,options);child.child.stdin?.end();return child}
test('real native shell recreates deleted scratch before the next tool',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'chaos-native-managed-'))),root=join(base,'workspace'),cache=join(base,'cache')
 let calls=0,toolDelivered=0
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c)
  const body=JSON.parse(Buffer.concat(chunks).toString()),metadata=body.model==='metadata'
  calls++;if(calls>8){res.writeHead(500);res.end();return}
  const command=toolDelivered===0?`${JSON.stringify(process.execPath)} -e "require('node:fs').rmdirSync('test/.chaos-tmp')"`:`${JSON.stringify(process.execPath)} probe.cjs`
  const tool=!metadata&&toolDelivered<2;if(tool)toolDelivered++
  const message=tool?{role:'assistant',content:null,tool_calls:[{id:'fixture-probe-'+toolDelivered,type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'Verify runtime environment',timeout:10000})}}]}:{role:'assistant',content:'Fixture complete'}
  if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});const delta=tool?{role:'assistant',tool_calls:[{index:0,...message.tool_calls![0]}]}:message;res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n');res.end('data: [DONE]\n\n')}
  else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))}
 })
 try {
  await mkdir(root);await mkdir(cache)
  await exec('git',['init','--quiet',root],{})
  const runtime=await prepareRuntime({workspaceRoot:root,cacheRoot:cache});await chmod(runtime.toolEnvironment.TMPDIR,0o755)
  await writeFile(join(root,'probe.cjs'),`const m=require('node:module'); const cache=m.enableCompileCache(); console.log('RUNTIME_PROBE='+JSON.stringify({mode:require('node:fs').lstatSync(process.env.TMPDIR).mode&0o777,cwd:process.cwd(),tmp:require('node:os').tmpdir(),cache:cache.directory??m.getCompileCacheDir()})); require('./helper.cjs'); m.flushCompileCache();`)
  await writeFile(join(root,'helper.cjs'),'module.exports=42;')
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port
  const observation=fileURLToPath(new URL('../adapters/opencode-codex-bridge/src/opencode-observation-plugin.ts',import.meta.url))
  const config=createOpenCodeQwenLoopConfig(`http://127.0.0.1:${port}/v1`,'fixture-only',observation)
  const env=runtime.hostEnvironment({PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin',HOME:homedir(),USER:process.env.USER,LOGNAME:process.env.LOGNAME,SHELL:'/bin/zsh',OPENCODE_TEST_HOME:join(base,'home'),OPENCODE_CONFIG_DIR:join(base,'config/opencode'),XDG_CONFIG_HOME:join(base,'config'),XDG_DATA_HOME:join(base,'data'),XDG_STATE_HOME:join(base,'state'),XDG_CACHE_HOME:join(base,'cache'),OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_AUTH_CONTENT:'{}',CHAOS_HARNESS_OBSERVATION_TOKEN:'f'.repeat(64)})

  const binary=process.env.OPENCODE_BIN?.trim()||join(homedir(),'.opencode/bin/opencode')
  await verifyManagedProfile({command:binary,root,env,observationPlugin:observation},runtime)
  const out=await exec(binary,['--log-level','DEBUG','run','--dir',root,'--model','chaos-qwen/code-agent','--format','json','--title','Local fixed fixture','Execute the fixed environment probe.'],{cwd:root,env,timeout:20000,maxBuffer:4*1024*1024}).catch(async(e)=>{
    const logRoot=join(base,'data/opencode/log');let logs='';try{for(const f of await readdir(logRoot))logs+=(await readFile(join(logRoot,f),'utf8')).slice(-7000)}catch{}
    throw Error(JSON.stringify({files:(await readdir(base,{recursive:true})).filter(x=>/dylib|sqlite|\.db|account/.test(x)),calls,stdout:String(e.stdout).slice(-1500),stderr:String(e.stderr).slice(-1500),logs}))
  })
  const events=out.stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x)),tools=events.filter(x=>x.type==='tool_use')
  const completed=tools.find(x=>x.part?.state?.status==='completed'&&x.part.state.output?.includes('RUNTIME_PROBE='))
  assert(completed,JSON.stringify({tools:tools.map(x=>({tool:x.part?.tool,status:x.part?.state?.status,error:x.part?.state?.error})),stderr:out.stderr.slice(-1500)}))
  const probe=JSON.parse(completed.part.state.output.split('RUNTIME_PROBE=')[1].split('\n')[0])
  assert.equal(tools.filter(x=>x.part?.state?.status==='completed').length,2);assert.equal(probe.mode,0o755);assert.equal(probe.tmp,runtime.toolEnvironment.TMPDIR);assert.equal(probe.cwd,root)
  assert(probe.cache.startsWith(runtime.toolEnvironment.NODE_COMPILE_CACHE))
  assert.deepEqual(await scratchFindings(root),[]);assert((await readdir(runtime.toolEnvironment.NODE_COMPILE_CACHE)).length>0)
  const hostEntries=await readdir(env.TMPDIR)
  assert(hostEntries.includes('opencode'))
  console.log(JSON.stringify({remoteProviderCalls:0,localFixtureRequests:calls,toolTmpConfined:true,compileCacheSeparated:true,hostEntries,taskScratchEmpty:true}))
 }finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(base,{recursive:true,force:true})}
})
