#!/usr/bin/env node
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_CODEX_COMMAND } from "./client.js"
import {
  codexDogfoodReviewExperiences,
  codexDogfoodReviewInterventions,
  codexDogfoodReviewVerifications,
  recordCodexDogfoodReview,
  runCodexDogfoodAttempt,
  type CodexDogfoodReviewExperience,
  type CodexDogfoodReviewIntervention,
  type CodexDogfoodReviewVerification,
} from "./dogfood.js"
import { runCodexAppServerSelfCheck } from "./self-check.js"

interface CodexCliArgs {
  help: boolean
  selfCheck: boolean
  review: boolean
  live: boolean
  allowDirty: boolean
  command: string
  root: string
  goal: string
  model: string | undefined
  recordPath: string | undefined
  runId: string | undefined
  verification: CodexDogfoodReviewVerification | undefined
  experience: CodexDogfoodReviewExperience | undefined
  intervention: CodexDogfoodReviewIntervention | undefined
  timeoutMs: number
  modelListTimeoutMs: number
  explicitCodexBin: boolean
  explicitRoot: boolean
  explicitTimeoutMs: boolean
  explicitModelListTimeoutMs: boolean
}

export class CodexAgentCliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = "CodexAgentCliError"
    this.exitCode = exitCode
  }
}

