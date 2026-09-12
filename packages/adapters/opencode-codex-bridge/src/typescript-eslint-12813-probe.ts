import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

type Scenario =
  | "workspace"
  | "fixture-fixed"
  | "fixture-scalar-rest"
  | "fixture-lost-diagnostic"
  | "fixture-double-array"

interface ProbeSuggestion {
  messageId: string
  output: string
  remainingReportCount: number
  ts2370Count: number
}

interface ProbeCaseResult {
  id: string
  reportCount: number
  messageIds: string[]
  suggestions: ProbeSuggestion[]
  autofix: {
    fixed: boolean
    output: string
    remainingReportCount: number
    ts2370Count: number
  }
}

interface LintSuggestion {
  messageId?: string
  fix: { range: [number, number]; text: string }
}

interface LintMessage {
  ruleId: string | null
  messageId?: string
  suggestions?: LintSuggestion[]
}

interface LinterInstance {
  verify(code: string, config: readonly unknown[], filename: string): LintMessage[]
  verifyAndFix(code: string, config: readonly unknown[], filename: string): {
    fixed: boolean
    output: string
  }
}

interface LinterConstructor {
  new(options: { configType: "flat" }): LinterInstance
}

const CASES = [
  { id: "function-rest", code: "function fn(...args: any) {}" },
  { id: "arrow-rest", code: "const fn = (...args: any) => {};" },
  { id: "call-signature-rest", code: "type Fn = (...args: any) => void;" },
  { id: "method-signature-rest", code: "interface Api { fn(...args: any): void; }" },
  { id: "ordinary-scalar", code: "const value: any = 1;" },
  { id: "existing-rest-array", code: "function existing(...args: any[]) {}" },
] as const

const args = parseArgs(process.argv.slice(2))
const root = await realpath(args.root)
const [eslintModule, parserModule, typescriptModule] = await Promise.all([
  importTarget(root, "node_modules/eslint/lib/api.js"),
  importTarget(root, "packages/parser/dist/index.js"),
  importTarget(root, "node_modules/typescript/lib/typescript.js"),
])
const Linter = readExport(eslintModule, "Linter") as LinterConstructor
const parser = readDefault(parserModule)
const typescript = readDefault(typescriptModule) as Record<string, any>
const rule = args.scenario === "workspace"
  ? readDefault(await importTarget(root, "packages/eslint-plugin/src/rules/no-explicit-any.ts"))
  : createFixtureRule(args.scenario)

const results = CASES.map(({ id, code }) => runCase(id, code))
process.stdout.write(`${JSON.stringify({ scenario: args.scenario, cases: results })}\n`)

function runCase(id: string, code: string): ProbeCaseResult {
  const linter = new Linter({ configType: "flat" })
  const messages = linter.verify(code, config(false), `${id}.ts`)
    .filter((message) => message.ruleId === "chaos/no-explicit-any")
  const suggestions = messages.flatMap((message) => (message.suggestions ?? []).map((suggestion) => {
    const output = applyFix(code, suggestion.fix)
    return {
      messageId: suggestion.messageId ?? "",
      output,
      remainingReportCount: countReports(output, false),
      ts2370Count: countTs2370(output),
    }
  }))
  const autofix = linter.verifyAndFix(code, config(true), `${id}.ts`)
  return {
    id,
    reportCount: messages.length,
    messageIds: messages.map((message) => message.messageId ?? ""),
    suggestions,
    autofix: {
      fixed: autofix.fixed,
      output: autofix.output,
      remainingReportCount: countReports(autofix.output, false),
      ts2370Count: countTs2370(autofix.output),
    },
  }
}

function countReports(code: string, fixToUnknown: boolean): number {
  const linter = new Linter({ configType: "flat" })
  return linter.verify(code, config(fixToUnknown), "post-fix.ts")
    .filter((message) => message.ruleId === "chaos/no-explicit-any")
    .length
}

function config(fixToUnknown: boolean): readonly unknown[] {
  return [{
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { chaos: { rules: { "no-explicit-any": rule } } },
    rules: { "chaos/no-explicit-any": ["error", { fixToUnknown }] },
  }]
}

