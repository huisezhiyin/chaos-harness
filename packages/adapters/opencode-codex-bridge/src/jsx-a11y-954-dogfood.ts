#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import type { LoopBudget } from "../../../kernel/src/index.js"
import {
  main as runDailyCli,
  parseChaosDailyCliArgs,
  type ChaosDailyCliArgs,
} from "./daily-cli.js"
import {
  assertJsxA11y954Workspace,
  createJsxA11y954Verifier,
  qualifyJsxA11y954Verifier,
} from "./jsx-a11y-954-verifier.js"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"

export const JSX_A11Y_954_MODEL = "qwen3.8-max"
export const JSX_A11Y_954_ATTEMPT_BUDGET: Readonly<LoopBudget> = Object.freeze({
  maxTurns: 16,
  maxActions: 24,
  evidenceClosure: Object.freeze({
    maxTurns: 4,
    maxActions: 6,
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
    workspaceValidator?: typeof assertJsxA11y954Workspace
    qualifier?: typeof qualifyJsxA11y954Verifier
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
      throw new TypeError("jsx-a11y #954 trusted dogfood launcher supports only the qwen profile")
    }
    if (args.model !== JSX_A11Y_954_MODEL) {
      throw new TypeError(`jsx-a11y #954 dogfood requires model ${JSX_A11Y_954_MODEL}`)
    }
    await (dependencies.workspaceValidator ?? assertJsxA11y954Workspace)(args.root)
  } catch (error) {
    stderr(`${safeMessage(error, "jsx-a11y #954 dogfood preflight failed")}\n`)
    return 2
  }

  const pinnedArgs = args.modelExplicit
    ? forwarded
    : [...forwarded, "--model", JSX_A11Y_954_MODEL]
  if (qualifyOnly) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("qualification timed out")), 60_000)
    try {
      const qualification = await (dependencies.qualifier ?? qualifyJsxA11y954Verifier)(
        args.root,
        controller.signal,
      )
      stdout([
        `jsx-a11y #954 verifier qualification: ${qualification.passed ? "passed" : "failed"}`,
        `Pinned workspace verdict: ${qualification.workspacePassed ? "accepted" : "rejected-as-expected"}`,
        ...qualification.failedChecks.map((failure) => `- ${failure}`),
        "",
      ].join("\n"))
      return qualification.passed ? 0 : 1
    } catch {
      stderr("jsx-a11y #954 verifier qualification failed to run.\n")
      return 1
    } finally {
      clearTimeout(timeout)
    }
  }

  const verifier = dependencies.verifier ?? createJsxA11y954Verifier()
  return await (dependencies.dailyCli ?? runDailyCli)(pinnedArgs, {
    completionVerifier: verifier,
    attemptBudget: JSX_A11Y_954_ATTEMPT_BUDGET,
    stdout,
    stderr,
  })
}

function usage(): string {
  return [
    "Usage:",
    "  ./bin/chaos-jsx-a11y-954.mjs --root <fixed-sha-worktree> --qualify-only",
    "  ./bin/chaos-jsx-a11y-954.mjs --root <fixed-sha-worktree>",
    "",
    "Trusted dogfood launcher for eslint-plugin-jsx-a11y Issue #954 only.",
    `The live form pins ${JSX_A11Y_954_MODEL} and bounds each Attempt to ${String(JSX_A11Y_954_ATTEMPT_BUDGET.maxTurns)} work turns / ${String(JSX_A11Y_954_ATTEMPT_BUDGET.maxActions)} work actions plus a 4-turn / 6-action read-only evidence closure.`,
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
