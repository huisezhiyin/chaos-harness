import { describe, expect, it, vi } from "vitest"
import {
  ModelProtocolError,
  NativeAttemptEngine,
  ids,
  type ModelRequest,
} from "../../../kernel/src/index.js"
import {
  DeepSeekChatModelPort,
  DeepSeekHttpError,
  ChatStreamError,
  IncompleteChatStreamError,
} from "../src/index.js"
import {
  collect,
  finishChunk,
  sseResponse,
  usageChunk,
} from "./fixtures.js"

const request: ModelRequest = {
  attemptId: ids.attempt("attempt-1"),
  turn: 1,
  messages: [{ role: "user", content: "read the file" }],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
    },
  ],
}

describe("DeepSeekChatModelPort", () => {
  it("recovers a complete length stream without increasing max_tokens or replaying truncated content", async () => {
    const bodies: Array<Record<string, any>> = []
    const port = new DeepSeekChatModelPort({ apiKey: "fake-key", maxTokens: 32000, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: bodies.length === 1 ? "truncated-sentinel" : "blocker reported" }, finish_reason: null }] }),
        finishChunk(bodies.length === 1 ? "length" : "stop"), usageChunk, "[DONE]",
      ], 7)
    } })
    const engine = new NativeAttemptEngine({ model: port,
      tools: { execute: async () => { throw new Error("No tool was requested") } },
      permissions: { evaluate: async () => ({ outcome: "allow" }) },
    })
    const result = await engine.run({ attempt: { attemptId: request.attemptId, unitId: ids.unit("length-unit"), unitRevision: 1, projectionId: ids.projection("length-projection") },
      messages: request.messages, tools: request.tools, budget: { maxTurns: 4, maxActions: 2 },
    }, { requestLengthRecovery: async () => true })
    expect(result.status).toBe("completion_proposed")
    expect(bodies).toHaveLength(2)
    expect(bodies.map(b => b.max_tokens)).toEqual([32000, 32000])
    expect(JSON.stringify(bodies[1]?.messages)).not.toContain("truncated-sentinel")
  })

  it.each(["missing_finish", "missing_usage", "missing_done"] as const)("diagnoses %s without committing tools or completion", async code => {
    const fetchMock = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: {
        content: "private-text", reasoning_content: "private-reasoning",
        tool_calls: [{ index: 0, id: "private-id", function: { name: "read_file", arguments: '{}' } }],
      }, finish_reason: null }] }),
      ...(code === "missing_finish" ? [] : [finishChunk("tool_calls")]),
      ...(code === "missing_usage" ? [] : [usageChunk]),
      ...(code === "missing_done" ? [] : ["[DONE]"]),
    ], 3))
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: fetchMock })
    const emitted: string[] = []
    let caught: unknown
    try { for await (const event of port.stream(request, new AbortController().signal)) emitted.push(event.type) }
    catch (error) { caught = error }
    expect(caught).toBeInstanceOf(ChatStreamError)
    expect(caught).toMatchObject({ code, diagnostics: {
      httpStatus: 200, contentType: "sse", dataEvents: code === "missing_done" ? 3 : 2,
      doneObserved: code !== "missing_done", finishObserved: code !== "missing_finish",
      usageObserved: code !== "missing_usage", textObserved: true, reasoningObserved: true, toolCallsObserved: 1,
    } })
    expect(emitted).toEqual(["reasoning_delta", "text_delta"])
    expect(JSON.stringify(caught)).not.toContain("private-")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ code: "insufficient_quota", type: "insufficient_quota", message: "private-message" }, "insufficient_quota"],
    [{ code: "private-code", type: "insufficient_quota", message: "private-message" }, undefined],
    ["private-message", undefined],
  ])("rejects explicit SSE errors even after otherwise complete tool output", async (error, upstreamCode) => {
    const cancel = vi.fn()
    // Keep transport open: detecting an error must not wait for EOF or DONE.
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      const events = [JSON.stringify({ choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "private-id", function: { name: "read_file", arguments: '{}' } }],
      }, finish_reason: "tool_calls" }] }), usageChunk, JSON.stringify({ error }), "[DONE]"]
      controller.enqueue(new TextEncoder().encode(events.map(data => `data: ${data}\n\n`).join("")))
    }, cancel })
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: vi.fn(async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } })) })
    const emitted: string[] = []
    let caught: unknown
    try { for await (const event of port.stream(request, new AbortController().signal)) emitted.push(event.type) }
    catch (error) { caught = error }
    expect(caught).toBeInstanceOf(ChatStreamError)
    expect(caught).toMatchObject({ code: "upstream_error", upstreamCode, diagnostics: {
      dataEvents: 3, doneObserved: false, finishObserved: true, usageObserved: true, toolCallsObserved: 1,
    } })
    expect(emitted).toEqual([])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
    expect(JSON.stringify(caught)).not.toContain("private-")
  })

  it.each([[false, "stop"], [false, "error"], [true, "stop"]] as const)("recognizes a fragmented quota envelope only when incomplete (complete=%s, finish=%s)", async (complete, finish) => {
    const text = JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "private message", id: "private-id" } })
    const chunk = (content: string, finish: string | null) => JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: vi.fn(async () => sseResponse([
      chunk(text.slice(0, 20), null), chunk(text.slice(20), finish), ...(complete ? [usageChunk, "[DONE]"] : []),
    ], 5)) })
    if (complete) {
      expect((await collect(port.stream(request, new AbortController().signal))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    } else {
      let caught: unknown
      try { await collect(port.stream(request, new AbortController().signal)) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(IncompleteChatStreamError)
      expect((caught as IncompleteChatStreamError).upstreamCode).toBe("insufficient_quota")
      expect(JSON.stringify(caught)).not.toContain("private")
    }
  })
  it.each(["insufficient_quota", '{"error":{"code":"unknown","type":"insufficient_quota"}}',
    JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "x".repeat(8192) } }),
  ])("does not guess upstream quota errors from arbitrary or oversized text", async text => {
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }),
    ])) })
    let caught: unknown
    try { await collect(port.stream(request, new AbortController().signal)) } catch (error) { caught = error }
    expect((caught as IncompleteChatStreamError).upstreamCode).toBeUndefined()
  })
  it.each([
    ["text/event-stream", "", "sse"],
    ["application/json; charset=utf-8", '{"error":"private-upstream-body"}', "json"],
    ["text/html", "private-upstream-body", "other"],
    [undefined, "", "missing"],
  ])("diagnoses an empty/non-SSE response without retaining its body (%s)", async (mediaType, body, category) => {
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: vi.fn(async () =>
      new Response(new TextEncoder().encode(body), { status: 200,
        headers: mediaType ? { "content-type": mediaType } : {} }),
    ) })
    let caught: unknown
    try { await collect(port.stream(request, new AbortController().signal)) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(IncompleteChatStreamError)
    expect((caught as IncompleteChatStreamError).diagnostics).toEqual({
      httpStatus: 200, contentType: category, dataEvents: 0, finishObserved: false,
      usageObserved: false, textObserved: false, reasoningObserved: false, toolCallsObserved: 0, doneObserved: false,
    })
    expect(JSON.stringify(caught)).not.toContain("private-upstream-body")
  })

  it("records truncated SSE progress but never releases an uncommitted tool call", async () => {
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: "private-text", reasoning_content: "private-reasoning",
        tool_calls: [{ index: 0, id: "private-id", function: { name: "read_file", arguments: '{}' } }],
      }, finish_reason: "tool_calls" }] }), usageChunk,
    ], 7)) })
    const emitted: string[] = []
    let caught: unknown
    try { for await (const event of port.stream(request, new AbortController().signal)) emitted.push(event.type) }
    catch (error) { caught = error }
    expect(emitted).toEqual(["reasoning_delta", "text_delta"])
    expect((caught as IncompleteChatStreamError).diagnostics).toEqual({
      httpStatus: 200, contentType: "sse", dataEvents: 2, finishObserved: true,
      usageObserved: true, textObserved: true, reasoningObserved: true, toolCallsObserved: 1, doneObserved: false,
    })
    expect(JSON.stringify(caught)).not.toContain("private-")
  })

  it("normalizes fragmented text SSE, usage and finish", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      sseResponse(
        [
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: "Hel" }, finish_reason: null },
            ],
            usage: null,
          }),
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: "lo" }, finish_reason: null },
            ],
            usage: null,
          }),
          finishChunk("stop"),
          usageChunk,
          "[DONE]",
        ],
        5,
      ),
    )
    const port = new DeepSeekChatModelPort({
      apiKey: "test-secret",
      fetch: fetchMock as unknown as typeof fetch,
    })

    const events = await collect(port.stream(request, new AbortController().signal))

    expect(events).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      {
        type: "usage",
        usage: { inputTokens: 7, outputTokens: 3, cost: 0 },
      },
      { type: "finish", reason: "stop" },
    ])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://api.deepseek.com/chat/completions")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret")
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty("apiKey")
    expect(JSON.stringify(body)).not.toContain("test-secret")
  })

  it("assembles fragmented tool call deltas before emitting a Kernel call", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "read_", arguments: '{"path":"' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          usage: null,
        }),
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "file", arguments: 'README.md"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          usage: null,
        }),
        finishChunk("tool_calls"),
        usageChunk,
        "[DONE]",
      ]),
    ) as unknown as typeof fetch
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: fetchMock })

    const events = await collect(port.stream(request, new AbortController().signal))

    expect(events).toContainEqual({
      type: "tool_call",
      call: {
        toolCallId: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    })
  })

  it("preserves Qwen reasoning deltas, thinking request state and reported reasoning tokens", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({ enable_thinking: true })
      expect(body).not.toHaveProperty("thinking")
      return sseResponse([
        JSON.stringify({
          choices: [{ index: 0, delta: { reasoning_content: "inspect " }, finish_reason: null }],
          usage: null,
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { reasoning_content: "carefully" }, finish_reason: null }],
          usage: null,
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
          usage: null,
        }),
        finishChunk("stop"),
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 8,
            total_tokens: 15,
            prompt_tokens_details: {
              cached_tokens: 6,
              cache_creation_input_tokens: 1,
            },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        }),
        "[DONE]",
      ])
    })
    const port = new DeepSeekChatModelPort({
      apiKey: "secret",
      enableThinking: true,
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(await collect(port.stream(request, new AbortController().signal))).toEqual([
      { type: "reasoning_delta", delta: "inspect " },
      { type: "reasoning_delta", delta: "carefully" },
      { type: "text_delta", delta: "done" },
      {
        type: "usage",
        usage: {
          inputTokens: 7,
          outputTokens: 8,
          reasoningTokens: 5,
          cacheReadTokens: 6,
          cacheWriteTokens: 1,
          cost: 0,
        },
      },
      { type: "finish", reason: "stop" },
    ])
  })

  it("turns malformed tool arguments into a model protocol stop", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "read_file", arguments: "not-json" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: null,
        }),
        usageChunk,
        "[DONE]",
      ]),
    ) as unknown as typeof fetch
    const model = new DeepSeekChatModelPort({ apiKey: "secret", fetch: fetchMock })
    const engine = new NativeAttemptEngine({
      model,
      tools: { execute: async () => { throw new Error("must not execute") } },
      permissions: { evaluate: async () => ({ outcome: "allow" }) },
    })

    const result = await engine.run({
      attempt: {
        attemptId: ids.attempt("attempt-1"),
        unitId: ids.unit("unit-1"),
        unitRevision: 1,
        projectionId: ids.projection("projection-1"),
      },
      messages: request.messages,
      tools: request.tools,
      budget: { maxTurns: 2, maxActions: 2 },
    })

    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "model_protocol_error",
    })
  })

  it("sanitizes bounded HTTP error messages", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(`provider echoed secret-value ${"x".repeat(2_000)}`, {
        status: 401,
        statusText: "Unauthorized",
      }),
    ) as unknown as typeof fetch
    const port = new DeepSeekChatModelPort({
      apiKey: "secret-value",
      fetch: fetchMock,
    })

    let caught: unknown
    try {
      await collect(port.stream(request, new AbortController().signal))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DeepSeekHttpError)
    expect(String(caught)).not.toContain("secret-value")
    expect(String(caught).length).toBeLessThan(1_100)
  })

  it("passes the caller abort signal to fetch", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      throw controller.signal.reason
    }) as unknown as typeof fetch
    const port = new DeepSeekChatModelPort({ apiKey: "secret", fetch: fetchMock })

    await expect(collect(port.stream(request, controller.signal))).rejects.toThrow("cancelled")
  })

  it("requires usage and DONE protocol markers", async () => {
    const withoutUsage = new DeepSeekChatModelPort({
      apiKey: "secret",
      fetch: vi.fn(async () =>
        sseResponse([finishChunk("stop"), "[DONE]"]),
      ) as unknown as typeof fetch,
    })
    const withoutDone = new DeepSeekChatModelPort({
      apiKey: "secret",
      fetch: vi.fn(async () =>
        sseResponse([finishChunk("stop"), usageChunk]),
      ) as unknown as typeof fetch,
    })

    await expect(
      collect(withoutUsage.stream(request, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ModelProtocolError)
    await expect(
      collect(withoutDone.stream(request, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ModelProtocolError)
  })
})
