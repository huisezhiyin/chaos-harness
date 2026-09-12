import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {join} from 'node:path'
const require=createRequire(import.meta.url),build=require(join(process.argv[2],'index.js')),group=process.argv[3]
const partA={type:'object',properties:{id:{type:'integer'},name:{type:'string'}},required:['id','name']}
const partB={type:'object',properties:{integrations:{type:'array',items:{type:'object',properties:{domain:{type:'string'},enabled:{type:'boolean'}},required:['domain','enabled'],additionalProperties:false}}},required:['integrations']}
const input=()=>({id:1,name:'name',extra:'drop',integrations:[{domain:'example.test',enabled:1,extra:'drop'}]})
const expected={id:1,name:'name',integrations:[{domain:'example.test',enabled:true}]}
if(group==='defect') {
  const s=build({additionalProperties:false,allOf:[partA,partB]})
  const value=input(),before=JSON.stringify(value);assert.deepEqual(JSON.parse(s(value)),expected);assert.equal(JSON.stringify(value),before)
  const invalid=input();delete invalid.integrations[0].domain;assert.throws(()=>s(invalid))
} else if(group==='controls') {
  const flat={type:'object',properties:{...partA.properties,...partB.properties},required:['id','name','integrations'],additionalProperties:false}
  const s=build(flat);assert.deepEqual(JSON.parse(s(input())),expected)
  const extra=build({...flat,additionalProperties:true});assert.equal(JSON.parse(extra(input())).extra,'drop')
  const typed=build({type:'object',properties:{id:{type:'integer'}},additionalProperties:{type:'boolean'}});assert.deepEqual(JSON.parse(typed({id:1,other:1})),{id:1,other:true})
  const nested=build({type:'object',properties:{child:{anyOf:[flat,{type:'null'}]}}});assert.equal(JSON.parse(nested({child:null})).child,null)
  const other=build({type:'object',properties:{different:{type:'integer'}},required:['different']})
  for(let i=0;i<3;i++){assert.deepEqual(JSON.parse(s(input())),expected);assert.deepEqual(JSON.parse(other({different:i})),{different:i})}
} else throw Error('Unknown group')
console.log(JSON.stringify({group,passed:true}))
