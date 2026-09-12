import { describe, expect, it } from "vitest"
import {
  ModelDecisionAssembler,
  ModelProtocolError,
  type ModelStreamEvent,
} from "../../src/index.js"

function assemble(events: readonly ModelStreamEvent[]) {
  const assembler = new ModelDecisionAssembler()
  for (const event of events) {
    assembler.push(event)
  }
  return assembler.finish()
}

describe("ModelDecisionAssembler", () => {
  it("assembles streaming text and usage into a final decision", () => {
    expect(
      assemble([
        { type: "reasoning_delta", delta: "inspect then " },
        { type: "reasoning_delta", delta: "answer" },
        { type: "text_delta", delta: "done" },
        { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0.01 } },
        { type: "finish", reason: "stop" },
      ]),
    ).toEqual({
      kind: "final",
      reasoning: "inspect then answer",
      text: "done",
      usage: { inputTokens: 4, outputTokens: 2, cost: 0.01 },
      finishReason: "stop",
    })
  })

  it("assembles a normalized complete tool call", () => {
    const decision = assemble([
      {
        type: "tool_call",
        call: { toolCallId: "call-1", name: "read_file", arguments: { path: "README.md" } },
      },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(decision.kind).toBe("tool_calls")
    if (decision.kind === "tool_calls") {
      expect(decision.toolCalls).toHaveLength(1)
    }
  })

  it("rejects missing finish and duplicate tool call ids", () => {
    const missingFinish = new ModelDecisionAssembler()
    missingFinish.push({ type: "text_delta", delta: "partial" })
    expect(() => missingFinish.finish()).toThrowError(ModelProtocolError)

    const duplicate = new ModelDecisionAssembler()
    const call = { toolCallId: "call-1", name: "read_file", arguments: {} }
    duplicate.push({ type: "tool_call", call })
    expect(() => duplicate.push({ type: "tool_call", call })).toThrowError(ModelProtocolError)
  })
})
