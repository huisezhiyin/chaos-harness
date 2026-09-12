#!/usr/bin/env node
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url)),flags=process.argv.slice(2)
if(flags.some(x=>x!=='--native-host')||flags.length>1){console.error('Use: node bin/chaos-preview-check.mjs [--native-host]');process.exit(2)}
const checks=[
 ['node_modules/typescript/bin/tsc','--noEmit'],
 ['node_modules/typescript/bin/tsc','-p','packages/preview/tsconfig.json'],
 ['node_modules/vitest/vitest.mjs','run','packages'],
 ['--import','tsx','--test','packages/preview/cli.check.mts','packages/preview/environment.check.mjs','packages/preview/scratch-recovery.check.mjs','packages/preview/host-profile.check.mts'],
]
if(flags.includes('--native-host')){
 if(process.platform!=='darwin'){console.error('Real Host qualification requires macOS');process.exit(2)}
 checks.push(['--import','tsx','--test','packages/preview/native-host.check.mts','packages/preview/native-scratch-recovery.check.mts'])
}
for(const args of checks){
 const code=await new Promise(resolve=>{const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit'});child.once('error',()=>resolve(1));child.once('exit',(code,signal)=>resolve(signal?1:code??1))})
 if(code!==0){process.exitCode=code;break}
}
