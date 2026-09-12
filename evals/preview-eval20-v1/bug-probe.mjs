import assert from 'node:assert/strict'
import {getEventListeners} from 'node:events'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {pathToFileURL} from 'node:url'
import {join} from 'node:path'
const [root,slug]=process.argv.slice(2)
try {
 if(slug.startsWith('map-')){
  const m=await import(pathToFileURL(join(root,'index.js')))
  if(slug==='map-aborted-listener'){
   const c=new AbortController(),reason=new Error('fixed reason');c.abort(reason);let calls=0
   await assert.rejects(m.default([1],()=>{calls++;return 1},{signal:c.signal}),e=>e===reason)
   assert.equal(calls,0);assert.equal(getEventListeners(c.signal,'abort').length,0)
   const success=new AbortController()
   assert.deepEqual(await m.default([1,2],x=>x*2,{signal:success.signal}),[2,4])
   assert.equal(getEventListeners(success.signal,'abort').length,0)
   const active=new AbortController();let release
   const gate=new Promise(r=>{release=r}),pending=m.default([1],()=>gate,{signal:active.signal})
   await nextTurn();active.abort(reason);await assert.rejects(pending,e=>e===reason);release(1)
   assert.equal(getEventListeners(active.signal,'abort').length,0)
  }else{
   const resolve=[],input=[0,1,2].map(i=>new Promise(r=>{resolve[i]=r})),output=[]
   const consume=(async()=>{for await(const v of m.pMapIterable(input,(value,index)=>[value,index],{concurrency:3}))output.push(v)})()
   await nextTurn();resolve[2]('c');await nextTurn();resolve[1]('b');await nextTurn();resolve[0]('a');await consume
   assert.deepEqual(output,[['a',0],['b',1],['c',2]])
  }
 }else if(slug.startsWith('queue-')){
  const {default:PQueue}=await import(pathToFileURL(join(root,'source/index.ts')))
  if(slug==='queue-size-wakeup'){
   const q=new PQueue({concurrency:3,autoStart:false});let release;const gate=new Promise(r=>{release=r})
   const jobs=Array.from({length:5},()=>q.add(()=>gate));let done=false
   const waiting=q.onSizeLessThan(3).then(()=>{done=true});q.start();await nextTurn()
   try{assert.equal(q.size,2);assert.equal(done,true)}finally{release();await Promise.all(jobs);await waiting}
   const equal=new PQueue({concurrency:1,autoStart:false});const queued=[equal.add(()=>1),equal.add(()=>2)]
   let premature=false;const strict=equal.onSizeLessThan(2).then(()=>{premature=true});await nextTurn()
   try{assert.equal(premature,false)}finally{equal.start();await Promise.all(queued);await strict}
  }else{
   for(const timeout of [0,-1,NaN,Infinity]){
    let called=false;const q=new PQueue({timeout:5000})
    await assert.rejects(q.add(()=>{called=true;return 1},{timeout}),TypeError)
    assert.equal(called,false);assert.equal(q.size,0);assert.equal(q.pending,0)
   }
  }
 }else if(slug.startsWith('query-')){
  const {default:q}=await import(pathToFileURL(join(root,'index.js')))
  if(slug==='query-own-types'){
   for(const key of ['toString','valueOf','constructor','hasOwnProperty'])assert.equal(q.parse(key+'=x',{types:{}})[key],'x')
   assert.deepEqual(q.parse('toString[]=a&toString[]=b',{types:{},arrayFormat:'bracket'}).toString,['a','b'])
   assert.equal(q.parse('a=2',{types:{a:'number'}}).a,2)
   assert.equal(q.parse('x=2',{types:Object.create({x:'number'})}).x,'2')
   assert.equal(Object.getPrototypeOf(q.parse('x=2')),null)
  }else{
   assert.equal(q.pick('/users?page=1&sort=name#section',['page']),'/users?page=1#section')
   assert.equal(q.exclude('/users?page=1#section',['sort']),'/users?page=1#section')
   assert.equal(q.stringifyUrl({url:'/users',query:{page:1},fragmentIdentifier:'a b'}),'/users?page=1#a%20b')
  }
 }else{
  const {default:u}=await import(pathToFileURL(join(root,'index.js')))
  if(slug==='uri-reserved-path'){
   assert.equal(u.serialize({scheme:'http',host:'example.com',path:'/a;b'}),'http://example.com/a;b')
   assert.equal(u.serialize({scheme:'http',host:'example.com',path:'/a%3Ab'}),'http://example.com/a%3Ab')
   assert.equal(u.serialize({path:'a:b/c:d'}),'a%3Ab/c:d')
   assert.equal(u.serialize({path:'./a:b'}),'a%3Ab')
   for(const character of "!$&'()*+,;=:@/"){
    assert.equal(u.serialize({scheme:'http',host:'example.com',path:'/a'+character+'b'}),'http://example.com/a'+character+'b')
   }
  }else{
   assert.equal(u.equal('http://EXAMPLE.com/a','http://example.com/a'),true)
   for(const component of ['/A','/a?Q=x','/a#F'])assert.equal(u.equal('http://example.com'+component,'http://example.com'+component.toLowerCase()),false)
  }
 }
 console.log(JSON.stringify({passed:true,slug}))
}catch(e){console.log(JSON.stringify({passed:false,slug,errorName:e.name,errorCode:e.code??null,message:e.message}));process.exitCode=1}
