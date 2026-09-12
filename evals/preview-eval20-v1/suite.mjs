import {execFile,spawnSync} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {readFile,lstat,mkdir,writeFile,realpath,readdir,readlink} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {environmentError} from '../basic-coding-v2-host-scratch/environment.mjs'

export const exec=promisify(execFile)
export const harness=fileURLToPath(new URL('../../',import.meta.url))
const directory=join(harness,'evals/preview-eval20-v1')
export const catalog=JSON.parse(await readFile(join(directory,'catalog.json'),'utf8'))
export const batchId=catalog.batchId
export const tasks=catalog.executionPlan.order.map(slug=>catalog.tasks.find(t=>t.slug===slug))
export const base=join(homedir(),'.local/state/chaos-harness/evals',batchId)
export const targets=join(homedir(),'github_project/chaos-dogfood')
export const getTask=id=>{const task=tasks.find(t=>t.id===id);if(!task)throw Error('Unknown task');return task}
export const rootFor=task=>join(targets,task.id)
export const readJson=async path=>JSON.parse(await readFile(path,'utf8'))
export const sha=value=>createHash('sha256').update(value).digest('hex')
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
export const digest=value=>sha(JSON.stringify(canonical(value)))
export async function exists(path){try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
export async function writeOnce(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})}
export async function snapshot(root){const {stdout}=await exec('python3',[join(directory,'state.py'),'snapshot',root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:16*1024*1024});return JSON.parse(stdout)}
export function boundary(task,initial,current){const result=spawnSync('python3',[join(directory,'state.py'),'boundary'],{input:JSON.stringify({task,initial,current}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:16*1024*1024});if(result.status!==0)throw environmentError('verifier_exception');return JSON.parse(result.stdout)}
export async function identity(){
 const manifests=['2026-09-07_code-harness-eval-v3-baseline.json','2026-09-08_basic-coding-v1-sources.json','2026-09-08_basic-coding-v2-sources.json','2026-09-08_managed-runtime-v1-validated.json','2026-09-08_basic-coding-v3-managed-prepared.json','2026-09-08_v01-preview-validated.json']
 for(const name of manifests){const data=await readJson(join(harness,'mydocs/freezes',name));for(const [path,hash] of Object.entries(data.sourceSha256??data))if(sha(await readFile(join(harness,path)))!==hash)throw Error('Frozen source changed: '+path)}
 const {stdout}=await exec('git',['-C',harness,'ls-files','-c','-o','--exclude-standard','-z','--','packages','bin','evals','package.json','pnpm-lock.yaml','tsconfig.json'],{maxBuffer:8*1024*1024})
 const files={}
 for(const path of [...new Set(stdout.split('\0').filter(Boolean))].sort())files[path]=sha(await readFile(join(harness,path)))
 const host=process.env.OPENCODE_BIN?.trim()||join(homedir(),'.opencode/bin/opencode')
 if(!host.startsWith('/'))throw Error('Host must have an absolute identity')
 const compiler=await realpath(join(harness,'node_modules/typescript/lib/typescript.js'))
 const {stdout:python}=await exec('python3',['-c','import sys; print(sys.executable)'])
 return {batchId,runtime:sha(JSON.stringify(files)),nativeHost:{path:host,sha256:sha(await readFile(host))},node:{version:process.version,sha256:sha(await readFile(process.execPath))},compiler:{path:compiler,sha256:sha(await readFile(compiler))},python:{path:python.trim(),sha256:sha(await readFile(python.trim()))},toolEnvironment:catalog.executionPlan.toolEnvironment}
}
export async function assertBatchAdmission(){
 const admission=await readJson(join(base,'batch-admission.json')),current=await identity()
 if(JSON.stringify(admission.identity)!==JSON.stringify(current))throw Error('Batch admission stale')
 if(admission.tasks.join('\n')!==tasks.map(t=>t.id).join('\n'))throw Error('Batch order changed')
 if(sha(await readFile(join(base,'qualification.json')))!==admission.qualificationSha256)throw Error('Qualification changed')
}
export async function checkDependencies(id,root,admission){
 if(root!==rootFor(getTask(id))||admission.root!==root)throw environmentError('candidate_identity_mismatch')
 const task=getTask(id),key=task.repo.replace('/','--')+'-'+task.head
 const dep=join(base,'dependencies-v2',key,'node_modules'),mount=join(root,'node_modules')
 const info=await lstat(mount);if(!info.isDirectory()||info.isSymbolicLink())throw environmentError('dependency_mount_changed')
 const expected=(await readdir(dep)).sort(),actual=(await readdir(mount)).filter(n=>n!=='.cache').sort()
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw environmentError('dependency_mount_changed')
 for(const name of expected)if(!(await lstat(join(mount,name))).isSymbolicLink()||await readlink(join(mount,name))!==join(dep,name))throw environmentError('dependency_mount_changed')
 const cache=await lstat(join(mount,'.cache'));if(!cache.isDirectory()||cache.isSymbolicLink())throw environmentError('dependency_mount_changed')
 const env=join(base,'dependencies-v2',key,'environment.json')
 if(sha(await readFile(env))!==admission.environmentSha256)throw environmentError('dependencies_changed')
 const {stdout}=await exec('python3',['-c',`import importlib.util,sys,json,hashlib;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('e',sys.argv[1]);e=importlib.util.module_from_spec(s);s.loader.exec_module(e);p=e.BASE/'dependencies-v2'/sys.argv[2];r=json.loads((p/'environment.json').read_text());assert e.digest_tree(p/'node_modules')==r['dependencyTree'];assert hashlib.sha256((p/'package-lock.json').read_bytes()).hexdigest()==r['lockSha256'];print('ok')`,join(directory,'prepare-environments.py'),key],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:30000})
 if(stdout.trim()!=='ok')throw environmentError('dependencies_changed')
 const refs=await exec('git',['-C',root,'for-each-ref','--format=%(refname)','refs/heads'])
 if(refs.stdout.trim())throw environmentError('candidate_identity_mismatch')
}
export async function grade(task,root,signal){
 signal?.throwIfAborted()
 let stdout
 try {({stdout}=await exec('python3',[join(directory,'grade.py'),task.id,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},signal,timeout:240000,maxBuffer:4*1024*1024,killSignal:'SIGTERM'}))}
 catch(error){if(signal?.aborted)throw signal.reason;if(error.killed)throw environmentError('verifier_timeout');if(error.code!==1)throw environmentError('verifier_exception');stdout=String(error.stdout??'')}
 let result;try{result=JSON.parse(stdout.trim().split('\n').at(-1))}catch{throw environmentError('verifier_exception')}
 if(result.failureCode)throw environmentError(result.failureCode)
 return {...result,artifact:digest(await snapshot(root))}
}
export function prompt(task){
 const d=task.delivery
 return `Complete this ordinary coding task in the current repository.\n\n${task.contract}\n\nDelivery contract:\n- Existing files you may change: ${d.allowedExistingFiles.join(', ')||'none'}.\n- Add regression tests in exactly ${d.requiredNewTestFile}; preserve all existing tests.\n- Required changed files: ${d.requiredChangedFiles.join(', ')||'implementation and new tests as stated above'}.\n- Preserve manifests, locks, git configuration and public exports except the requested new API.\n- Run npm test${task.repo==='fastify/fast-uri'?', npm run lint and npm run test:typescript':''}; inspect the final diff.\n- Keep all tools and temporary work within this workspace. Use test/.chaos-tmp for temporary files and leave it empty. Do not inspect owner evaluators, reference answers or other workspaces.\n- ${d.generatedDirectories.length?'The dist build directory is rebuilt independently and is not a delivered artifact.':'Do not leave unrelated generated files.'}\n\nAcceptance: ${task.acceptance.join('; ')}.\nComplete the task autonomously; finish with a concise account of the change and checks.`
}
