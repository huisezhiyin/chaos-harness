import { describe, expect, it, vi } from "vitest"
import { ids, type HostAttemptResult } from "../../../kernel/src/index.js"
import type { CodexDogfoodRunSummary } from "../../codex-app-server/src/dogfood.js"
import {
  createOpenCodeBridgeConfig,
  OPENCODE_BRIDGE_MODEL,
  OPENCODE_CODE_AGENT_MODEL,
  OPENCODE_METADATA_MODEL,
  projectOpenCodeMessages,
  startOpenCodeCodexBridge,
  type OpenCodeCodexAttemptRunner,
} from "../src/server.js"

describe("OpenCode Codex bridge", () => {
  it("maps one non-stream code request to exactly one Harness Attempt", async () => {
    const runner = vi.fn<OpenCodeCodexAttemptRunner>(async (options) => successRun(options.recordPath))
    const bridge = await startOpenCodeCodexBridge(baseOptions(runner))
    try {
      const response = await request(bridge, {
        model: OPENCODE_CODE_AGENT_MODEL,
        stream: false,
        messages: [
          { role: "system", content: "OpenCode private system prompt" },
          { role: "user", content: "fix the parser" },
        ],
      })
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, any>
      expect(body.choices[0].message).toEqual({ role: "assistant", content: "completed through Harness" })
      expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 })
      expect(runner).toHaveBeenCalledTimes(1)
      expect(runner.mock.calls[0]?.[0]).toMatchObject({
        workspaceRoot: "/workspace",
        model: "gpt-exact",
        recordPath: "/private/dogfood.jsonl",
        allowDirty: true,
      })
      expect(runner.mock.calls[0]?.[0].goal).toContain("USER:\nfix the parser")
      expect(runner.mock.calls[0]?.[0].goal).not.toContain("private system prompt")
    } finally {
      await bridge.close()
    }
  })

  it("returns OpenAI-compatible SSE without creating a second tool loop", async () => {
    const runner = vi.fn<OpenCodeCodexAttemptRunner>(async (options) => successRun(options.recordPath))
    const bridge = await startOpenCodeCodexBridge(baseOptions(runner))
    try {
      const response = await request(bridge, {
        model: OPENCODE_CODE_AGENT_MODEL,
        stream: true,
        tools: [{ type: "function", function: { name: "edit" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "change one file" }] }],
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const body = await response.text()
      expect(body).toContain('"content":"completed through Harness"')
      expect(body).toContain('"finish_reason":"stop"')
      expect(body).not.toContain("tool_calls")
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true)
      expect(runner).toHaveBeenCalledTimes(1)
    } finally {
      await bridge.close()
    }
  })

  it("answers metadata locally and lists only the two bridge models", async () => {
    const runner = vi.fn<OpenCodeCodexAttemptRunner>()
    const bridge = await startOpenCodeCodexBridge(baseOptions(runner))
    try {
      const models = await fetch(`${bridge.baseUrl}/models`, {
        headers: { authorization: `Bearer ${bridge.apiKey}` },
      })
      expect(models.status).toBe(200)
      expect(await models.json()).toMatchObject({
        data: [{ id: OPENCODE_CODE_AGENT_MODEL }, { id: OPENCODE_METADATA_MODEL }],
      })

      const response = await request(bridge, {
        model: OPENCODE_METADATA_MODEL,
        stream: false,
        messages: [{ role: "user", content: "A long coding request for a useful title" }],
      })
      const body = await response.json() as Record<string, any>
      expect(body.choices[0].message.content).toBe("A long coding request for a useful title")
      expect(runner).not.toHaveBeenCalled()
    } finally {
      await bridge.close()
    }
  })

  it("requires the process-local bearer token", async () => {
    const bridge = await startOpenCodeCodexBridge(baseOptions(vi.fn()))
    try {
      const response = await fetch(`${bridge.baseUrl}/models`)
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(bridge.apiKey)
    } finally {
      await bridge.close()
    }
  })

  it("fails closed for malformed, oversized, and unknown-model requests", async () => {
    const runner = vi.fn<OpenCodeCodexAttemptRunner>()
    const bridge = await startOpenCodeCodexBridge({ ...baseOptions(runner), maxBodyBytes: 90 })
    try {
      const malformed = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.apiKey}`,
          "content-type": "application/json",
        },
        body: "{",
      })
      expect(malformed.status).toBe(400)

      const unknown = await request(bridge, {
        model: "unknown",
        messages: [{ role: "user", content: "goal" }],
      })
      expect(unknown.status).toBe(400)

      const oversized = await request(bridge, {
        model: OPENCODE_CODE_AGENT_MODEL,
        messages: [{ role: "user", content: "x".repeat(200) }],
      })
      expect(oversized.status).toBe(413)
      expect(runner).not.toHaveBeenCalled()
    } finally {
      await bridge.close()
    }
  })

  it("does not render Harness failures or boundary violations as assistant success", async () => {
    const results = [failedRun("/private/dogfood.jsonl"), successRun("/private/dogfood.jsonl", true)]
    const runner = vi.fn<OpenCodeCodexAttemptRunner>(async () => results.shift()!)
    const bridge = await startOpenCodeCodexBridge(baseOptions(runner))
    try {
      const failure = await request(bridge, codeRequest("first"))
      expect(failure.status).toBe(502)
      expect(await failure.text()).not.toContain("completed through Harness")

      const boundary = await request(bridge, codeRequest("second"))
      expect(boundary.status).toBe(502)
      expect(await boundary.text()).toContain("boundary_violation")
    } finally {
      await bridge.close()
    }
  })

  it("aborts the in-flight Attempt when the OpenCode request disconnects", async () => {
    let observedSignal: AbortSignal | undefined
    const runner = vi.fn<OpenCodeCodexAttemptRunner>(async (options) => {
      observedSignal = options.signal
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }))
      return failedRun(options.recordPath, "aborted")
    })
    const bridge = await startOpenCodeCodexBridge(baseOptions(runner))
    try {
      const controller = new AbortController()
      const pending = request(bridge, codeRequest("wait"), controller.signal).catch(() => undefined)
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))
      controller.abort()
      await pending
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true))
    } finally {
      await bridge.close()
    }
  })

  it("projects recent user/assistant context within a hard character budget", () => {
    const projected = projectOpenCodeMessages([
      { role: "user", text: "old ".repeat(500) },
      { role: "assistant", text: "previous answer" },
      { role: "user", text: "current goal" },
    ], 1_000)
    expect(projected).toContain("current goal")
    expect(projected).toContain("previous answer")
    expect(projected.length).toBeLessThanOrEqual(1_160)
  })

  it("merges an existing process config while forcing the bridge routing fields", () => {
    const config = createOpenCodeBridgeConfig(
      "http://127.0.0.1:1234/v1",
      "ephemeral-token",
      JSON.stringify({ theme: "system", provider: { retained: { name: "Retained" } } }),
    )
    expect(config).toMatchObject({
      theme: "system",
      model: OPENCODE_BRIDGE_MODEL,
      small_model: "chaos-codex/metadata",
      enabled_providers: ["chaos-codex"],
      provider: {
        retained: { name: "Retained" },
        "chaos-codex": {
          options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: "ephemeral-token" },
          models: {
            "code-agent": { tool_call: false },
            metadata: { tool_call: false },
          },
        },
      },
    })
  })
})

function baseOptions(attemptRunner: OpenCodeCodexAttemptRunner) {
  return {
    workspaceRoot: "/workspace",
    codexModel: "gpt-exact",
    recordPath: "/private/dogfood.jsonl",
    allowDirty: true,
    attemptRunner,
  }
}

function codeRequest(goal: string) {
  return {
    model: OPENCODE_CODE_AGENT_MODEL,
    stream: false,
    messages: [{ role: "user", content: goal }],
  }
}

async function request(
  bridge: { baseUrl: string; apiKey: string },
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
}

function successRun(recordPath: string, boundaryViolation = false): CodexDogfoodRunSummary {
  const result: HostAttemptResult = {
    attemptId: ids.attempt("bridge-attempt"),
    runtime: { profile: "codex-app-server" },
    actions: [],
    artifacts: [],
    events: [],
    usage: {
      inputTokens: 11,
      outputTokens: 3,
      reasoningTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    },
    status: "completion_proposed",
    completion: "completed through Harness",
  }
  return { runId: "bridge-run", recordPath, verification: "pending", boundaryViolation, result }
}

function failedRun(recordPath: string, status: "failed" | "aborted" = "failed"): CodexDogfoodRunSummary {
  const result: HostAttemptResult = {
    attemptId: ids.attempt("bridge-attempt"),
    runtime: { profile: "codex-app-server" },
    actions: [],
    artifacts: [],
    events: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    status,
    failure: { kind: status === "aborted" ? "aborted" : "provider", message: "private failure", retryable: false },
  }
  return { runId: "bridge-run", recordPath, verification: "pending", boundaryViolation: false, result }
}
