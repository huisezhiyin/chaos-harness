import {
  emptyHostAttemptUsage,
  type HostActionObservation,
  type HostArtifactChange,
  type HostAttemptEvent,
  type HostAttemptPort,
  type HostAttemptRequest,
  type HostAttemptResult,
  type HostAttemptUsage,
  type HostFailure,
  type JsonObject,
  type JsonValue,
} from "../../../kernel/src/index.js"
import { CodexAppServerClient, type CodexServerRequestHandler } from "./client.js"
import { CodexAppServerError } from "./errors.js"
import { isRecord, type CodexServerNotification, type CodexServerRequest } from "./protocol.js"
import {
  assertCompatibleCodexCliVersion,
  SUPPORTED_CODEX_CLI_VERSION,
} from "./version.js"

export interface CodexApprovalPort {
  review(request: CodexServerRequest, signal: AbortSignal): Promise<JsonValue>
}

export interface CodexAppServerAttemptAdapterOptions {
  liveEnabled?: boolean
  cliVersion?: string
  command?: string
  approvalPort?: CodexApprovalPort
  createClient?: (handler: CodexServerRequestHandler) => CodexAppServerClient
}

export class CodexAppServerAttemptAdapter implements HostAttemptPort {
  readonly capabilities = [
    "model_loop",
    "workspace_read",
    "workspace_mutation",
    "process_execution",
    "artifact_diff",
    "abort",
    "realtime_observation",
    "permission_interception",
  ] as const

  private readonly liveEnabled: boolean
  private readonly cliVersion: string
  private readonly approvalPort: CodexApprovalPort | undefined
  private readonly createClient: (handler: CodexServerRequestHandler) => CodexAppServerClient

  constructor(options: CodexAppServerAttemptAdapterOptions = {}) {
    this.liveEnabled = options.liveEnabled ?? false
    this.cliVersion = options.cliVersion ?? SUPPORTED_CODEX_CLI_VERSION
    this.approvalPort = options.approvalPort
    this.createClient = options.createClient ?? ((handler) =>
      new CodexAppServerClient({
        ...(options.command === undefined ? {} : { command: options.command }),
        serverRequestHandler: handler,
      }))
  }

  async run(request: HostAttemptRequest, signal?: AbortSignal): Promise<HostAttemptResult> {
    const base = {
      attemptId: request.attempt.attemptId,
      runtime: { profile: "codex-app-server", cliVersion: this.cliVersion },
      actions: [],
      artifacts: [],
      usage: emptyHostAttemptUsage(),
      events: [],
    } as const

    if (!this.liveEnabled) {
      return {
        ...base,
        status: "failed",
        failure: {
          kind: "configuration",
          message: "Live Codex turn gate is closed",
          retryable: false,
        },
      }
    }
    assertCompatibleCodexCliVersion(this.cliVersion)

    const notifications: CodexServerNotification[] = []
    const permissionEvents: HostAttemptEvent[] = []
    let sequence = 0
    const handler: CodexServerRequestHandler = async (serverRequest, requestSignal) => {
      sequence += 1
      permissionEvents.push({
        sequence,
        type: "permission_requested",
        permission: serverRequest.method,
        title: serverRequest.method,
      })
      if (this.approvalPort !== undefined) {
        const result = await this.approvalPort.review(serverRequest, requestSignal)
        if (isJsonCompatible(result)) {
          return result
        }
        throw new Error("Approval port returned a non-JSON result")
      }
      if (
        serverRequest.method === "item/commandExecution/requestApproval" ||
        serverRequest.method === "item/fileChange/requestApproval"
      ) {
        return { decision: "cancel" }
      }
      throw new Error(`No approval handler for ${serverRequest.method}`)
    }
    const client = this.createClient(handler)
    const unsubscribe = client.onNotification((notification) => notifications.push(notification))
    let threadId: string | undefined
    let turnId: string | undefined

    try {
      await client.initialize(signal)
      const threadStart = await client.request(
        "thread/start",
        compactJson({
          cwd: request.workspaceRoot,
          ephemeral: true,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          model: request.model?.model,
          modelProvider: request.model?.provider,
          threadSource: "user",
        }),
        { signal, timeoutMs: request.timeoutMs },
      )
      threadId = readNestedString(threadStart, "thread", "id")
      if (threadId === undefined) {
        throw new CodexAppServerError("protocol", "thread/start response is missing thread.id")
      }

      const turnStart = await client.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: request.prompt, text_elements: [] }],
        },
        { signal, timeoutMs: request.timeoutMs },
      )
      turnId = readNestedString(turnStart, "turn", "id")
      if (turnId === undefined) {
        throw new CodexAppServerError("protocol", "turn/start response is missing turn.id")
      }

      const existing = notifications.find((notification) =>
        isMatchingTurnCompleted(notification, threadId, turnId))
      const completed = existing ?? await client.waitForNotification(
        "turn/completed",
        (notification) => isMatchingTurnCompleted(notification, threadId, turnId),
        { signal, timeoutMs: request.timeoutMs },
      )
      return mapCompletedAttempt(
        request,
        this.cliVersion,
        threadId,
        turnId,
        completed,
        notifications,
        permissionEvents,
      )
    } catch (error) {
      const failure = mapFailure(error)
      return {
        attemptId: request.attempt.attemptId,
        runtime: compactRuntime(this.cliVersion, threadId, turnId),
        actions: [],
        artifacts: [],
        usage: emptyHostAttemptUsage(),
        events: permissionEvents,
        status: failure.kind === "aborted" ? "aborted" : "failed",
        failure,
      }
    } finally {
      unsubscribe()
      await client.shutdown()
    }
  }
}

