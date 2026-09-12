import { CodexAppServerClient, DEFAULT_CODEX_COMMAND } from "./client.js"
import { CodexAppServerError } from "./errors.js"
import { isRecord } from "./protocol.js"
import {
  assertCompatibleCodexCliVersion,
  CODEX_APP_SERVER_SCHEMA_PROFILE,
  readCodexCliVersion,
} from "./version.js"

export interface CodexAppServerSelfCheckOptions {
  command?: string
  initializeTimeoutMs?: number
  modelListTimeoutMs?: number
  readVersion?: (command: string) => Promise<string>
  createClient?: () => CodexAppServerClient
}

export type CodexModelListReadiness =
  | { status: "ready"; count: number }
  | { status: "safe_timeout" }
  | { status: "overloaded" }

export interface CodexAppServerSelfCheckResult {
  status: "ready" | "degraded"
  liveReady: false
  cliVersion: string
  schemaCompatibility: string
  initialize: {
    platformFamily: string
    platformOs: string
    userAgent: string
  }
  modelList: CodexModelListReadiness
}

export async function runCodexAppServerSelfCheck(
  options: CodexAppServerSelfCheckOptions = {},
): Promise<CodexAppServerSelfCheckResult> {
  const command = options.command ?? DEFAULT_CODEX_COMMAND
  const cliVersion = await (options.readVersion ?? readCodexCliVersion)(command)
  assertCompatibleCodexCliVersion(cliVersion)
  const client = options.createClient?.() ?? new CodexAppServerClient({
    command,
    requestTimeoutMs: options.initializeTimeoutMs ?? 5_000,
  })
  try {
    const initialize = await client.initialize()
    let modelList: CodexModelListReadiness
    try {
      const response = await client.request(
        "model/list",
        { includeHidden: false },
        { timeoutMs: options.modelListTimeoutMs ?? 10_000 },
      )
      const data = isRecord(response) && Array.isArray(response.data) ? response.data : undefined
      if (data === undefined) {
        throw new CodexAppServerError("protocol", "Invalid model/list response")
      }
      modelList = { status: "ready", count: data.length }
    } catch (error) {
      if (error instanceof CodexAppServerError && error.kind === "timeout") {
        modelList = { status: "safe_timeout" }
      } else if (error instanceof CodexAppServerError && error.kind === "overloaded") {
        modelList = { status: "overloaded" }
      } else {
        throw error
      }
    }
    return {
      status: modelList.status === "ready" ? "ready" : "degraded",
      liveReady: false,
      cliVersion,
      schemaCompatibility: CODEX_APP_SERVER_SCHEMA_PROFILE,
      initialize: {
        platformFamily: initialize.platformFamily,
        platformOs: initialize.platformOs,
        userAgent: initialize.userAgent,
      },
      modelList,
    }
  } finally {
    await client.shutdown()
  }
}