export function parseCodexAgentCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): CodexCliArgs {
  let help = false
  let selfCheck = false
  let review = false
  let live = false
  let allowDirty = false
  let command = DEFAULT_CODEX_COMMAND
  let root = cwd
  let model: string | undefined
  let recordPath: string | undefined
  let runId: string | undefined
  let verification: CodexDogfoodReviewVerification | undefined
  let experience: CodexDogfoodReviewExperience | undefined
  let intervention: CodexDogfoodReviewIntervention | undefined
  let timeoutMs = 1_800_000
  let modelListTimeoutMs = 10_000
  let explicitCodexBin = false
  let explicitRoot = false
  let explicitTimeoutMs = false
  let explicitModelListTimeoutMs = false
  const goal: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") {
      continue
    }
    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }
    if (argument === "--self-check") {
      selfCheck = true
      continue
    }
    if (argument === "--review") {
      review = true
      continue
    }
    if (argument === "--live") {
      live = true
      continue
    }
    if (argument === "--allow-dirty") {
      allowDirty = true
      continue
    }
    if (
      argument === "--root" ||
      argument === "--codex-bin" ||
      argument === "--model" ||
      argument === "--record" ||
      argument === "--run-id" ||
      argument === "--verification" ||
      argument === "--experience" ||
      argument === "--intervention" ||
      argument === "--timeout-ms" ||
      argument === "--model-list-timeout-ms"
    ) {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new CodexAgentCliError(`${argument} requires a value`)
      }
      if (argument === "--root") {
        root = resolve(cwd, value)
        explicitRoot = true
      } else if (argument === "--codex-bin") {
        command = resolve(cwd, value)
        explicitCodexBin = true
      } else if (argument === "--model") {
        model = value
      } else if (argument === "--record") {
        recordPath = resolve(cwd, value)
      } else if (argument === "--run-id") {
        runId = value
      } else if (argument === "--verification") {
        verification = parseEnumOption(argument, value, codexDogfoodReviewVerifications)
      } else if (argument === "--experience") {
        experience = parseEnumOption(argument, value, codexDogfoodReviewExperiences)
      } else if (argument === "--intervention") {
        intervention = parseEnumOption(argument, value, codexDogfoodReviewInterventions)
      } else if (argument === "--timeout-ms") {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_600_000) {
          throw new CodexAgentCliError("--timeout-ms must be an integer from 1 to 3600000")
        }
        timeoutMs = parsed
        explicitTimeoutMs = true
      } else {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 60_000) {
          throw new CodexAgentCliError("--model-list-timeout-ms must be an integer from 1 to 60000")
        }
        modelListTimeoutMs = parsed
        explicitModelListTimeoutMs = true
      }
      index += 1
      continue
    }
    if (argument?.startsWith("--") === true) {
      throw new CodexAgentCliError(`Unknown option: ${argument}`)
    }
    if (argument !== undefined) {
      goal.push(argument)
    }
  }

  return {
    help,
    selfCheck,
    review,
    live,
    allowDirty,
    command,
    root,
    goal: goal.join(" ").trim(),
    model,
    recordPath,
    runId,
    verification,
    experience,
    intervention,
    timeoutMs,
    modelListTimeoutMs,
    explicitCodexBin,
    explicitRoot,
    explicitTimeoutMs,
    explicitModelListTimeoutMs,
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    selfCheck?: typeof runCodexAppServerSelfCheck
    dogfoodRun?: typeof runCodexDogfoodAttempt
    dogfoodReview?: typeof recordCodexDogfoodReview
    stdout?: (text: string) => void
    stderr?: (text: string) => void
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text))
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text))
  let args: CodexCliArgs
  try {
    args = parseCodexAgentCliArgs(argv)
  } catch (error) {
    if (error instanceof CodexAgentCliError) {
      stderr(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }

  if (args.help) {
    stdout(`${usage()}\n`)
    return 0
  }
  if (args.review) {
    if (
      args.selfCheck ||
      args.live ||
      args.allowDirty ||
      args.goal.length > 0 ||
      args.model !== undefined ||
      args.explicitRoot ||
      args.explicitCodexBin ||
      args.explicitTimeoutMs ||
      args.explicitModelListTimeoutMs
    ) {
      stderr("--review cannot be combined with live-run options, self-check options, or a goal\n")
      return 2
    }
    if (args.recordPath === undefined) {
      stderr("--review requires --record\n")
      return 2
    }
    if (args.runId === undefined || args.runId.trim().length === 0) {
      stderr("--review requires --run-id\n")
      return 2
    }
    if (args.verification === undefined) {
      stderr("--review requires --verification passed|failed|not_run\n")
      return 2
    }
    if (args.experience === undefined) {
      stderr("--review requires --experience smooth|mixed|blocked\n")
      return 2
    }
    if (args.intervention === undefined) {
      stderr("--review requires --intervention none|minor|major\n")
      return 2
    }
    try {
      await (dependencies.dogfoodReview ?? recordCodexDogfoodReview)({
        recordPath: args.recordPath,
        runId: args.runId,
        verification: args.verification,
        experience: args.experience,
        intervention: args.intervention,
      })
      stdout("dogfood review recorded\n")
      return 0
    } catch (error) {
      stderr(`${error instanceof Error ? error.message : "Codex dogfood review failed"}\n`)
      return 1
    }
  }
  if (
    args.runId !== undefined ||
    args.verification !== undefined ||
    args.experience !== undefined ||
    args.intervention !== undefined
  ) {
    stderr("--run-id, --verification, --experience, and --intervention require --review\n")
    return 2
  }
  if (args.selfCheck) {
    if (
      args.goal.length > 0 ||
      args.live ||
      args.allowDirty ||
      args.model !== undefined ||
      args.recordPath !== undefined
    ) {
      stderr("--self-check cannot be combined with live-run options or a goal\n")
      return 2
    }
    try {
      const result = await (dependencies.selfCheck ?? runCodexAppServerSelfCheck)({
        command: args.command,
        modelListTimeoutMs: args.modelListTimeoutMs,
      })
      stdout(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    } catch (error) {
      stderr(`${error instanceof Error ? error.message : "Codex self-check failed"}\n`)
      return 1
    }
  }
  if (args.goal.length === 0) {
    stderr(`A goal, --review, or --self-check is required\n\n${usage()}\n`)
    return 2
  }
  if (!args.live) {
    stderr(
      `Live Codex turn gate is closed for ${args.root}. Pass --live only for an explicitly authorized dogfood task.\n`,
    )
    return 2
  }
  if (args.model === undefined || args.model.trim().length === 0) {
    stderr("--live requires an exact --model\n")
    return 2
  }
  if (args.recordPath === undefined) {
    stderr("--live requires an outside-workspace --record path\n")
    return 2
  }

  try {
    const run = await (dependencies.dogfoodRun ?? runCodexDogfoodAttempt)({
      workspaceRoot: args.root,
      goal: args.goal,
      model: args.model,
      recordPath: args.recordPath,
      command: args.command,
      timeoutMs: args.timeoutMs,
      allowDirty: args.allowDirty,
    })
    if (run.result.status === "completion_proposed") {
      stdout(`${run.result.completion}\n`)
      stderr(
        `harness=completion_proposed verification=pending boundary=${run.boundaryViolation ? "failed" : "passed"} record=${run.recordPath}\n`,
      )
      return run.boundaryViolation ? 1 : 0
    }
    stderr(
      `harness=${run.result.status} failure=${run.result.failure.kind} verification=pending record=${run.recordPath}\n`,
    )
    return 1
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : "Codex dogfood run failed"}\n`)
    return 1
  }
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm agent:codex -- --self-check [--codex-bin <path>] [--model-list-timeout-ms <ms>]",
    "  pnpm agent:codex -- --review --record <existing-private-jsonl> --run-id <finished-run-id> --verification passed|failed|not_run --experience smooth|mixed|blocked --intervention none|minor|major",
    "  pnpm agent:codex -- --live --root <git-worktree> --model <exact-model> --record <outside-workspace-jsonl> [--timeout-ms <ms>] [--allow-dirty] <goal>",
    "",
    "A goal never starts a Codex turn without --live; each live invocation runs one Attempt and leaves verification pending.",
  ].join("\n")
}

function parseEnumOption<const T extends readonly string[]>(
  option: string,
  value: string,
  allowed: T,
): T[number] {
  if (allowed.includes(value)) {
    return value
  }
  throw new CodexAgentCliError(`${option} must be ${allowed.join("|")}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Codex agent failed"}\n`)
      process.exitCode = 1
    },
  )
}
