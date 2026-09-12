import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import ts from 'typescript'

const [root, slug] = process.argv.slice(2)
const source = await readFile(join(root, slug.startsWith('query-') ? 'base.js' : 'index.js'), 'utf8')
const ast = ts.createSourceFile('candidate.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const functions = new Map()
for (const statement of ast.statements) {
 if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement)
 if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
  if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) functions.set(declaration.name.text, declaration.initializer)
 }
}
function scan(node, predicate) {
 const out=[]
 if (!node) return out
 function walk(n) { if (predicate(n)) out.push(n);ts.forEachChild(n,walk) }
 walk(node)
 return out
}
const calls = node => new Set(scan(node, n=>ts.isCallExpression(n)&&ts.isIdentifier(n.expression)).map(n=>n.expression.text))
const properties = node => new Set(scan(node,ts.isPropertyAccessExpression).map(n=>n.name.text))
const privateHelper = name => {
 const f=functions.get(name)
 return f && !f.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword) && scan(f,()=>true).length>15
}
try {
 assert.equal(ast.parseDiagnostics.length,0)
 if (slug === 'map-validation-helper') {
  const first=calls(functions.get('pMap')), second=calls(functions.get('pMapIterable'))
  assert([...first].some(name=>second.has(name)&&privateHelper(name)&&scan(functions.get(name),ts.isThrowStatement).length>=2))
 } else if (slug === 'query-value-helper') {
  const helpers=[...calls(functions.get('parseValue'))].filter(privateHelper)
  assert(helpers.length>=2)
  assert(helpers.some(name=>properties(functions.get(name)).has('parseNumbers')&&properties(functions.get(name)).has('parseBooleans')))
  assert(helpers.some(name=>scan(functions.get(name),n=>ts.isTypeOfExpression(n)).length>0))
 } else if (slug === 'normalize-data-helper') {
  assert([...calls(functions.get('normalizeDataURL'))].some(name=>privateHelper(name)&&properties(functions.get(name)).has('toLowerCase')&&properties(functions.get(name)).has('split')))
 } else if (slug === 'normalize-query-helper') {
  assert([...calls(functions.get('normalizeUrl'))].some(name=>privateHelper(name)&&properties(functions.get(name)).has('searchParams')&&properties(functions.get(name)).has('sortQueryParameters')))
 } else throw new Error('Unknown refactor task')
 console.log(JSON.stringify({passed:true,slug}))
} catch (error) {
 console.log(JSON.stringify({passed:false,slug,errorCode:error.code??null,message:error.message}));process.exitCode=1
}
