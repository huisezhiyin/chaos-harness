import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {join} from 'node:path'
const [root,kind,group]=process.argv.slice(2)
const {default:factory}=await import(pathToFileURL(join(root,'index.js')))
if(kind==='defer'){
 if(group==='controls'){
  const a=factory();a.resolve(9);a.reject(0);assert.equal(await a.promise,9)
  const b=factory(),error={reason:1};const checked=assert.rejects(b.promise,e=>e===error);b.reject(error);await checked
 }else{
  const a=factory();assert.equal(a.settled,false)
  const inner=factory(),{resolve}=a;resolve(inner.promise);assert.equal(a.settled,true)
  const reason={failure:true};a.reject(reason);inner.resolve(7);await assert.doesNotReject(a.promise);assert.equal(await a.promise,7)
  assert.throws(()=>{a.settled=false},TypeError);assert.throws(()=>Object.defineProperty(a,'settled',{value:false}),TypeError)
  const b=factory(),checked=assert.rejects(b.promise,e=>e===reason),{reject}=b;reject(reason);assert.equal(b.settled,true);b.resolve(0);await checked
  const c=factory();c.resolve(undefined);assert.equal(c.settled,true);assert.equal(await c.promise,undefined)
 }
}else{
 let calls=0;const f=factory(x=>{calls++;return x});assert.equal(f(7),7);assert.equal(f(8),7);assert.equal(calls,1)
}
console.log('contract passed')
