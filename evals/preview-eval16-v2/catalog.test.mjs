import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const catalog=JSON.parse(await readFile(new URL('./catalog.json',import.meta.url)))
test('selection respects task mix, fixed source identities and provenance without false admission',()=>{
 assert.equal(catalog.tasks.length,16)
 assert.equal(new Set(catalog.tasks.map(t=>t.id)).size,16)
 for(const [kind,n] of Object.entries({bug:7,feature:3,refactor:3,tests:3}))assert.equal(catalog.tasks.filter(t=>t.kind===kind).length,n)
 const repos=new Set(catalog.tasks.map(t=>t.repo));assert.equal(repos.size,5)
 assert.deepEqual(catalog.executionPlan.order,catalog.tasks.map(t=>t.slug).sort((a,b)=>catalog.executionPlan.order.indexOf(a)-catalog.executionPlan.order.indexOf(b)));assert(!catalog.tasks.some(t=>['map-aborted-listener','normalize-query-predicate','query-value-helper','queue-priority-lifecycle'].includes(t.slug)))
 for(const t of catalog.tasks){assert.match(t.head,/^[a-f0-9]{40}$/);assert.match(t.tree,/^[a-f0-9]{40}$/);assert.equal(t.status,'selected-unqualified');assert(t.contract.length>80);assert(t.acceptance.length>=2);if(t.kind==='bug')assert.match(t.source,/github.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/)}
})
