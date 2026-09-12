import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import ts from 'typescript'
const [root,kind,group]=process.argv.slice(2)
const require=createRequire(import.meta.url)
const tick=()=>new Promise(resolve=>setImmediate(resolve))
if(kind==='equal') {
  for(const variant of ['es6/index.js','es6/react.js']) {
    const equal=require(join(root,variant))
    if(group==='defect') {
      assert.equal(equal(new DataView(new ArrayBuffer(0)),new DataView(new ArrayBuffer(0))),true)
      const view=(values,offset=0,length=values.length-offset)=>new DataView(Uint8Array.from(values).buffer,offset,length)
      assert.equal(equal(view([8,1,2],1),view([1,2,9],0,2)),true)
      assert.equal(equal(view([1]),view([2])),false)
      assert.equal(equal(view([1]),view([1,0])),false)
      assert.equal(equal(view([1,9,2],0,1),view([1,8,3],0,1)),true)
    } else {
      assert.equal(equal(new Uint16Array([3,4]),new Uint16Array([3,4])),true)
      assert.equal(equal(new Uint16Array([3]),new Uint16Array([4])),false)
      assert.equal(equal(new Map([['x',{a:1}]]),new Map([['x',{a:1}]])),true)
      assert.equal(equal(new Set([1,2]),new Set([2,1])),true)
      assert.equal(equal({x:NaN}, {x:NaN}),true)
    }
  }
} else if(kind==='queue') {
  const {default:Queue}=await import(pathToFileURL(join(root,'index.js')))
  const q=new Queue()
  if(group==='defect') {
    assert.equal(typeof q.enqueueAll,'function')
    q.enqueue('old');assert.equal(q.enqueueAll([1,undefined,2]),undefined)
    assert.deepEqual([...q],['old',1,undefined,2]);assert.equal(q.size,4)
    q.enqueueAll([]);assert.equal(q.size,4)
    const err=Error('iterator')
    function* values(){yield 3;throw err}
    assert.throws(()=>q.enqueueAll(values()),e=>e===err)
    assert.deepEqual([...q.drain()],['old',1,undefined,2,3]);assert.equal(q.size,0)
    q.enqueueAll(new Set([9,8]));assert.equal(q.peek(),9);q.clear();q.enqueueAll([7]);assert.equal(q.dequeue(),7)
    const dts=await readFile(join(root,'index.d.ts'),'utf8');assert.match(dts,/enqueueAll\s*\(/)
    assert.match(await readFile(join(root,'readme.md'),'utf8'),/enqueueAll/)
  } else {
    q.enqueue(1);q.enqueue(undefined);assert.equal(q.peek(),1);assert.equal(q.dequeue(),1);assert.equal(q.size,1)
    assert.deepEqual([...q.drain()],[undefined]);assert.equal(q.size,0);q.enqueue(2);q.clear();assert.equal(q.dequeue(),undefined)
  }
} else if(kind==='retry') {
  if(group==='structure') {
    const source=await readFile(join(root,'index.js'),'utf8'),ast=ts.createSourceFile('index.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
    const freezes=[],helpers=[],calls=[]
    const isFreeze=n=>ts.isCallExpression(n)&&n.expression.getText(ast)==='Object.freeze'
    function visit(n) {
      if(isFreeze(n))freezes.push(n)
      if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression))calls.push(n.expression.text)
      if(ts.isFunctionDeclaration(n)&&n.name&&n.body) {let count=0;function inside(x){if(isFreeze(x))count++;ts.forEachChild(x,inside)}inside(n.body);if(count===1)helpers.push(n.name.text)}
      ts.forEachChild(n,visit)
    }
    visit(ast);assert.equal(freezes.length,1,'Context freezing must be centralized');assert(helpers.some(name=>calls.filter(c=>c===name).length>=3),'All context creation paths must use the helper')
  } else {
    const {default:pRetry,AbortError}=await import(pathToFileURL(join(root,'index.js')))
    const error=Error('retry'),seen=[]
    const result=await pRetry(attempt=>{if(attempt<3)throw error;return 7},{retries:2,minTimeout:0,shouldConsumeRetry(c){assert(Object.isFrozen(c));seen.push(['consume',c.attemptNumber,c.retriesConsumed,c.retriesLeft]);return true},onFailedAttempt(c){assert(Object.isFrozen(c));assert.equal(c.error,error);assert.equal(c.retryDelay,0);seen.push(['failed',c.attemptNumber])},shouldRetry(c){assert(Object.isFrozen(c));seen.push(['retry',c.attemptNumber]);return true}})
    assert.equal(result,7);assert.deepEqual(seen,[['consume',1,0,2],['failed',1],['retry',1],['consume',2,1,1],['failed',2],['retry',2]])
    await assert.rejects(pRetry(()=>{throw new AbortError(error)},{minTimeout:0}),e=>e===error)
    let expired;await assert.rejects(pRetry(()=>{throw error},{maxRetryTime:0,onFailedAttempt(c){expired=c}}),e=>e===error);assert(Object.isFrozen(expired));assert.equal(expired.retryDelay,0)
    let calls=0;assert.equal(await pRetry(()=>{if(++calls<3)throw error;return calls},{retries:1,minTimeout:0,shouldConsumeRetry:()=>false}),3)
  }
} else if(kind==='limit') {
  const {default:pLimit}=await import(pathToFileURL(join(root,'index.js')))
  const limit=pLimit(1);let active=0,max=0
  assert.deepEqual(await Promise.all([1,2,3].map(x=>limit(async()=>{active++;max=Math.max(max,active);await tick();active--;return x}))),[1,2,3]);assert.equal(max,1)
} else throw Error('Unknown task kind')
console.log(JSON.stringify({group,passed:true}))
