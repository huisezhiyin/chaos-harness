#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import type { LoopBudget } from "../../../kernel/src/index.js"
import {
  main as runDailyCli,
  parseChaosDailyCliArgs,
  type ChaosDailyCliArgs,
} from "./daily-cli.js"
import {
  assertMarkout45Workspace,
  createMarkout45Verifier,
  qualifyMarkout45Verifier,
} from "./markout-45-verifier.js"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"

export const MARKOUT_45_MODEL = "qwen3.8-max"
export const MARKOUT_45_ATTEMPT_BUDGET: Readonly<LoopBudget> = Object.freeze({
  maxTurns: 18,
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
    workspaceValidator?: typeof assertMarkout45Workspace
    qualifier?: typeof qualifyMarkout45Verifier
    verifier?: QwenCompletionVerifier
    stdout?: (text: string) => void
    stderr?: (text: string) => void
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? (text => process.stdout.write(text))
  const stderr = dependencies.stderr ?? (text => process.stderr.write(text))
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(`${usage()}\n`)
    return 0
  }
  const qualifyOnly = argv.includes("--qualify-only")
  const forwarded = argv.filter(argument => argument !== "--qualify-only")
  let args: ChaosDailyCliArgs
  try {
    args = (dependencies.parseArgs ?? parseChaosDailyCliArgs)(forwarded)
    if (args.profilesFile || args.listProfiles || args.checkProfile || args.tokenSwitchConfig) {
      throw new TypeError("Fixed task launchers require the legacy Qwen connection; named profiles are only available through chaos")
    }
    if (args.profile !== "qwen") {
      throw new TypeError("Markout #45 trusted dogfood launcher supports only the qwen profile")
    }
    if (args.model !== MARKOUT_45_MODEL) {
      throw new TypeError(`Markout #45 dogfood requires model ${MARKOUT_45_MODEL}`)
    }
    await (dependencies.workspaceValidator ?? assertMarkout45Workspace)(args.root)
  } catch (error) {
    stderr(`${safeMessage(error, "Markout #45 dogfood preflight failed")}\n`)
    return 2
  }

  const pinnedArgs = args.modelExplicit ? forwarded : [...forwarded, "--model", MARKOUT_45_MODEL]
  if (qualifyOnly) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("qualification timed out")), 60_000)
    try {
      const qualification = await (dependencies.qualifier ?? qualifyMarkout45Verifier)(
        args.root,
        controller.signal,
      )
      stdout([
        `Markout #45 verifier qualification: ${qualification.passed ? "passed" : "failed"}`,
        `Pinned workspace verdict: ${qualification.workspacePassed ? "accepted" : "rejected-as-expected"}`,
        ...qualification.failedChecks.map(failure => `- ${failure}`),
        "",
      ].join("\n"))
      return qualification.passed ? 0 : 1
    } catch {
      stderr("Markout #45 verifier qualification failed to run.\n")
      return 1
    } finally {
      clearTimeout(timeout)
    }
  }

  const verifier = dependencies.verifier ?? createMarkout45Verifier()
  return await (dependencies.dailyCli ?? runDailyCli)(pinnedArgs, {
    completionVerifier: verifier,
    attemptBudget: MARKOUT_45_ATTEMPT_BUDGET,
    stdout,
    stderr,
  })
}

function usage(): string {
  return [
    "Usage:",
    "  ./bin/chaos-markout-45.mjs --root <fixed-sha-worktree> --qualify-only",
    "  ./bin/chaos-markout-45.mjs --root <fixed-sha-worktree>",
    "",
    "Trusted dogfood launcher for Markout Issue #45 only.",
    `The live form pins ${MARKOUT_45_MODEL} and bounds each Attempt to ${String(MARKOUT_45_ATTEMPT_BUDGET.maxTurns)} work turns / ${String(MARKOUT_45_ATTEMPT_BUDGET.maxActions)} work actions plus a 4-turn / 6-action read-only evidence closure.`,
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
    exitCode => { process.exitCode = exitCode },
    () => { process.exitCode = 1 },
  )
}
