import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require=createRequire(import.meta.url),root=process.argv[2],group=process.argv[3]
const {Semaphore,Mutex,E_CANCELED}=require(join(root,'lib/index.js'))
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const large=2147483628
if(group==='empty') {
  const s=new Semaphore(large);s.release();assert.equal(s.getValue(),large+1);s.setValue(large-1);assert.equal(s.getValue(),large-1)
} else if(group==='sparse') {
  const s=new Semaphore(0),seen=[]
  const waits=[3,100000003,large,large+1].map(weight=>s.waitForUnlock(weight).then(()=>seen.push(weight)))
  s.setValue(large);await tick();assert.deepEqual([...seen].sort((a,b)=>a-b),[3,100000003,large]);assert.equal(s.getValue(),large)
  s.release();await Promise.all(waits);assert.equal(seen.length,4)
} else if(group==='priority') {
  const s=new Semaphore(0),seen=[]
  const queued=s.acquire(large+1,2)
  const high=s.waitForUnlock(large,3).then(()=>seen.push('high'))
  const equal=s.waitForUnlock(large,2).then(()=>seen.push('equal'))
  const low=s.waitForUnlock(3,1).then(()=>seen.push('low'))
  s.setValue(large);await tick();assert.deepEqual(seen,['high'])
  s.release();const [,release]=await queued;assert.equal(s.getValue(),0);await tick();assert.deepEqual(seen,['high'])
  release();await Promise.all([high,equal,low]);assert.deepEqual([...seen].sort(),['equal','high','low'])
} else if(group==='controls') {
  const s=new Semaphore(2);const [initial,release]=await s.acquire(2);assert.equal(initial,2);assert.equal(s.getValue(),0)
  release();release();assert.equal(s.getValue(),2)
  const error=Error('worker');await assert.rejects(s.runExclusive(()=>{throw error}),e=>e===error);assert.equal(s.getValue(),2)
  assert.equal(await s.runExclusive(()=>7),7);assert.equal(s.getValue(),2)
  const [,_release]=await s.acquire(2);const waiting=s.acquire();const rejected=assert.rejects(waiting,e=>e===E_CANCELED);s.cancel();await rejected;_release()
  const order=[],q=new Semaphore(0)
  const a=q.acquire(2,0).then(([,r])=>{order.push('a');r()})
  const b=q.acquire(1,0).then(([,r])=>{order.push('b');r()})
  q.setValue(1);await tick();assert.deepEqual(order,[])
  q.release();await Promise.all([a,b]);assert.deepEqual(order,['a','b'])
  const m=new Mutex();assert.equal(await m.runExclusive(()=>42),42);assert.equal(m.isLocked(),false)
  assert.throws(()=>s.acquire(0));assert.throws(()=>s.release(0));assert.throws(()=>s.waitForUnlock(0))
} else throw Error('Unknown group')
console.log(JSON.stringify({group,passed:true}))