function mapCompletedAttempt(
  request: HostAttemptRequest,
  cliVersion: string,
  threadId: string,
  turnId: string,
  completed: CodexServerNotification,
  notifications: readonly CodexServerNotification[],
  permissionEvents: readonly HostAttemptEvent[],
): HostAttemptResult {
  const params = asRecord(completed.params)
  const turn = asRecord(params?.turn)
  const status = typeof turn?.status === "string" ? turn.status : undefined
  const items = collectCompletedItems(threadId, turnId, turn, notifications)
  const actions = mapActions(items)
  const artifacts = mapArtifacts(items)
  const usage = mapUsage(notifications)
  const events = mapEvents(notifications, permissionEvents)
  const runtime = compactRuntime(cliVersion, threadId, turnId)

  if (status === "interrupted") {
    return {
      attemptId: request.attempt.attemptId,
      runtime,
      actions,
      artifacts,
      usage,
      events,
      status: "aborted",
      failure: { kind: "aborted", message: "Codex turn was interrupted", retryable: false },
    }
  }
  if (status !== "completed") {
    const error = asRecord(turn?.error)
    return {
      attemptId: request.attempt.attemptId,
      runtime,
      actions,
      artifacts,
      usage,
      events,
      status: "failed",
      failure: {
        kind: "provider",
        message: typeof error?.message === "string" ? error.message : `Codex turn ended as ${String(status)}`,
        retryable: false,
      },
    }
  }

  const completion = [...items].reverse().find((item) => item.type === "agentMessage")?.text
  if (typeof completion !== "string" || completion.trim().length === 0) {
    return {
      attemptId: request.attempt.attemptId,
      runtime,
      actions,
      artifacts,
      usage,
      events,
      status: "failed",
      failure: {
        kind: "protocol",
        message: "Completed Codex turn did not contain an agent message",
        retryable: false,
      },
    }
  }
  return {
    attemptId: request.attempt.attemptId,
    runtime,
    actions,
    artifacts,
    usage,
    events,
    status: "completion_proposed",
    completion,
  }
}

function collectCompletedItems(
  threadId: string,
  turnId: string,
  turn: Record<string, unknown> | undefined,
  notifications: readonly CodexServerNotification[],
): Record<string, unknown>[] {
  const items = new Map<string, Record<string, unknown>>()
  const append = (item: Record<string, unknown>): void => {
    if (typeof item.id === "string") {
      items.set(item.id, item)
    }
  }

  for (const notification of notifications) {
    if (notification.method !== "item/completed") {
      continue
    }
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (params?.threadId === threadId && params.turnId === turnId && item !== undefined) {
      append(item)
    }
  }
  if (Array.isArray(turn?.items)) {
    for (const rawItem of turn.items) {
      const item = asRecord(rawItem)
      if (item !== undefined) {
        append(item)
      }
    }
  }
  return [...items.values()]
}

