import { describe, expect, it } from "vitest"
import {
  AttemptController,
  NativeAttemptEngine,
  ids,
  type AttemptRequest,
  type ModelPort,
  type ModelRequest,
  type ModelStreamEvent,
  type ToolPort,
  type ToolDefinition,
} from "../../src/index.js"
import { ScriptedPermissionPort, ScriptedToolPort, allowAll } from "./fakes.js"

const tool: ToolDefinition = {
  name: "read_file",
  description: "Read a text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}

const finalDecision = (text = "done"): ModelStreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0.001 } },
  { type: "finish", reason: "stop" },
]

const toolDecision = (count = 1): ModelStreamEvent[] => [
  ...Array.from({ length: count }, (_, index): ModelStreamEvent => ({
    type: "tool_call",
    call: {
      toolCallId: `call-${index + 1}`,
      name: "read_file",
      arguments: { path: "README.md" },
    },
  })),
  { type: "finish", reason: "tool_calls" },
]

function request(): AttemptRequest {
  return {
    attempt: {
      attemptId: ids.attempt("controlled-attempt-1"),
      unitId: ids.unit("unit-1"),
      unitRevision: 1,
      projectionId: ids.projection("projection-1"),
    },
    messages: [{ role: "user", content: "Complete the current unit" }],
    tools: [tool],
    budget: { maxTurns: 5, maxActions: 5, maxCost: 1 },
  }
}

class HookedModelPort implements ModelPort {
  readonly requests: ModelRequest[] = []
  readonly signals: AbortSignal[] = []
  readonly #scripts: ModelStreamEvent[][]
  readonly #beforeStream: (request: ModelRequest, signal: AbortSignal) => void

  constructor(
    scripts: readonly (readonly ModelStreamEvent[])[],
    beforeStream: (request: ModelRequest, signal: AbortSignal) => void = () => undefined,
  ) {
    this.#scripts = scripts.map((script) => [...script])
    this.#beforeStream = beforeStream
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    this.signals.push(signal)
    this.#beforeStream(request, signal)
    const script = this.#scripts.shift()
    if (script === undefined) {
      throw new Error("No scripted model response")
    }
    for (const event of script) {
      if (signal.aborted) {
        return
      }
      yield event
    }
  }
}

