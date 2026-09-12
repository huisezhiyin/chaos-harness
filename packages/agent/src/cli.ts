#!/usr/bin/env node
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DeepSeekChatModelPort } from "../../adapters/deepseek/src/index.js"
import {
  DeepSeekConfigurationError,
  defaultDeepSeekConfigPath,
  resolveDeepSeekConfig,
} from "./deepseek-config.js"
import { runCodingAgentAlpha } from "./coding-agent-alpha.js"
import { runGeneralAgentAlpha } from "./general-agent-alpha.js"

export interface AgentCliConfig {
  mode: "general" | "coding"
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  configPath: string
  credentialSource: "process_env" | "env_file"
  workspaceRoot: string
  prompt: string
}

export class AgentCliConfigurationError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = "AgentCliConfigurationError"
    this.exitCode = exitCode
  }
}

export async function resolveAgentCliConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<AgentCliConfig> {
  const promptParts: string[] = []
  let workspaceRoot = cwd
  let requestedConfigPath: string | undefined
  let mode: AgentCliConfig["mode"] = "general"

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") {
      continue
    }
    if (argument === "--root") {
      const root = argv[index + 1]
      if (root === undefined) {
        throw new AgentCliConfigurationError("--root requires a path")
      }
      workspaceRoot = root
      index += 1
      continue
    }
    if (argument === "--config") {
      const configPath = argv[index + 1]
      if (configPath === undefined) {
        throw new AgentCliConfigurationError("--config requires a path")
      }
      requestedConfigPath = configPath
      index += 1
      continue
    }
    if (argument === "--mode") {
      const requestedMode = argv[index + 1]
      if (requestedMode !== "general" && requestedMode !== "coding") {
        throw new AgentCliConfigurationError("--mode must be general or coding")
      }
      mode = requestedMode
      index += 1
      continue
    }
    if (argument === "--help" || argument === "-h") {
      throw new AgentCliConfigurationError(usage(), 0)
    }
    if (argument?.startsWith("--") === true) {
      throw new AgentCliConfigurationError(`Unknown option: ${argument}`)
    }
    if (argument !== undefined) {
      promptParts.push(argument)
    }
  }

  const prompt = promptParts.join(" ").trim()
  if (prompt.length === 0) {
    throw new AgentCliConfigurationError(`A prompt is required\n\n${usage()}`)
  }

  const absoluteWorkspaceRoot = resolve(cwd, workspaceRoot)
  const configPath = requestedConfigPath === undefined
    ? defaultDeepSeekConfigPath(absoluteWorkspaceRoot)
    : resolve(cwd, requestedConfigPath)
  let provider: Awaited<ReturnType<typeof resolveDeepSeekConfig>>
  try {
    provider = await resolveDeepSeekConfig(configPath, env)
  } catch (error) {
    if (error instanceof DeepSeekConfigurationError) {
      throw new AgentCliConfigurationError(error.message)
    }
    throw error
  }

  return {
    ...provider,
    mode,
    workspaceRoot: absoluteWorkspaceRoot,
    prompt,
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let config: AgentCliConfig
  try {
    config = await resolveAgentCliConfig(argv, env, process.cwd())
  } catch (error) {
    if (error instanceof AgentCliConfigurationError) {
      const output = error.exitCode === 0 ? process.stdout : process.stderr
      output.write(`${error.message}\n`)
      return error.exitCode
    }
    throw error
  }

  const model = new DeepSeekChatModelPort({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: config.maxTokens,
  })
  if (config.mode === "coding") {
    const result = await runCodingAgentAlpha({
      model,
      workspaceRoot: config.workspaceRoot,
      prompt: config.prompt,
    })
    if (
      result.outcome === "completion_accepted" &&
      result.attempt.status === "completion_proposed"
    ) {
      process.stdout.write(`${result.attempt.completion}\n`)
      process.stderr.write(
        `evidence=accepted files=${result.evidence.changedFiles.length} check=${result.evidence.lastSuccessfulCheck ?? "none"} turns=${result.attempt.usage.turns} actions=${result.attempt.usage.actions}\n`,
      )
      return 0
    }
    if (result.outcome === "evidence_rejected") {
      process.stderr.write(`Coding completion rejected: ${result.gaps.join(", ")}\n`)
      return 1
    }
    process.stderr.write(
      `Coding agent stopped: ${result.attempt.status === "completion_proposed" ? "unknown" : result.attempt.stopReason}\n`,
    )
    return 1
  }

  const result = await runGeneralAgentAlpha({
    model,
    workspaceRoot: config.workspaceRoot,
    prompt: config.prompt,
  })

  if (result.status === "completion_proposed") {
    process.stdout.write(`${result.completion}\n`)
    process.stderr.write(
      `turns=${result.usage.turns} actions=${result.usage.actions} provider_tokens=${result.usage.inputTokens + result.usage.outputTokens}\n`,
    )
    return 0
  }

  process.stderr.write(`Agent stopped: ${result.stopReason}\n`)
  return 1
}

function usage(): string {
  return [
    "Usage: pnpm agent -- [--mode general|coding] [--root <workspace>] [--config <path>] <prompt>",
    "Configuration: deepseek.config.json in the workspace root",
    "Overrides: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL, DEEPSEEK_MAX_TOKENS",
  ].join("\n")
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Agent failed"}\n`)
      process.exitCode = 1
    },
  )
}
