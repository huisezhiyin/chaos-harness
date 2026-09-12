#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import {
  main as runDailyCli,
  parseChaosDailyCliArgs,
  type ChaosDailyCliArgs,
} from "./daily-cli.js"
import {
  assertPostHogWizard1198Workspace,
  createPostHogWizard1198Verifier,
} from "./posthog-wizard-1198-verifier.js"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    dailyCli?: typeof runDailyCli
    parseArgs?: typeof parseChaosDailyCliArgs
    workspaceValidator?: typeof assertPostHogWizard1198Workspace
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
      throw new TypeError("PostHog #1198 trusted dogfood launcher supports only the qwen profile")
    }
    await (dependencies.workspaceValidator ?? assertPostHogWizard1198Workspace)(args.root)
  } catch (error) {
    stderr(`${safeMessage(error, "PostHog #1198 dogfood preflight failed")}\n`)
    return 2
  }

  const verifier = dependencies.verifier ?? createPostHogWizard1198Verifier()
  if (qualifyOnly) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("qualification timed out")), 30_000)
    try {
      const verdict = await verifier.verify({
        missionId: "qualification",
        unitId: "posthog-wizard-1198",
        unitRevision: 1,
        attemptId: "model-free",
        workspaceRoot: args.root,
        goal: "qualify the fixed PostHog #1198 public behavior",
        completion: "model-free qualification",
        signal: controller.signal,
      })
      stdout(`PostHog #1198 verifier qualification: ${verdict.passed ? "passed" : "failed"}\n`)
      return verdict.passed ? 0 : 1
    } catch {
      stderr("PostHog #1198 verifier qualification failed to run.\n")
      return 1
    } finally {
      clearTimeout(timeout)
    }
  }

  return await (dependencies.dailyCli ?? runDailyCli)(forwarded, {
    completionVerifier: verifier,
    stdout,
    stderr,
  })
}

function usage(): string {
  return [
    "Usage:",
    "  ./bin/chaos-posthog-wizard-1198.mjs --root <fixed-sha-worktree> --qualify-only",
    "  ./bin/chaos-posthog-wizard-1198.mjs --root <fixed-sha-worktree>",
    "",
    "Trusted dogfood launcher for PostHog/wizard Issue #1198 only.",
    "The live form opens Qwen/OpenCode with a Harness-owned completion verifier.",
    "The qualification form runs the verifier without loading a provider or starting the TUI.",
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
