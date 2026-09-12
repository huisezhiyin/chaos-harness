import { readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const SCENARIOS = [
  "workspace",
  "fixture-fixed",
  "fixture-overbroad",
  "fixture-operator-loss",
  "fixture-partial",
]
const TARGET_CASES = [
  ["at-click", "@click"],
  ["hash-slot", "#slot"],
  ["bracket-prop", "[prop]"],
  ["paren-event", "(evt)"],
  ["percent-x", "%x"],
  ["caret-y", "^y"],
  ["tilde-z", "~z"],
]
const CONTROL_CASES = [
  ["ordinary-data", "data-x"],
  ["directive-aka", ":aka"],
  ["operator-plus", "class+"],
  ["operator-bang", "class!"],
]
const DOLLAR_ERROR = 'Attribute names cannot start with "$" (use ":" prefix for directives like ":aka", ":if", ":foreach")'

const args = parseArgs(process.argv.slice(2))
const root = await realpath(args.root)
const cases = args.scenario === "workspace"
  ? await runWorkspaceCases(root)
  : fixtureCases(args.scenario)

process.stdout.write(`${JSON.stringify({ scenario: args.scenario, cases })}\n`)

async function runWorkspaceCases(root) {
  const parserPath = join(root, "packages", "core", "src", "html", "parser.ts")
  const esbuildPath = join(root, "node_modules", "esbuild", "lib", "main.js")
  const esbuild = await import(pathToFileURL(esbuildPath).href)
  if (typeof esbuild.build !== "function") {
    throw new TypeError("Missing esbuild runtime")
  }
  const result = await esbuild.build({
    entryPoints: [parserPath],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  })
  const output = result.outputFiles?.[0]?.text
  if (typeof output !== "string") {
    throw new TypeError("Unable to bundle Markout parser source")
  }
  const module = { exports: {} }
  const require = createRequire(parserPath)
  const source = await readFile(parserPath, "utf8")
  if (!source.includes("function skipName")) {
    throw new TypeError("Markout parser source no longer contains the expected lexer entry")
  }
  new Function("module", "exports", "require", "__filename", "__dirname", output)(
    module,
    module.exports,
    require,
    parserPath,
    dirname(parserPath),
  )
  const parse = module.exports.parse
  if (typeof parse !== "function") {
    throw new TypeError("Bundled Markout parser has no parse export")
  }

  return [
    ...TARGET_CASES.map(([id, name]) => parseAttributeCase(parse, id, name)),
    ...CONTROL_CASES.map(([id, name]) => parseAttributeCase(parse, id, name)),
    parseAttributeCase(parse, "reserved-dollar", "$x"),
    parseTagBoundaryCase(parse),
  ]
}

function parseAttributeCase(parse, id, name) {
  const source = parse(`<button ${name}="x">hi</button>`, "chaos-markout-45.html")
  const button = findTag(source.doc, "BUTTON")
  const attributes = Array.isArray(button?.attributes)
    ? button.attributes.map(attribute => ({
        name: String(attribute.name),
        value: typeof attribute.value === "string" ? attribute.value : null,
      }))
    : []
  return {
    id,
    errors: source.errors.map(error => String(error.msg)),
    attributes,
    punctuationTagAccepted: false,
  }
}

function parseTagBoundaryCase(parse) {
  const source = parse('<@button data-x="x"></@button>', "chaos-markout-45.html")
  return {
    id: "punctuation-tag",
    errors: source.errors.map(error => String(error.msg)),
    attributes: [],
    punctuationTagAccepted: findTag(source.doc, "@BUTTON") !== undefined,
  }
}

function findTag(node, tagName) {
  if (node && node.tagName === tagName) return node
  if (!Array.isArray(node?.childNodes)) return undefined
  for (const child of node.childNodes) {
    const match = findTag(child, tagName)
    if (match !== undefined) return match
  }
  return undefined
}

function fixtureCases(scenario) {
  const cases = [
    ...TARGET_CASES.map(([id, name]) => acceptedCase(id, name)),
    ...CONTROL_CASES.map(([id, name]) => acceptedCase(id, name)),
    {
      id: "reserved-dollar",
      errors: [DOLLAR_ERROR],
      attributes: [],
      punctuationTagAccepted: false,
    },
    {
      id: "punctuation-tag",
      errors: [],
      attributes: [],
      punctuationTagAccepted: false,
    },
  ]
  if (scenario === "fixture-overbroad") {
    replaceCase(cases, "reserved-dollar", acceptedCase("reserved-dollar", "$x"))
  } else if (scenario === "fixture-operator-loss") {
    replaceCase(cases, "operator-plus", rejectedCase("operator-plus"))
    replaceCase(cases, "operator-bang", rejectedCase("operator-bang"))
  } else if (scenario === "fixture-partial") {
    replaceCase(cases, "bracket-prop", rejectedCase("bracket-prop"))
  }
  return cases
}

function acceptedCase(id, name) {
  return {
    id,
    errors: [],
    attributes: [{ name, value: "x" }],
    punctuationTagAccepted: false,
  }
}

function rejectedCase(id) {
  return {
    id,
    errors: ["Unterminated tag BUTTON"],
    attributes: [],
    punctuationTagAccepted: false,
  }
}

function replaceCase(cases, id, replacement) {
  const index = cases.findIndex(item => item.id === id)
  if (index < 0) throw new TypeError(`Missing fixture case: ${id}`)
  cases[index] = replacement
}

function parseArgs(argv) {
  let root
  let scenario
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new TypeError(`Missing value for ${String(flag)}`)
    if (flag === "--root") root = value
    else if (flag === "--scenario" && SCENARIOS.includes(value)) scenario = value
    else throw new TypeError(`Invalid Markout #45 probe option: ${String(flag)}`)
  }
  if (root === undefined || scenario === undefined) {
    throw new TypeError("Markout #45 probe requires --root and --scenario")
  }
  return { root, scenario }
}
