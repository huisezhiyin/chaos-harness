import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const catalog=JSON.parse(await readFile(new URL('./catalog.json',import.meta.url)))
test('selection respects task mix, fixed source identities and provenance without false admission',()=>{
 assert.equal(catalog.tasks.length,20)
 assert.equal(new Set(catalog.tasks.map(t=>t.id)).size,20)
 for(const [kind,n] of Object.entries({bug:8,feature:4,refactor:4,tests:4}))assert.equal(catalog.tasks.filter(t=>t.kind===kind).length,n)
 const repos=new Set(catalog.tasks.map(t=>t.repo));assert.equal(repos.size,5)
 for(const repo of repos)assert.equal(catalog.tasks.filter(t=>t.repo===repo).length,4)
 for(const t of catalog.tasks){assert.match(t.head,/^[a-f0-9]{40}$/);assert.match(t.tree,/^[a-f0-9]{40}$/);assert.equal(t.status,'selected-unqualified');assert(t.contract.length>80);assert(t.acceptance.length>=2);if(t.kind==='bug')assert.match(t.source,/github.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/)}
})