function createFixtureRule(scenario: Exclude<Scenario, "workspace">): Record<string, unknown> {
  return {
    meta: {
      type: "suggestion",
      fixable: "code",
      hasSuggestions: true,
      schema: [{ type: "object", properties: { fixToUnknown: { type: "boolean" } } }],
      messages: {
        unexpectedAny: "Unexpected any.",
        suggestUnknown: "Use unknown.",
        suggestNever: "Use never.",
      },
    },
    create(context: {
      options: Array<{ fixToUnknown?: boolean }>
      report(descriptor: Record<string, unknown>): void
    }) {
      return {
        TSAnyKeyword(node: Record<string, any>): void {
          const bareRest = isBareRestAny(node)
          const arrayRest = isArrayRestAny(node)
          if (scenario === "fixture-lost-diagnostic" && bareRest) return
          const replacement = (scalar: "unknown" | "never"): string => {
            if (scenario === "fixture-scalar-rest") return scalar
            if (scenario === "fixture-double-array" && (bareRest || arrayRest)) return `${scalar}[]`
            return bareRest ? `${scalar}[]` : scalar
          }
          context.report({
            node,
            messageId: "unexpectedAny",
            suggest: [
              {
                messageId: "suggestUnknown",
                fix: (fixer: { replaceText(target: unknown, text: string): unknown }) =>
                  fixer.replaceText(node, replacement("unknown")),
              },
              {
                messageId: "suggestNever",
                fix: (fixer: { replaceText(target: unknown, text: string): unknown }) =>
                  fixer.replaceText(node, replacement("never")),
              },
            ],
            ...(context.options[0]?.fixToUnknown === true
              ? {
                  fix: (fixer: { replaceText(target: unknown, text: string): unknown }) =>
                    fixer.replaceText(node, replacement("unknown")),
                }
              : {}),
          })
        },
      }
    },
  }
}

function isBareRestAny(node: Record<string, any>): boolean {
  return node.parent?.type === "TSTypeAnnotation" && node.parent.parent?.type === "RestElement"
}

function isArrayRestAny(node: Record<string, any>): boolean {
  return node.parent?.type === "TSArrayType" &&
    node.parent.parent?.type === "TSTypeAnnotation" &&
    node.parent.parent.parent?.type === "RestElement"
}

function countTs2370(code: string): number {
  const fileName = "/virtual/chaos-probe.ts"
  const options = {
    module: typescript.ModuleKind.ESNext,
    noEmit: true,
    noLib: true,
    strict: true,
    target: typescript.ScriptTarget.ESNext,
  }
  const host = typescript.createCompilerHost(options)
  host.fileExists = (candidate: string) => candidate === fileName
  host.readFile = (candidate: string) => candidate === fileName ? code : undefined
  host.getSourceFile = (candidate: string, languageVersion: unknown) =>
    candidate === fileName
      ? typescript.createSourceFile(candidate, code, languageVersion, true)
      : undefined
  host.writeFile = () => undefined
  const program = typescript.createProgram([fileName], options, host)
  return typescript.getPreEmitDiagnostics(program)
    .filter((diagnostic: { code: number }) => diagnostic.code === 2370)
    .length
}

function applyFix(code: string, fix: LintSuggestion["fix"]): string {
  return `${code.slice(0, fix.range[0])}${fix.text}${code.slice(fix.range[1])}`
}

async function importTarget(rootPath: string, relativePath: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(join(rootPath, relativePath)).href) as Record<string, unknown>
}

function readExport(module: Record<string, unknown>, name: string): unknown {
  if (module[name] !== undefined) return module[name]
  const fallback = asRecord(module.default)
  if (fallback[name] !== undefined) return fallback[name]
  throw new TypeError(`Missing runtime export: ${name}`)
}

function readDefault(module: Record<string, unknown>): unknown {
  let value: unknown = module.default ?? module
  while (asRecord(value).default !== undefined) value = asRecord(value).default
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function parseArgs(argv: readonly string[]): { root: string; scenario: Scenario } {
  let root: string | undefined
  let scenario: Scenario | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new TypeError(`Missing value for ${String(flag)}`)
    if (flag === "--root") root = value
    else if (flag === "--scenario" && isScenario(value)) scenario = value
    else throw new TypeError(`Invalid typescript-eslint #12813 probe option: ${String(flag)}`)
  }
  if (root === undefined || scenario === undefined) {
    throw new TypeError("typescript-eslint #12813 probe requires --root and --scenario")
  }
  return { root, scenario }
}

function isScenario(value: string): value is Scenario {
  return [
    "workspace",
    "fixture-fixed",
    "fixture-scalar-rest",
    "fixture-lost-diagnostic",
    "fixture-double-array",
  ].includes(value)
}
