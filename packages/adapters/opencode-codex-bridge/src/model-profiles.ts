import { readFile } from "node:fs/promises"
import type { ChatWireOptions } from "../../deepseek/src/openai-chat-mapper.js"
import { OpenAICompatibleChatModelPort } from "../../deepseek/src/index.js"
import type { QwenProfile } from "./qwen.js"
import type { ModelPort } from "../../../kernel/src/index.js"

export interface BackendIdentity {
  profile: string
  adapter: "chat-api" | "codex-app-server"
  provider: string
  model: string
  controlDepth: "model-tool-turn" | "attempt"
}

export interface ChatAccessSettings extends ChatWireOptions {
  displayName?: string
  profile: string
  provider: string
  apiKeyEnv: string
  contextTokens: number
  maxOutputTokens: number
}

interface ProfileBase { name: string; model: string; enabled: boolean }
export type ModelProfile =
  | (ProfileBase & { adapter: "codex-app-server" })
  | (ProfileBase & { adapter: "chat-api"; baseUrl: string; access: Readonly<ChatAccessSettings> })

export class ModelProfileError extends Error {
  constructor(message: string) { super(message); this.name = "ModelProfileError" }
}

export async function readModelProfiles(path: string): Promise<ReadonlyMap<string, ModelProfile>> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, "utf8")) }
  catch { throw new ModelProfileError("Profiles file must be readable JSON; no configuration values were printed") }
  const root = object(value)
  fields(root, ["version", "profiles"])
  if (root.version !== 1) fail("Profiles version must be 1")
  const entries = object(root.profiles)
  if (Object.keys(entries).length === 0) fail("At least one profile is required")
  const profiles = new Map<string, ModelProfile>()
  for (const [name, raw] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) fail("Invalid profile name")
    const item = object(raw)
    const model = modelIdentifier(item.model)
    const enabled = item.enabled === undefined ? true : item.enabled
    if (typeof enabled !== "boolean") fail("enabled must be boolean")
    if (item.adapter === "codex-app-server") {
      fields(item, ["adapter", "model", "enabled"])
      profiles.set(name, Object.freeze({ name, model, enabled, adapter: item.adapter }))
      continue
    }
    if (item.adapter !== "chat-api") fail("adapter must be chat-api or codex-app-server")
    fields(item, ["adapter", "model", "enabled", "baseUrl", "provider", "apiKeyEnv", "dialect", "thinking", "contextTokens", "maxOutputTokens"])
    const provider = identifier(item.provider, "provider")
    const apiKeyEnv = text(item.apiKeyEnv)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) fail("apiKeyEnv must be an environment variable name")
    const dialect = item.dialect
    if (dialect !== "openai" && dialect !== "dashscope" && dialect !== "deepseek" && dialect !== "kimi" && dialect !== "openrouter") fail("Unsupported chat dialect")
    const thinking = item.thinking
    if (thinking !== "default" && thinking !== "enabled" && thinking !== "disabled") fail("thinking must be default, enabled or disabled")
    if (dialect === "openai" && thinking !== "default") fail("Generic openai dialect supports only default thinking")
    // Structured/encrypted reasoning_details are not represented by ModelMessage.
    if (dialect === "openrouter" && thinking !== "disabled") fail("OpenRouter currently requires disabled thinking; opaque reasoning continuation is not supported")
    const contextTokens = positive(item.contextTokens)
    const maxOutputTokens = positive(item.maxOutputTokens)
    if (maxOutputTokens >= contextTokens) fail("maxOutputTokens must be smaller than contextTokens")
    const access = Object.freeze({ profile: name, provider, apiKeyEnv, dialect, thinking, contextTokens, maxOutputTokens })
    profiles.set(name, Object.freeze({ name, model, enabled, adapter: "chat-api", baseUrl: endpoint(item.baseUrl), access }))
  }
  return profiles
}

export function selectModelProfile(profiles: ReadonlyMap<string, ModelProfile>, name: string, modelOverride?: string): ModelProfile {
  const selected = profiles.get(name)
  if (!selected) fail("Selected profile is not defined; no fallback was attempted")
  if (!selected.enabled) fail("Selected profile is disabled; configure and authorize its connection before enabling it")
  return Object.freeze({ ...selected, model: modelOverride === undefined ? selected.model : modelIdentifier(modelOverride) })
}

export function resolveChatProfile(profile: Extract<ModelProfile, { adapter: "chat-api" }>, env: NodeJS.ProcessEnv = process.env): QwenProfile {
  const apiKey = env[profile.access.apiKeyEnv]?.trim()
  if (!apiKey || /[\r\n]/.test(apiKey)) fail("Selected profile credential is missing or invalid; set its apiKeyEnv variable")
  return Object.freeze({ apiKey, baseUrl: profile.baseUrl, model: profile.model, access: profile.access })
}

export function profileIdentity(profile: ModelProfile): BackendIdentity {
  return profile.adapter === "chat-api"
    ? { profile: profile.name, adapter: profile.adapter, provider: profile.access.provider, model: profile.model, controlDepth: "model-tool-turn" }
    : { profile: profile.name, adapter: profile.adapter, provider: "codex", model: profile.model, controlDepth: "attempt" }
}

export function chatIdentity(profile: QwenProfile): BackendIdentity {
  return { profile: profile.access?.profile ?? "qwen", adapter: "chat-api", provider: profile.access?.provider ?? "dashscope", model: profile.model, controlDepth: "model-tool-turn" }
}

export function createProfileChatModel(profile: QwenProfile, fetchImpl?: typeof fetch): ModelPort {
  const model = new OpenAICompatibleChatModelPort({
    apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model,
    providerLabel: profile.access?.provider ?? "DashScope Qwen",
    maxTokens: profile.access?.maxOutputTokens ?? 32_768,
    ...(profile.preserveHostUserAgent && profile.hostUserAgent !== undefined
      ? { forwardedUserAgent: profile.hostUserAgent } : {}),
    ...(profile.access ? { wire: { dialect: profile.access.dialect, thinking: profile.access.thinking,
      ...(profile.access.setCacheKey === undefined ? {} : { setCacheKey: profile.access.setCacheKey }),
    } } : { enableThinking: true }),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return { async *stream(request, signal) {
    await profile.assertConnection?.()
    yield* model.stream(request, signal)
  } }
}

function endpoint(value: unknown): string {
  const input = text(value)
  try {
    const url = new URL(input)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) fail("unsafe")
    return url.href.replace(/\/+$/, "")
  } catch { return fail("baseUrl requires HTTPS or loopback HTTP, without credentials, query or fragment") }
}
function modelIdentifier(value: unknown): string {
  const model = text(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) fail("Invalid model identifier")
  return model
}
function identifier(value: unknown, label: string): string {
  const result = text(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result)) fail(`Invalid ${label} identifier`)
  return result
}
function text(value: unknown): string { if (typeof value !== "string" || !value.length) fail("Required profile string is missing"); return value }
function positive(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("Token limits must be positive integers"); return value }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("Profile configuration must contain objects"); return value as Record<string, unknown> }
function fields(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("Unknown profile field; use environment references for credentials") }
function fail(message: string): never { throw new ModelProfileError(message) }
