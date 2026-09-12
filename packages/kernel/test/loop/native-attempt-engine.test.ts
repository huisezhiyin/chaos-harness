import { describe, expect, it } from "vitest"
import {
  NativeAttemptEngine,
  ids,
  type AttemptRequest,
  type ModelStreamEvent,
  type ToolDefinition,
} from "../../src/index.js"
import {
  ScriptedModelPort,
  ScriptedPermissionPort,
  ScriptedToolPort,
  allowAll,
} from "./fakes.js"

const tool: ToolDefinition = {
  name: "read_file",
  description: "Read a text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}

const usage = (inputTokens = 2, outputTokens = 1, cost = 0.001): ModelStreamEvent => ({
  type: "usage",
  usage: { inputTokens, outputTokens, cost },
})

const toolDecision = (id = "call-1"): ModelStreamEvent[] => [
  {
    type: "tool_call",
    call: { toolCallId: id, name: "read_file", arguments: { path: "README.md" } },
  },
  usage(),
  { type: "finish", reason: "tool_calls" },
]

const finalDecision = (text = "done"): ModelStreamEvent[] => [
  { type: "text_delta", delta: text },
  usage(),
  { type: "finish", reason: "stop" },
]

function request(overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  return {
    attempt: {
      attemptId: ids.attempt("native-attempt-1"),
      unitId: ids.unit("unit-1"),
      unitRevision: 1,
      projectionId: ids.projection("projection-1"),
    },
    messages: [{ role: "user", content: "Read README and report completion" }],
    tools: [tool],
    budget: { maxTurns: 4, maxActions: 4, maxCost: 1 },
    ...overrides,
  }
}

describe("NativeAttemptEngine Core Profile", () => {
  it("runs allowed tool -> observation -> next turn -> completion proposal", async () => {
    const model = new ScriptedModelPort([toolDecision(), finalDecision("README inspected")])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "# Chaos Harness",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request())

    expect(result.status).toBe("completion_proposed")
    if (result.status === "completion_proposed") {
      expect(result.completion).toBe("README inspected")
    }
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      content: "# Chaos Harness",
      toolCallId: "call-1",
      toolName: "read_file",
      ok: true,
    })
    expect(toSemanticEventTypes(result.events)).toEqual([
      "attempt_started",
      "turn_started",
      "model_decision",
      "tool_proposed",
      "permission_evaluated",
      "tool_started",
      "tool_observed",
      "turn_completed",
      "turn_started",
      "model_decision",
      "turn_completed",
      "completion_proposed",
      "attempt_completed",
    ])
    expect(toSemanticEventTypes(result.events)).not.toContain("ChaosUnitCompleted")
  })

  it("feeds permission denial back as observation without executing the tool", async () => {
    const model = new ScriptedModelPort([toolDecision(), finalDecision("handled denial")])
    const tools = new ScriptedToolPort(() => {
      throw new Error("must not execute")
    })
    const permissions = new ScriptedPermissionPort(() => ({
      outcome: "deny",
      reason: "read is outside the current boundary",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions })

    const result = await engine.run(request())

    expect(result.status).toBe("completion_proposed")
    expect(tools.proposals).toHaveLength(0)
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      ok: false,
      content: "read is outside the current boundary",
    })
  })

  it("preserves reasoning across tool turns and aggregates reported reasoning tokens", async () => {
    const model = new ScriptedModelPort([
      [
        { type: "reasoning_delta", delta: "inspect README" },
        ...toolDecision(),
      ],
      [
        { type: "reasoning_delta", delta: "form conclusion" },
        { type: "text_delta", delta: "done" },
        { type: "usage", usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 3, cost: 0 } },
        { type: "finish", reason: "stop" },
      ],
    ])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "# Chaos Harness",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request())

    expect(model.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning: "inspect README",
      toolCalls: [expect.objectContaining({ toolCallId: "call-1" })],
    }))
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "done",
      reasoning: "form conclusion",
    })
    expect(result.usage.reasoningTokens).toBe(3)
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "model_stream_event",
      event: { type: "reasoning_delta", delta: "inspect README" },
    }))
  })

  it("aggregates cache usage without adding it to total input tokens", async () => {
    const firstDecision: ModelStreamEvent[] = [
      {
        type: "tool_call",
        call: { toolCallId: "call-cache", name: "read_file", arguments: { path: "README.md" } },
      },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 6, cacheWriteTokens: 1, cost: 0 },
      },
      { type: "finish", reason: "tool_calls" },
    ]
    const secondDecision: ModelStreamEvent[] = [
      { type: "text_delta", delta: "done" },
      {
        type: "usage",
        usage: { inputTokens: 15, outputTokens: 3, cacheReadTokens: 12, cacheWriteTokens: 0, cost: 0 },
      },
      { type: "finish", reason: "stop" },
    ]
    const model = new ScriptedModelPort([firstDecision, secondDecision])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "# Chaos Harness",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request())

    expect(result.usage).toMatchObject({
      inputTokens: 25,
      outputTokens: 5,
      cacheReadTokens: 18,
      cacheWriteTokens: 1,
    })
  })

  it("normalizes tool exceptions into failed observations and continues", async () => {
    const model = new ScriptedModelPort([toolDecision(), finalDecision("recovered")])
    const tools = new ScriptedToolPort(() => {
      throw new Error("filesystem unavailable")
    })
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request())

    expect(result.status).toBe("completion_proposed")
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      ok: false,
      content: "filesystem unavailable",
    })
    const observation = result.events.find(
      (event) => event.type === "tool_observed",
    )
    expect(observation).toMatchObject({
      type: "tool_observed",
      observation: { errorCode: "tool_error" },
    })
  })

  it("uses a tool-free wrap-up turn when maxActions is reached", async () => {
    const model = new ScriptedModelPort([toolDecision("call-1"), finalDecision("safe handoff")])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({ budget: { maxTurns: 4, maxActions: 1 } }))

    expect(result).toMatchObject({ status: "completion_proposed", completion: "safe handoff" })
    expect(tools.proposals).toHaveLength(1)
    expect(model.requests[1]?.tools).toEqual([])
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("final wrap-up turn"),
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "budget_reached", budget: "actions", action: "finalize" }),
    )
  })

  it("returns failed observations for tool calls beyond the action guard before wrapping up", async () => {
    const twoToolCalls: ModelStreamEvent[] = [
      {
        type: "tool_call",
        call: { toolCallId: "call-1", name: "read_file", arguments: { path: "README.md" } },
      },
      {
        type: "tool_call",
        call: { toolCallId: "call-2", name: "read_file", arguments: { path: "package.json" } },
      },
      usage(),
      { type: "finish", reason: "tool_calls" },
    ]
    const model = new ScriptedModelPort([twoToolCalls, finalDecision("partial handoff")])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({ budget: { maxTurns: 4, maxActions: 1 } }))

    expect(result).toMatchObject({ status: "completion_proposed", completion: "partial handoff" })
    expect(tools.proposals).toHaveLength(1)
    expect(model.requests[1]?.messages).toContainEqual({
      role: "tool",
      content: expect.stringContaining("action guard reached"),
      toolCallId: "call-2",
      toolName: "read_file",
      ok: false,
    })
  })

  it("reserves the last configured turn for a tool-free wrap-up", async () => {
    const model = new ScriptedModelPort([finalDecision("turn-limit handoff")])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({ budget: { maxTurns: 1, maxActions: 2 } }))

    expect(result).toMatchObject({ status: "completion_proposed", completion: "turn-limit handoff" })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools).toEqual([])
    expect(model.requests[0]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("final wrap-up turn"),
    })
  })

  it("enters a bounded tool-capable evidence closure after the work action guard", async () => {
    const model = new ScriptedModelPort([
      toolDecision("work-read"),
      toolDecision("closure-read"),
      finalDecision("evidence closed"),
    ])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({
      budget: {
        maxTurns: 4,
        maxActions: 1,
        evidenceClosure: {
          maxTurns: 3,
          maxActions: 1,
          allowedToolNames: ["read_file"],
        },
      },
    }), {
      evidenceClosure: { guidance: () => "Run validation, inspect changes, and close the plan." },
    })

    expect(result).toMatchObject({
      status: "completion_proposed",
      completion: "evidence closed",
      usage: { turns: 3, actions: 2 },
    })
    expect(tools.proposals.map((proposal) => proposal.call.toolCallId)).toEqual([
      "work-read",
      "closure-read",
    ])
    expect(model.requests[1]?.tools.map((item) => item.name)).toEqual(["read_file"])
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("Current Chaos Harness evidence state"),
    })
    expect(model.requests[2]?.tools).toEqual([])
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "budget_reached",
      budget: "actions",
      action: "evidence_closure",
    }))
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "evidence_closure_started",
      trigger: "actions",
      workTurns: 1,
      workActions: 1,
    }))
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "budget_reached",
      budget: "actions",
      action: "finalize",
    }))
  })

  it("does not expose or execute workspace mutation tools during evidence closure", async () => {
    const mutationDecision: ModelStreamEvent[] = [
      {
        type: "tool_call",
        call: { toolCallId: "blocked-write", name: "write_file", arguments: { path: "src.ts" } },
      },
      usage(),
      { type: "finish", reason: "tool_calls" },
    ]
    const model = new ScriptedModelPort([
      toolDecision("work-read"),
      mutationDecision,
      finalDecision("mutation blocked"),
    ])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({
      tools: [tool, writeTool],
      budget: {
        maxTurns: 4,
        maxActions: 1,
        evidenceClosure: {
          maxTurns: 3,
          maxActions: 2,
          allowedToolNames: ["read_file"],
        },
      },
    }))

    expect(result).toMatchObject({ status: "completion_proposed", completion: "mutation blocked" })
    expect(model.requests[1]?.tools.map((item) => item.name)).toEqual(["read_file"])
    expect(tools.proposals.map((proposal) => proposal.call.toolCallId)).toEqual(["work-read"])
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      toolCallId: "blocked-write",
      ok: false,
      content: "Unknown tool: write_file",
    }))
  })

  it("uses the closure reserve after the full work turn budget instead of consuming the last work turn", async () => {
    const model = new ScriptedModelPort([
      toolDecision("work-read"),
      toolDecision("closure-read"),
      finalDecision("turn evidence closed"),
    ])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({
      budget: {
        maxTurns: 1,
        maxActions: 4,
        evidenceClosure: {
          maxTurns: 3,
          maxActions: 1,
          allowedToolNames: ["read_file"],
        },
      },
    }))

    expect(result).toMatchObject({
      status: "completion_proposed",
      completion: "turn evidence closed",
      usage: { turns: 3, actions: 2 },
    })
    expect(model.requests[0]?.tools.map((item) => item.name)).toEqual(["read_file"])
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "budget_reached",
      budget: "turns",
      action: "evidence_closure",
    }))
  })

  it("keeps cumulative provider tokens as telemetry instead of a task fuse", async () => {
    const highInputToolDecision = toolDecision()
    highInputToolDecision[1] = usage(90_000, 5, 0)
    const highInputFinalDecision: ModelStreamEvent[] = [
      { type: "text_delta", delta: "done after a long context" },
      usage(70_000, 7, 0),
      { type: "finish", reason: "stop" },
    ]
    const model = new ScriptedModelPort([highInputToolDecision, highInputFinalDecision])
    const tools = new ScriptedToolPort((proposal) => ({
      toolCallId: proposal.call.toolCallId,
      toolName: proposal.call.name,
      ok: true,
      content: "ok",
    }))
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({ budget: { maxTurns: 4, maxActions: 2 } }))

    expect(result).toMatchObject({
      status: "completion_proposed",
      usage: { inputTokens: 160_000, outputTokens: 12 },
    })
    expect(tools.proposals).toHaveLength(1)
  })

  it("stops if a model ignores a tool-free wrap-up request", async () => {
    const model = new ScriptedModelPort([toolDecision()])
    const tools = new ScriptedToolPort(() => {
      throw new Error("must not execute")
    })
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({ budget: { maxTurns: 1, maxActions: 2 } }))

    expect(result).toMatchObject({ status: "stopped", stopReason: "max_turns" })
    expect(tools.proposals).toHaveLength(0)
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "budget_reached", budget: "turns", action: "finalize" }),
    )
  })

  it("uses returned cost to stop before tool execution", async () => {
    const expensiveToolDecision = toolDecision()
    expensiveToolDecision[1] = usage(2, 1, 1.5)
    const model = new ScriptedModelPort([expensiveToolDecision])
    const tools = new ScriptedToolPort(() => {
      throw new Error("must not execute")
    })
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request({ budget: { maxCost: 1, maxActions: 2 } }))

    expect(result).toMatchObject({ status: "stopped", stopReason: "max_cost" })
    expect(tools.proposals).toHaveLength(0)
  })

  it("returns an aborted result without invoking the model", async () => {
    const model = new ScriptedModelPort([finalDecision()])
    const tools = new ScriptedToolPort(() => {
      throw new Error("must not execute")
    })
    const controller = new AbortController()
    controller.abort()
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request(), { signal: controller.signal })

    expect(result).toMatchObject({ status: "aborted", stopReason: "aborted" })
    expect(model.requests).toHaveLength(0)
  })

  it("turns malformed model streams into a protocol stop", async () => {
    const model = new ScriptedModelPort([[{ type: "text_delta", delta: "unfinished" }]])
    const tools = new ScriptedToolPort(() => {
      throw new Error("must not execute")
    })
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request())

    expect(result).toMatchObject({ status: "stopped", stopReason: "model_protocol_error" })
  })
})

function toSemanticEventTypes(events: readonly { type: string }[]): string[] {
  return events
    .filter((event) => event.type !== "model_stream_event")
    .map((event) => event.type)
}
