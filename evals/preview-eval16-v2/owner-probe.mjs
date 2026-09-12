import assert from 'node:assert/strict'
import {getEventListeners} from 'node:events'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {pathToFileURL} from 'node:url'
import {join} from 'node:path'

const [root, slug] = process.argv.slice(2)
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
try {
 if (slug === 'uri-resolve-many') {
  const {default:u} = await import(pathToFileURL(join(root,'index.js')))
  assert.equal(typeof u.resolveMany,'function')
  const base='http://a/b/c/d;p?q', values=['g','../g','?y','#s','','../../g','/g','g?y#s','%2F']
  assert.deepEqual(u.resolveMany(base,values),values.map(v=>u.resolve(base,v)))
  assert.deepEqual(u.resolveMany(base,(function*(){yield '../x';yield './y'})(),{skipEscape:true}),['../x','./y'].map(v=>u.resolve(base,v,{skipEscape:true})))
  assert.deepEqual(u.resolveMany(base,[]),[])
  const error=new Error('iterator'); assert.throws(()=>u.resolveMany(base,(function*(){yield '';throw error})()),e=>e===error)
 } else if (slug === 'normalize-query-predicate') {
  const {default:n}=await import(pathToFileURL(join(root,'index.js')))
  const seen=[]
  assert.equal(n('https://example.com/?a=1&a=2&b=&a=3#F',{sortQueryParameters:false,removeQueryParameters:(k,v)=>{seen.push([k,v]);return k==='a'&&v==='2'}}),'https://example.com/?a=1&b=&a=3#F')
  assert.deepEqual(seen,[['a','1'],['a','2'],['b',''],['a','3']])
  assert.equal(n('https://example.com/?keep=1&drop=2',{keepQueryParameters:['keep'],removeQueryParameters:()=>true}),'https://example.com/?keep=1')
  let pair; n('https://example.com/?%61=%26',{removeQueryParameters:(k,v)=>{pair=[k,v];return true}});assert.deepEqual(pair,['a','&'])
  assert.equal(n('https://example.com/?x=1&y=2',{removeQueryParameters:[/^x$/]}),'https://example.com/?y=2')
 } else if (slug === 'map-iterable-signal') {
  const {pMapIterable}=await import(pathToFileURL(join(root,'index.js')))
  const reason={kind:'stop'}, c=new AbortController();c.abort(reason)
  let iterated=0
  const input={[Symbol.iterator](){iterated++;return [1][Symbol.iterator]()}}
  await assert.rejects(pMapIterable(input,x=>x,{signal:c.signal})[Symbol.asyncIterator]().next(),e=>e===reason)
  assert.equal(iterated,0);assert.equal(getEventListeners(c.signal,'abort').length,0)
  const active=new AbortController(), gate=deferred();let calls=0
  const iterator=pMapIterable([1,2,3],()=>{calls++;return gate.promise},{concurrency:1,signal:active.signal})[Symbol.asyncIterator]()
  const pending=iterator.next();await nextTurn();assert.equal(calls,1)
  active.abort(reason);await assert.rejects(pending,e=>e===reason);gate.reject(new Error('late mapper'));await nextTurn()
  assert.equal(calls,1);assert.equal(getEventListeners(active.signal,'abort').length,0)
  const success=new AbortController(),output=[]
  for await(const v of pMapIterable([1,2],x=>x*2,{signal:success.signal})) output.push(v)
  assert.deepEqual(output,[2,4]);assert.equal(getEventListeners(success.signal,'abort').length,0)
  const early=new AbortController();for await(const v of pMapIterable([1,2,3],x=>x,{concurrency:1,signal:early.signal})){assert.equal(v,1);break}
  assert.equal(getEventListeners(early.signal,'abort').length,0)
 } else if (slug === 'queue-has-id') {
  const {default:PQueue}=await import(pathToFileURL(join(root,'source/index.ts')))
  const q=new PQueue({concurrency:1,autoStart:false}),gate=deferred();assert.equal(typeof q.has,'function')
  const a=q.add(()=>gate.promise,{id:'same'}),b=q.add(()=>2,{id:'same'});assert.equal(q.has('same'),true);assert.equal(q.has('missing'),false)
  q.start();await nextTurn();assert.equal(q.has('same'),true);q.clear();assert.equal(q.has('same'),true)
  gate.resolve(1);await a;await nextTurn();assert.equal(q.has('same'),false);void b
  const c=new AbortController();q.pause();const aborted=q.add(()=>0,{id:'abort',signal:c.signal});assert.equal(q.has('abort'),true);c.abort();await assert.rejects(aborted);assert.equal(q.has('abort'),false)
  q.start();const error=new Error('failed');await assert.rejects(q.add(()=>{throw error},{id:'fail'}),e=>e===error);assert.equal(q.has('fail'),false)
  const duplicates=new PQueue({concurrency:1,autoStart:false}),one=deferred(),two=deferred()
  const d1=duplicates.add(()=>one.promise,{id:'d'}),d2=duplicates.add(()=>two.promise,{id:'d'});duplicates.start();one.resolve();await d1;await nextTurn();assert.equal(duplicates.has('d'),true);two.resolve();await d2;await nextTurn();assert.equal(duplicates.has('d'),false)
 } else if (slug === 'map-validation-helper') {
  const {default:p,pMapIterable}=await import(pathToFileURL(join(root,'index.js')))
  for(const concurrency of [0,-1,1.2,NaN]){assert.throws(()=>pMapIterable([],x=>x,{concurrency}),TypeError);await assert.rejects(p([],x=>x,{concurrency}),TypeError)}
  await assert.rejects(p([],null),{name:'TypeError',message:'Mapper function is required'});assert.throws(()=>pMapIterable([],null),{name:'TypeError',message:'Mapper function is required'})
  assert.deepEqual(await p([1,2],x=>x*2,{concurrency:1}),[2,4]);const out=[];for await(const x of pMapIterable([1,2],x=>x*2,{concurrency:1}))out.push(x);assert.deepEqual(out,[2,4])
 } else if (slug === 'query-value-helper') {
  const {default:q}=await import(pathToFileURL(join(root,'index.js')))
  assert.equal(q.parse('x=012',{parseNumbers:true,types:{x:'string'}}).x,'012')
  assert.equal(q.parse('x=true',{parseBooleans:true,types:{x:x=>'custom:'+x}}).x,'custom:true')
  assert.equal(q.parse('x=true',{parseBooleans:true}).x,true);assert.equal(q.parse('x=2',{parseNumbers:true}).x,2)
  assert.equal(q.parse('x',{types:{x:'boolean'}}).x,true);assert.equal(q.parse('x',{types:{x:'string'}}).x,null)
  assert.equal(q.parse('x=2',{parseNumbers:true,types:{x:()=>undefined}}).x,undefined)
  assert.deepEqual(q.parse('x[]=1&x[]=2',{arrayFormat:'bracket',types:{x:'number[]'}}).x,[1,2])
 } else if (slug === 'normalize-data-helper') {
  const {default:n}=await import(pathToFileURL(join(root,'index.js')))
  assert.equal(n('data:TEXT/PLAIN;charset=US-ASCII,AbC%2f#X'),'data:,AbC%2f#X')
  assert.equal(n('data:TEXT/HTML;charset=UTF-8;base64, AbC= #X',{stripHash:true}),'data:text/html;charset=utf-8;base64,AbC=')
  assert.equal(n('HTTP://WWW.EXAMPLE.COM:80/a'),'http://example.com/a')
 } else if (slug === 'normalize-query-helper') {
  const {default:n}=await import(pathToFileURL(join(root,'index.js')))
  assert.equal(n('https://example.com/?z=1&a=2&z=3',{sortQueryParameters:false,removeQueryParameters:false}),'https://example.com/?z=1&a=2&z=3')
  assert.equal(n('https://example.com/?a=2&z=3',{keepQueryParameters:['a'],removeQueryParameters:true}),'https://example.com/?a=2')
  assert.equal(n('https://example.com/?a=%2F&z=1#F',{removeQueryParameters:['z']}),'https://example.com/?a=%2F#F')
 } else {
  throw new Error('Unknown owner task')
 }
 console.log(JSON.stringify({passed:true,slug}))
} catch(error) {
 console.log(JSON.stringify({passed:false,slug,errorName:error.name,errorCode:error.code??null,message:error.message}));process.exitCode=1
}
