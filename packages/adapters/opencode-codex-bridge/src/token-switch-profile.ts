import { lstat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { ModelProfileError } from "./model-profiles.js"
import type { QwenProfile } from "./qwen.js"

export const TOKEN_SWITCH_DOGFOOD_MODEL = "Qwen3.8-Max-DogFooding"
export const DEFAULT_TOKEN_SWITCH_CONFIG = join(homedir(), ".config", "opencode", "opencode.json")

/** Opt-in connection import only. No plugin/config installation or credential export. */
export async function loadTokenSwitchProfile(path = DEFAULT_TOKEN_SWITCH_CONFIG, pool: "dogfood" | "company" = "dogfood", selection?: string): Promise<QwenProfile> {
  const selected = await readSelectedConnection(path, pool, selection)
  return Object.freeze({
    apiKey: selected.apiKey,
    baseUrl: selected.baseUrl,
    model: selected.model,
    preserveHostUserAgent: true,
    access: Object.freeze({ profile: pool === "company" ? "qwen-company" : "dogfood", provider: "token-switch", apiKeyEnv: "CHAOS_DOGFOOD_API_KEY",
      displayName: selected.displayName, dialect: "openai" as const, thinking: "default" as const,
      setCacheKey: selected.setCacheKey,
      contextTokens: selected.contextTokens, maxOutputTokens: selected.maxOutputTokens }),
    assertConnection: async () => {
      const current = await readSelectedConnection(path, pool, selection)
      if (JSON.stringify(current) !== JSON.stringify(selected)) {
        throw new ModelProfileError("Token Switch connection changed; restart the Harness session with the intended Token Switch selection")
      }
    },
  })
}

async function readSelectedConnection(path: string, pool: "dogfood" | "company", selection?: string) {
  let root: Record<string, unknown>
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || info.size > 1_048_576 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe")
    root = record(JSON.parse(await readFile(path, "utf8")))
  } catch {
    throw new ModelProfileError("Token Switch OpenCode configuration must be readable owned JSON without symlinks or shared write access")
  }
  const allProviders = Object.entries(record(root.provider))
  const providers = selection === undefined ? allProviders : allProviders.filter(([, raw]) => {
    const models = Object.values(record(record(raw).models))
    return models.length === 1 && record(models[0]).name === selection
  })
  // Legacy selection requires one provider; explicit selection matches exactly one model display name.
  if (providers.length !== 1) fail(selection === undefined ? "Select only the intended Token Switch connection in Token Switch before launching" : "Token Switch requested model is missing or ambiguous; enable exactly one matching connection")
  const [providerId, rawProvider] = providers[0]!
  if (!/^mode-[A-Za-z0-9_-]+$/.test(providerId)) fail("Unsupported Token Switch provider identity")
  const provider = record(rawProvider)
  if (provider.npm !== "@ai-sdk/openai-compatible") fail("Token Switch provider must use the supported OpenAI-compatible protocol")
  const models = Object.entries(record(provider.models))
  if (models.length !== 1) fail("Token Switch profile must contain exactly one selected model")
  const [model, rawModel] = models[0]!
  const modelConfig = record(rawModel)
  const displayName = modelConfig.name
  if (model !== providerId || typeof displayName !== "string" || !displayName.trim() ||
      displayName.length > 128 || /[\x00-\x1f\x7f]/.test(displayName)) {
    fail("Token Switch selected model identity is invalid")
  }
  if (pool === "dogfood" && displayName !== TOKEN_SWITCH_DOGFOOD_MODEL) {
    fail("Token Switch is not configured for Qwen3.8-Max-DogFooding; select DogFood in Token Switch or use --qwen company")
  }
  if (pool === "company" && /dogfood/i.test(displayName)) {
    fail("Token Switch currently selects DogFood; select the company regular model or provide its --token-switch-config")
  }
  if ((selection === undefined && root.model !== undefined && root.model !== `${providerId}/${model}`) ||
      (modelConfig.options !== undefined && Object.keys(record(modelConfig.options)).length > 0)) {
    fail("Token Switch model selection or model options are not supported by this connection adapter")
  }
  const options = record(provider.options)
  if (Object.keys(options).some(key => !["apiKey", "baseURL", "setCacheKey"].includes(key)) ||
      (options.setCacheKey !== undefined && typeof options.setCacheKey !== "boolean")) {
    fail("Token Switch connection options require a compatibility review")
  }
  if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || options.apiKey.startsWith("{env:")) {
    fail("Token Switch local proxy credential is missing or unsupported")
  }
  let baseUrl: string
  try {
    if (typeof options.baseURL !== "string") throw new Error("missing")
    const url = new URL(options.baseURL)
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || !url.port ||
        url.username || url.password || url.search || url.hash ||
        url.pathname.replace(/\/+$/, "") !== `/opencode/${providerId}/v1`) throw new Error("unsupported")
    baseUrl = url.href.replace(/\/+$/, "")
  } catch { return fail("Token Switch requires its matching local loopback OpenCode proxy endpoint") }
  const limits = record(modelConfig.limit)
  const contextTokens = positive(limits.context), maxOutputTokens = positive(limits.output)
  if (maxOutputTokens >= contextTokens) fail("Token Switch context/output limits are invalid")
  return { providerId, model, displayName, apiKey: options.apiKey, baseUrl, contextTokens, maxOutputTokens, setCacheKey: options.setCacheKey === true }
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("Token Switch model limits must be positive integers")
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Token Switch configuration structure is unsupported")
  return value as Record<string, unknown>
}
function fail(message: string): never { throw new ModelProfileError(message) }
