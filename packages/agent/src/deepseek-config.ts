import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export interface DeepSeekProjectConfig {
  version: 1
  provider: "deepseek"
  baseUrl: string
  model: string
  maxTokens: number
  credential: {
    env: string
    envFile: string
  }
}

export interface ResolvedDeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  configPath: string
  credentialSource: "process_env" | "env_file"
}

export class DeepSeekConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeepSeekConfigurationError"
  }
}

export async function resolveDeepSeekConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedDeepSeekConfig> {
  const absoluteConfigPath = resolve(configPath)
  const config = await loadDeepSeekProjectConfig(absoluteConfigPath)
  const directApiKey = nonEmptyOptional(env.DEEPSEEK_API_KEY)
    ?? nonEmptyOptional(env[config.credential.env])

  let apiKey = directApiKey
  let credentialSource: ResolvedDeepSeekConfig["credentialSource"] = "process_env"
  if (apiKey === undefined) {
    const credentialPath = expandHome(config.credential.envFile, env.HOME ?? homedir())
    const assignments = parseEnvAssignments(
      await readFileOrConfigError(credentialPath, "credential file"),
    )
    apiKey = nonEmptyOptional(assignments[config.credential.env])
    credentialSource = "env_file"
  }
  if (apiKey === undefined) {
    throw new DeepSeekConfigurationError(
      `Credential variable ${config.credential.env} is not available`,
    )
  }

  return {
    apiKey,
    baseUrl: nonEmptyOptional(env.DEEPSEEK_BASE_URL) ?? config.baseUrl,
    model: nonEmptyOptional(env.DEEPSEEK_MODEL) ?? config.model,
    maxTokens: parsePositiveIntegerOverride(
      env.DEEPSEEK_MAX_TOKENS,
      config.maxTokens,
      "DEEPSEEK_MAX_TOKENS",
    ),
    configPath: absoluteConfigPath,
    credentialSource,
  }
}

export async function loadDeepSeekProjectConfig(
  configPath: string,
): Promise<DeepSeekProjectConfig> {
  const text = await readFileOrConfigError(configPath, "DeepSeek config")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DeepSeekConfigurationError("DeepSeek config is not valid JSON")
  }
  rejectSecretFields(parsed)
  const root = record(parsed, "DeepSeek config")
  assertKnownKeys(
    root,
    ["version", "provider", "baseUrl", "model", "maxTokens", "credential"],
    "DeepSeek config",
  )
  if (root.version !== 1) {
    throw new DeepSeekConfigurationError("DeepSeek config version must be 1")
  }
  if (root.provider !== "deepseek") {
    throw new DeepSeekConfigurationError("DeepSeek config provider must be deepseek")
  }
  const baseUrl = nonEmptyString(root.baseUrl, "baseUrl")
  assertHttpUrl(baseUrl)
  const model = nonEmptyString(root.model, "model")
  const maxTokens = positiveInteger(root.maxTokens, "maxTokens")
  const credential = record(root.credential, "credential")
  assertKnownKeys(credential, ["env", "envFile"], "credential")
  const credentialEnv = nonEmptyString(credential.env, "credential.env")
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) {
    throw new DeepSeekConfigurationError("credential.env must be an environment variable name")
  }
  const envFile = nonEmptyString(credential.envFile, "credential.envFile")

  return {
    version: 1,
    provider: "deepseek",
    baseUrl,
    model,
    maxTokens,
    credential: { env: credentialEnv, envFile },
  }
}

export function parseEnvAssignments(text: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) {
      continue
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) {
      continue
    }
    const key = match[1]
    const rawValue = match[2]
    if (key === undefined || rawValue === undefined) {
      continue
    }
    result[key] = unquote(rawValue.trim())
  }
  return Object.freeze(result)
}

export function defaultDeepSeekConfigPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), "deepseek.config.json")
}

function rejectSecretFields(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, `${path}[${index}]`))
    return
  }
  if (typeof value !== "object" || value === null) {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (["apikey", "token", "secret", "password"].includes(normalized)) {
      throw new DeepSeekConfigurationError(
        `Secret field is forbidden in project config: ${path}.${key}`,
      )
    }
    rejectSecretFields(child, `${path}.${key}`)
  }
}

function expandHome(value: string, home: string): string {
  const expanded = value.replaceAll("${HOME}", home)
  if (expanded === "~") {
    return home
  }
  if (expanded.startsWith("~/")) {
    return join(home, expanded.slice(2))
  }
  if (expanded.includes("${")) {
    throw new DeepSeekConfigurationError("credential.envFile contains an unknown variable")
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

async function readFileOrConfigError(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined
    throw new DeepSeekConfigurationError(
      `${label} cannot be read${typeof code === "string" ? ` (${code})` : ""}`,
    )
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeepSeekConfigurationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  if (unknown.length > 0) {
    throw new DeepSeekConfigurationError(`${label} contains unknown field: ${unknown[0]}`)
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DeepSeekConfigurationError(`${label} must be a non-empty string`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DeepSeekConfigurationError(`${label} must be a positive integer`)
  }
  return value
}

function parsePositiveIntegerOverride(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DeepSeekConfigurationError(`${label} must be a positive integer`)
  }
  return parsed
}

function assertHttpUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new DeepSeekConfigurationError("baseUrl must be a valid URL")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DeepSeekConfigurationError("baseUrl must use http or https")
  }
}

function nonEmptyOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined
  }
  return value.trim()
}

function unquote(value: string): string {
  if (value.length < 2) {
    return value
  }
  const first = value[0]
  const last = value.at(-1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}