function mapActions(items: readonly Record<string, unknown>[]): HostActionObservation[] {
  const actions: HostActionObservation[] = []
  for (const item of items) {
    if (item.type === "commandExecution" && typeof item.id === "string") {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null
      const completed = item.status === "completed" && exitCode === 0
      actions.push({
        sequence: actions.length + 1,
        actionId: item.id,
        name: "commandExecution",
        kind: "execute",
        status: completed ? "completed" : "failed",
        input: compactJson({ command: item.command, cwd: item.cwd }),
        exitCode,
        ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}),
      })
    } else if (item.type === "fileChange" && typeof item.id === "string") {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
      actions.push({
        sequence: actions.length + 1,
        actionId: item.id,
        name: "fileChange",
        kind: "mutation",
        status: item.status === "completed" ? "completed" : "failed",
        input: { paths: changes.flatMap((change) =>
          typeof change.path === "string" ? [change.path] : []) },
      })
    }
  }
  return actions
}

function mapArtifacts(items: readonly Record<string, unknown>[]): HostArtifactChange[] {
  const artifacts = new Map<string, HostArtifactChange>()
  for (const item of items) {
    if (item.type !== "fileChange" || !Array.isArray(item.changes)) {
      continue
    }
    for (const rawChange of item.changes) {
      const change = asRecord(rawChange)
      if (typeof change?.path !== "string") {
        continue
      }
      const diff = typeof change.diff === "string" ? change.diff : ""
      artifacts.set(change.path, {
        path: change.path,
        additions: diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length,
        deletions: diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---" )).length,
      })
    }
  }
  return [...artifacts.values()]
}

function mapUsage(notifications: readonly CodexServerNotification[]): HostAttemptUsage {
  const notification = [...notifications].reverse().find((candidate) =>
    candidate.method === "thread/tokenUsage/updated")
  const total = asRecord(asRecord(asRecord(notification?.params)?.tokenUsage)?.total)
  return {
    inputTokens: readNumber(total?.inputTokens),
    outputTokens: readNumber(total?.outputTokens),
    reasoningTokens: readNumber(total?.reasoningOutputTokens),
    cacheReadTokens: readNumber(total?.cachedInputTokens),
    cacheWriteTokens: 0,
    cost: 0,
  }
}

function mapEvents(
  notifications: readonly CodexServerNotification[],
  permissionEvents: readonly HostAttemptEvent[],
): HostAttemptEvent[] {
  const events: HostAttemptEvent[] = []
  let sequence = 0
  for (const notification of notifications) {
    if (notification.method === "turn/started") {
      events.push({ sequence: ++sequence, type: "turn_started", turn: 1 })
    } else if (notification.method === "turn/completed") {
      events.push({ sequence: ++sequence, type: "turn_finished", turn: 1 })
    } else if (notification.method === "item/agentMessage/delta") {
      const delta = asRecord(notification.params)?.delta
      if (typeof delta === "string") {
        events.push({ sequence: ++sequence, type: "text_delta", delta })
      }
    }
  }
  for (const event of permissionEvents) {
    events.push({ ...event, sequence: ++sequence })
  }
  return events
}

function mapFailure(error: unknown): HostFailure {
  if (error instanceof CodexAppServerError) {
    const kind = error.kind === "process_exit" || error.kind === "shutdown"
      ? "transport"
      : error.kind === "overloaded"
        ? "overloaded"
        : error.kind
    return { kind, message: error.message, retryable: error.retryable }
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "Unknown Codex app-server failure",
    retryable: false,
  }
}

function isMatchingTurnCompleted(
  notification: CodexServerNotification,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  if (notification.method !== "turn/completed") {
    return false
  }
  const params = asRecord(notification.params)
  return params?.threadId === threadId && readNestedString(params, "turn", "id") === turnId
}

function compactRuntime(cliVersion: string, threadId?: string, turnId?: string) {
  return {
    profile: "codex-app-server",
    cliVersion,
    ...(threadId === undefined ? {} : { backendSessionId: threadId }),
    ...(turnId === undefined ? {} : { backendRunId: turnId }),
  }
}

function compactJson(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && isJsonCompatible(value)) {
      output[key] = value
    }
  }
  return output
}

function isJsonCompatible(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonCompatible)
  }
  return isRecord(value) && Object.values(value).every(isJsonCompatible)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function readNestedString(value: unknown, outer: string, inner: string): string | undefined {
  const nested = asRecord(asRecord(value)?.[outer])
  return typeof nested?.[inner] === "string" ? nested[inner] : undefined
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
