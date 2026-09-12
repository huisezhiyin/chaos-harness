import { describe, expect, it, vi } from "vitest"
import { ids } from "../../../kernel/src/index.js"
import { CodexAppServerAttemptAdapter } from "../src/attempt-adapter.js"
import { CodexAppServerClient } from "../src/client.js"
import { isRecord } from "../src/protocol.js"
import { FakeAppServerProcess } from "./fake-process.js"

describe("CodexAppServerAttemptAdapter", () => {
  it("fails closed without creating a process while the live gate is closed", async () => {
    const createClient = vi.fn()
    const adapter = new CodexAppServerAttemptAdapter({ createClient })

    await expect(adapter.run(attemptRequest())).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "configuration", message: "Live Codex turn gate is closed" },
    })
    expect(createClient).not.toHaveBeenCalled()
  })

  it("normalizes a fake completed turn without treating it as verified correctness", async () => {
    const process = new FakeAppServerProcess()
    process.onMessage = (message) => {
      const record = isRecord(message) ? message : undefined
      if (record?.method === "initialize") {
        process.send({
          id: record.id,
          result: {
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "codex-cli/0.133.0",
          },
        })
      } else if (record?.method === "thread/start") {
        process.send({ id: record.id, result: { thread: { id: "thread-1" } } })
      } else if (record?.method === "turn/start") {
        process.send({ id: record.id, result: { turn: { id: "turn-1" } } })
        process.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })
        process.send({
          id: "approval-1",
          method: "item/fileChange/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1" },
        })
        process.send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                inputTokens: 100,
                outputTokens: 20,
                reasoningOutputTokens: 5,
                cachedInputTokens: 10,
                totalTokens: 120,
              },
            },
          },
        })
        queueMicrotask(() => process.send({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "completed",
              items: [
                {
                  id: "command-1",
                  type: "commandExecution",
                  command: "pnpm test",
                  cwd: "/workspace",
                  status: "completed",
                  exitCode: 0,
                  aggregatedOutput: "passed",
                },
                {
                  id: "change-1",
                  type: "fileChange",
                  status: "completed",
                  changes: [{ path: "src/a.ts", kind: "update", diff: "+one\n-two" }],
                },
                { id: "message-1", type: "agentMessage", text: "Implemented." },
              ],
            },
          },
        }))
      }
    }
    const adapter = new CodexAppServerAttemptAdapter({
      liveEnabled: true,
      createClient: (handler) => new CodexAppServerClient({
        processFactory: () => process,
        serverRequestHandler: handler,
      }),
    })

    const result = await adapter.run(attemptRequest())

    expect(result).toMatchObject({
      status: "completion_proposed",
      completion: "Implemented.",
      runtime: {
        profile: "codex-app-server",
        cliVersion: "0.133.0",
        backendSessionId: "thread-1",
        backendRunId: "turn-1",
      },
      actions: [
        { name: "commandExecution", status: "completed", exitCode: 0 },
        { name: "fileChange", status: "completed" },
      ],
      artifacts: [{ path: "src/a.ts", additions: 1, deletions: 1 }],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 10,
        cost: 0,
      },
    })
    expect(process.received).toContainEqual({
      id: "approval-1",
      result: { decision: "cancel" },
    })
  })

  it("does not accept turn/completed without an agent completion item", async () => {
    const process = scriptedCompletionProcess([])
    const adapter = new CodexAppServerAttemptAdapter({
      liveEnabled: true,
      createClient: (handler) => new CodexAppServerClient({
        processFactory: () => process,
        serverRequestHandler: handler,
      }),
    })

    await expect(adapter.run(attemptRequest())).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "protocol", message: expect.stringContaining("agent message") },
    })
  })

  it("aggregates item/completed notifications when turn/completed omits items", async () => {
    const items = [
      {
        id: "command-1",
        type: "commandExecution",
        command: "node --test test/add.test.js",
        cwd: "/workspace",
        status: "completed",
        exitCode: 0,
      },
      {
        id: "change-1",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/add.js", kind: "update", diff: "-minus\n+plus" }],
      },
      { id: "message-1", type: "agentMessage", text: "Fixed the addition bug." },
    ]
    const process = scriptedCompletionProcess([], items)
    const adapter = new CodexAppServerAttemptAdapter({
      liveEnabled: true,
      createClient: (handler) => new CodexAppServerClient({
        processFactory: () => process,
        serverRequestHandler: handler,
      }),
    })

    await expect(adapter.run(attemptRequest())).resolves.toMatchObject({
      status: "completion_proposed",
      completion: "Fixed the addition bug.",
      actions: [
        { actionId: "command-1", status: "completed" },
        { actionId: "change-1", status: "completed" },
      ],
      artifacts: [{ path: "src/add.js", additions: 1, deletions: 1 }],
    })
  })
})

function attemptRequest() {
  return {
    attempt: {
      attemptId: ids.attempt("codex-attempt-1"),
      unitId: ids.unit("codex-unit-1"),
      unitRevision: 1,
      projectionId: ids.projection("codex-projection-1"),
    },
    workspaceRoot: "/workspace",
    prompt: "Fix the fixture",
  }
}

function scriptedCompletionProcess(
  items: unknown[],
  notificationItems: unknown[] = [],
): FakeAppServerProcess {
  const process = new FakeAppServerProcess()
  process.onMessage = (message) => {
    const record = isRecord(message) ? message : undefined
    if (record?.method === "initialize") {
      process.send({
        id: record.id,
        result: {
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "codex-cli/0.133.0",
        },
      })
    } else if (record?.method === "thread/start") {
      process.send({ id: record.id, result: { thread: { id: "thread-1" } } })
    } else if (record?.method === "turn/start") {
      process.send({ id: record.id, result: { turn: { id: "turn-1" } } })
      queueMicrotask(() => {
        for (const item of notificationItems) {
          process.send({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              completedAtMs: 1,
              item,
            },
          })
        }
        process.send({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", items },
          },
        })
      })
    }
  }
  return process
}
