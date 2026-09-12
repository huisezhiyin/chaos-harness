import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const root=process.argv[2], group=process.argv[3]
const {default:parse}=await import(pathToFileURL(join(root,'build/lib/index.js')))
const values=['"alpha"',"'beta'",'x"y','', '  spaced  ', '"a b"']
if(group==='defect') {
  for(const [i,a] of values.entries()) {
    const file=join(root,'quote-config-'+i+'.json')
    await writeFile(file,JSON.stringify({a,nested:{a}}))
    for(const argv of ['',[], '--other=ok',['--other=ok']]) {
      const v=parse(argv,{configObjects:[{a,nested:{a}}],string:['a','nested.a']})
      assert.equal(v.a,a);assert.equal(v.nested.a,a)
    }
    for(const argv of [`--config ${file}`,['--config',file]]) {
      const v=parse(argv,{config:'config',string:['a','nested.a']});assert.equal(v.a,a);assert.equal(v.nested.a,a)
    }
  }
} else if(group==='controls') {
  assert.equal(parse('--a "a b"').a,'a b')
  assert.equal(parse(['--a','"a b"']).a,'"a b"')
  assert.equal(parse('--a "cli"',{configObjects:[{a:'"config"'}],default:{a:'default'}}).a,'cli')
  process.env.CHAOS_PROBE_A='env'
  try {
    assert.equal(parse('',{envPrefix:'CHAOS_PROBE_',configObjects:[{a:'config'}],default:{a:'default'}}).a,'env')
    assert.equal(parse('--a cli',{envPrefix:'CHAOS_PROBE_',configObjects:[{a:'config'}]}).a,'cli')
  } finally {delete process.env.CHAOS_PROBE_A}
  assert.equal(parse([],{configObjects:[{a:'config'}],default:{a:'default'}}).a,'config')
  assert.equal(parse([],{default:{a:'default'}}).a,'default')
  const alias=parse([],{alias:{a:'alias'},configObjects:[{a:'"literal"'}]});assert.equal(alias.alias,'"literal"')
  const nested=parse([],{configuration:{'dot-notation':false},configObjects:[{'a.b':'"literal"'}]});assert.equal(nested['a.b'],'"literal"')
  const array=parse(['--a','cli'],{array:['a'],configuration:{'combine-arrays':true},configObjects:[{a:['"config"']}]});assert.deepEqual(array.a,['cli','"config"'])
  const typed=parse([],{string:['s'],number:['n'],boolean:['b'],configObjects:[{s:'12',n:'12',b:'true'}]});assert.equal(typed.s,'12');assert.equal(typed.n,12);assert.equal(typed.b,true)
} else throw Error('Unknown group')
console.log(JSON.stringify({group,passed:true}))