describe("NativeAttemptEngine Control Profile", () => {
  it("applies steer submitted before the first turn to the first model request", async () => {
    const controller = new AttemptController()
    const steer = controller.steer("prioritize the public API")
    const model = new HookedModelPort([finalDecision()])
    const engine = createEngine(model)

    const result = await engine.run(request(), { control: controller })

    expect(result.status).toBe("completion_proposed")
    expect(model.requests[0]?.messages).toContainEqual({
      role: "control",
      content: "prioritize the public API",
      controlId: steer.controlId,
    })
  })

  it("uses steer received during final generation to continue into another turn", async () => {
    const controller = new AttemptController()
    const model = new HookedModelPort(
      [finalDecision("first answer"), finalDecision("revised answer")],
      (modelRequest) => {
        if (modelRequest.turn === 1) {
          controller.steer("revise using the new constraint")
        }
      },
    )
    const engine = createEngine(model)

    const result = await engine.run(request(), { control: controller })

    expect(result).toMatchObject({
      status: "completion_proposed",
      completion: "revised answer",
    })
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "assistant", content: "first answer" },
      { role: "control", content: "revise using the new constraint" },
    ])
    expect(
      result.events.filter((event) => event.type === "completion_proposed"),
    ).toHaveLength(1)
  })

  it("preserves the order of multiple steers", async () => {
    const controller = new AttemptController()
    controller.steer("first constraint")
    controller.steer("second constraint")
    const model = new HookedModelPort([finalDecision()])
    const engine = createEngine(model)

    await engine.run(request(), { control: controller })

    expect(
      model.requests[0]?.messages
        .filter((message) => message.role === "control")
        .map((message) => message.content),
    ).toEqual(["first constraint", "second constraint"])
  })

  it("runs exactly one turn when stop-after-turn is armed before start", async () => {
    const controller = new AttemptController()
    controller.stopAfterTurn("review required")
    const model = new HookedModelPort([finalDecision("candidate")])
    const engine = createEngine(model)

    const result = await engine.run(request(), { control: controller })

    expect(result).toMatchObject({ status: "stopped", stopReason: "stop_after_turn" })
    expect(model.requests).toHaveLength(1)
    expect(result.events.some((event) => event.type === "completion_proposed")).toBe(false)
  })

  it("finishes the current tool turn before applying stop-after-turn", async () => {
    const controller = new AttemptController()
    const model = new HookedModelPort([toolDecision(2)])
    const tools = new ScriptedToolPort((proposal) => {
      controller.stopAfterTurn("inspect tool output")
      return {
        toolCallId: proposal.call.toolCallId,
        toolName: proposal.call.name,
        ok: true,
        content: "tool completed",
      }
    })
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request(), { control: controller })

    expect(result).toMatchObject({ status: "stopped", stopReason: "stop_after_turn" })
    expect(tools.proposals).toHaveLength(2)
    expect(model.requests).toHaveLength(1)
    expect(result.events.some((event) => event.type === "tool_observed")).toBe(true)
  })

  it("applies only the first stop-after-turn request", async () => {
    const controller = new AttemptController()
    const first = controller.stopAfterTurn("first stop")
    const second = controller.stopAfterTurn("second stop")
    const model = new HookedModelPort([finalDecision()])
    const engine = createEngine(model)

    const result = await engine.run(request(), { control: controller })
    const controls = result.events.filter((event) => event.type === "control_processed")

    expect(controls).toContainEqual(
      expect.objectContaining({ control: first, outcome: "applied" }),
    )
    expect(controls).toContainEqual(
      expect.objectContaining({ control: second, outcome: "ignored" }),
    )
  })

  it("propagates cancellation to an in-flight model and returns cancelled", async () => {
    const controller = new AttemptController()
    const model = new HookedModelPort([finalDecision()], (_request, signal) => {
      controller.cancel("user changed direction")
      expect(signal.aborted).toBe(true)
    })
    const engine = createEngine(model)

    const result = await engine.run(request(), { control: controller })

    expect(result).toMatchObject({ status: "cancelled", stopReason: "cancelled" })
    expect(model.signals[0]?.aborted).toBe(true)
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "control_processed",
        boundary: "in_flight",
        control: expect.objectContaining({ kind: "cancel" }),
      }),
    )
  })

  it("propagates cancellation to an in-flight tool", async () => {
    const controller = new AttemptController()
    const model = new HookedModelPort([toolDecision()])
    let observedSignal: AbortSignal | undefined
    const tools: ToolPort = {
      async execute(_proposal, signal) {
        observedSignal = signal
        controller.cancel("cancel active tool")
        throw new Error("tool observed cancellation")
      },
    }
    const engine = new NativeAttemptEngine({ model, tools, permissions: allowAll() })

    const result = await engine.run(request(), { control: controller })

    expect(result).toMatchObject({ status: "cancelled", stopReason: "cancelled" })
    expect(observedSignal?.aborted).toBe(true)
    expect(result.events.some((event) => event.type === "tool_started")).toBe(true)
  })

  it("lets cancellation override pending steer and stop controls", async () => {
    const controller = new AttemptController()
    controller.steer("pending steer")
    controller.stopAfterTurn("pending stop")
    controller.cancel("cancel now")
    const model = new HookedModelPort([finalDecision()])
    const engine = createEngine(model)

    const result = await engine.run(request(), { control: controller })

    expect(result).toMatchObject({ status: "cancelled", stopReason: "cancelled" })
    expect(model.requests).toHaveLength(0)
    expect(
      result.events.filter((event) => event.type === "control_processed"),
    ).toHaveLength(1)
  })

  it("keeps external abort authoritative when both abort sources are active", async () => {
    const controller = new AttemptController()
    controller.cancel("internal cancellation")
    const external = new AbortController()
    external.abort("host lifecycle ended")
    const model = new HookedModelPort([finalDecision()])
    const engine = createEngine(model)

    const result = await engine.run(request(), {
      signal: external.signal,
      control: controller,
    })

    expect(result).toMatchObject({ status: "aborted", stopReason: "aborted" })
    expect(model.requests).toHaveLength(0)
    expect(result.events.some((event) => event.type === "control_processed")).toBe(false)
  })
})

function createEngine(model: ModelPort): NativeAttemptEngine {
  const tools = new ScriptedToolPort(() => {
    throw new Error("unexpected tool execution")
  })
  const permissions = new ScriptedPermissionPort(() => ({ outcome: "allow" }))
  return new NativeAttemptEngine({ model, tools, permissions })
}
