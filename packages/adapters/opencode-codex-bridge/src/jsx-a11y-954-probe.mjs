import { realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"

const RULE_ID = "chaos/control-has-associated-label"
const ERROR_MESSAGE = "A control must be associated with a text label."
const SCENARIOS = [
  "workspace",
  "fixture-fixed",
  "fixture-td-only",
  "fixture-lost-empty",
  "fixture-lost-established",
]
const CASES = [
  {
    id: "issue-self-closing",
    code: '<td dangerouslySetInnerHTML={{ __html: parseMarkdownLinks(prop.description) }} />',
  },
  {
    id: "issue-explicit-closing",
    code: '<td dangerouslySetInnerHTML={{ __html: parseMarkdownLinks(prop.description) }}></td>',
  },
  {
    id: "native-dangerous",
    code: '<button dangerouslySetInnerHTML={{ __html: "Save" }} />',
  },
  {
    id: "role-dangerous",
    code: '<div role="button" dangerouslySetInnerHTML={{ __html: "Save" }} />',
  },
  { id: "text-control", code: "<button>Save</button>" },
  { id: "aria-control", code: '<button aria-label="Save" />' },
  { id: "empty-td", code: "<td />" },
  { id: "empty-button", code: "<button />" },
  { id: "empty-role", code: '<div role="button" />' },
]

const args = parseArgs(process.argv.slice(2))
const root = await realpath(args.root)
const workspaceRequire = createRequire(join(root, "package.json"))
const { Linter } = workspaceRequire("eslint")
if (typeof Linter !== "function") {
  throw new TypeError("Missing ESLint Linter runtime")
}

const rule = args.scenario === "workspace"
  ? loadWorkspaceRule(workspaceRequire)
  : createFixtureRule(args.scenario)
const results = CASES.map(({ id, code }) => {
  const linter = new Linter()
  linter.defineRule(RULE_ID, rule)
  const diagnostics = linter.verify(code, {
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
    rules: { [RULE_ID]: "error" },
  }, "chaos-probe.jsx").map((diagnostic) => ({
    ruleId: diagnostic.ruleId,
    message: diagnostic.message,
    fatal: diagnostic.fatal === true,
  }))
  return { id, diagnostics }
})

process.stdout.write(`${JSON.stringify({ scenario: args.scenario, cases: results })}\n`)

function loadWorkspaceRule(workspaceRequire) {
  const registerModule = workspaceRequire("@babel/register")
  const register = typeof registerModule === "function"
    ? registerModule
    : asRecord(registerModule).default
  if (typeof register !== "function") {
    throw new TypeError("Missing Babel register runtime")
  }
  register({ extensions: [".js"], cache: false })
  return readDefault(workspaceRequire("./src/rules/control-has-associated-label.js"))
}

function createFixtureRule(scenario) {
  return {
    meta: { schema: [] },
    create(context) {
      return {
        JSXElement(node) {
          const element = asRecord(node)
          const opening = asRecord(element.openingElement)
          const tag = jsxName(opening.name)
          const attributes = Array.isArray(opening.attributes) ? opening.attributes : []
          const role = attributeLiteral(attributes, "role")
          if (tag !== "td" && tag !== "button" && role !== "button") return

          const hasDangerousContent = hasAttribute(attributes, "dangerouslySetInnerHTML")
          const hasEstablishedLabel = hasVisibleText(element.children) ||
            Boolean(attributeLiteral(attributes, "aria-label")?.trim())
          let hasLabel
          if (scenario === "fixture-lost-empty") {
            hasLabel = true
          } else if (scenario === "fixture-td-only") {
            hasLabel = hasEstablishedLabel || (tag === "td" && hasDangerousContent)
          } else if (scenario === "fixture-lost-established") {
            hasLabel = hasDangerousContent
          } else {
            hasLabel = hasEstablishedLabel || hasDangerousContent
          }

          if (!hasLabel) context.report({ node: opening, message: ERROR_MESSAGE })
        },
      }
    },
  }
}

function hasVisibleText(children) {
  return Array.isArray(children) && children.some((child) => {
    const value = asRecord(child)
    return (value.type === "JSXText" || value.type === "Literal") &&
      typeof value.value === "string" && value.value.trim().length > 0
  })
}

function hasAttribute(attributes, name) {
  return attributes.some((attribute) => jsxName(asRecord(attribute).name) === name)
}

function attributeLiteral(attributes, name) {
  const attribute = attributes.find((candidate) => jsxName(asRecord(candidate).name) === name)
  const value = asRecord(asRecord(attribute).value).value
  return typeof value === "string" ? value : undefined
}

function jsxName(value) {
  const name = asRecord(value).name
  return typeof name === "string" ? name : undefined
}

function readDefault(value) {
  let current = value
  const seen = new Set()
  while (isRecord(current) && current.default !== undefined && !seen.has(current)) {
    seen.add(current)
    current = current.default
  }
  return current
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
    else throw new TypeError(`Invalid jsx-a11y #954 probe option: ${String(flag)}`)
  }
  if (root === undefined || scenario === undefined) {
    throw new TypeError("jsx-a11y #954 probe requires --root and --scenario")
  }
  return { root, scenario }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value) {
  return isRecord(value) ? value : {}
}
