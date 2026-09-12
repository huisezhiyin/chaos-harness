#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import type { LoopBudget } from "../../../kernel/src/index.js"
import {
  main as runDailyCli,
  parseChaosDailyCliArgs,
  type ChaosDailyCliArgs,
} from "./daily-cli.js"
import {
  assertTypescriptEslint12813Workspace,
  createTypescriptEslint12813Verifier,
  qualifyTypescriptEslint12813Verifier,
} from "./typescript-eslint-12813-verifier.js"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"

export const TYPESCRIPT_ESLINT_12813_MODEL = "qwen3.8-max"
export const TYPESCRIPT_ESLINT_12813_ATTEMPT_BUDGET: Readonly<LoopBudget> = Object.freeze({
  maxTurns: 24,
  maxActions: 32,
  evidenceClosure: Object.freeze({
    maxTurns: 5,
    maxActions: 8,
    allowedToolNames: Object.freeze([
      "bash",
      "read",
      "grep",
      "glob",
      "list",
      "search",
      "codesearch",
      "lsp",
      "todowrite",
      "runcheck",
      "test",
      "typecheck",
      "lint",
      "inspectchanges",
      "diff",
      "gitstatus",
    ]),
  }),
})

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    dailyCli?: typeof runDailyCli
    parseArgs?: typeof parseChaosDailyCliArgs
    workspaceValidator?: typeof assertTypescriptEslint12813Workspace
    qualifier?: typeof qualifyTypescriptEslint12813Verifier
    verifier?: QwenCompletionVerifier
    stdout?: (text: string) => void
    stderr?: (text: string) => void
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text))
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text))
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(`${usage()}\n`)
    return 0
  }
  const qualifyOnly = argv.includes("--qualify-only")
  const forwarded = argv.filter((argument) => argument !== "--qualify-only")
  let args: ChaosDailyCliArgs
  try {
    args = (dependencies.parseArgs ?? parseChaosDailyCliArgs)(forwarded)
    if (args.profilesFile || args.listProfiles || args.checkProfile || args.tokenSwitchConfig) {
      throw new TypeError("Fixed task launchers require the legacy Qwen connection; named profiles are only available through chaos")
    }
    if (args.profile !== "qwen") {
      throw new TypeError("typescript-eslint #12813 trusted dogfood launcher supports only the qwen profile")
    }
    if (args.model !== TYPESCRIPT_ESLINT_12813_MODEL) {
      throw new TypeError(`typescript-eslint #12813 dogfood requires model ${TYPESCRIPT_ESLINT_12813_MODEL}`)
    }
    await (dependencies.workspaceValidator ?? assertTypescriptEslint12813Workspace)(args.root)
  } catch (error) {
    stderr(`${safeMessage(error, "typescript-eslint #12813 dogfood preflight failed")}\n`)
    return 2
  }

  const pinnedArgs = args.modelExplicit
    ? forwarded
    : [...forwarded, "--model", TYPESCRIPT_ESLINT_12813_MODEL]
  if (qualifyOnly) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("qualification timed out")), 90_000)
    try {
      const qualification = await (
        dependencies.qualifier ?? qualifyTypescriptEslint12813Verifier
      )(args.root, controller.signal)
      stdout([
        `typescript-eslint #12813 verifier qualification: ${qualification.passed ? "passed" : "failed"}`,
        `Pinned workspace verdict: ${qualification.workspacePassed ? "accepted" : "rejected-as-expected"}`,
        ...qualification.failedChecks.map((failure) => `- ${failure}`),
        "",
      ].join("\n"))
      return qualification.passed ? 0 : 1
    } catch {
      stderr("typescript-eslint #12813 verifier qualification failed to run.\n")
      return 1
    } finally {
      clearTimeout(timeout)
    }
  }

  const verifier = dependencies.verifier ?? createTypescriptEslint12813Verifier()
  return await (dependencies.dailyCli ?? runDailyCli)(pinnedArgs, {
    completionVerifier: verifier,
    attemptBudget: TYPESCRIPT_ESLINT_12813_ATTEMPT_BUDGET,
    stdout,
    stderr,
  })
}

function usage(): string {
  return [
    "Usage:",
    "  ./bin/chaos-typescript-eslint-12813.mjs --root <fixed-sha-worktree> --qualify-only",
    "  ./bin/chaos-typescript-eslint-12813.mjs --root <fixed-sha-worktree>",
    "",
    "Trusted dogfood launcher for typescript-eslint Issue #12813 only.",
    `The live form pins ${TYPESCRIPT_ESLINT_12813_MODEL} and bounds each Attempt to ${String(TYPESCRIPT_ESLINT_12813_ATTEMPT_BUDGET.maxTurns)} work turns / ${String(TYPESCRIPT_ESLINT_12813_ATTEMPT_BUDGET.maxActions)} work actions plus a 5-turn / 8-action read-only evidence closure.`,
    "The qualification form expects the pinned unfixed baseline to fail while known-good behavior passes and three mutants fail.",
    "No provider is loaded and no TUI is started by --qualify-only.",
  ].join("\n")
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().then(
    (exitCode) => { process.exitCode = exitCode },
    () => { process.exitCode = 1 },
  )
}
