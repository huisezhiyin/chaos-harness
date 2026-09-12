import type {
  ModelDecision,
  ModelFinishReason,
  ModelStreamEvent,
  ModelUsage,
  ToolCall,
} from "./contracts.js"

const zeroUsage = (): ModelUsage => ({ inputTokens: 0, outputTokens: 0, cost: 0 })

export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelProtocolError"
  }
}

export class ModelDecisionAssembler {
  readonly #reasoning: string[] = []
  readonly #text: string[] = []
  readonly #toolCalls: ToolCall[] = []
  readonly #toolCallIds = new Set<string>()
  #usage: ModelUsage = zeroUsage()
  #finishReason?: ModelFinishReason

  push(event: ModelStreamEvent): void {
    if (this.#finishReason !== undefined) {
      throw new ModelProtocolError("model stream emitted data after finish")
    }

    switch (event.type) {
      case "reasoning_delta":
        this.#reasoning.push(event.delta)
        break
      case "text_delta":
        this.#text.push(event.delta)
        break
      case "tool_call":
        if (this.#toolCallIds.has(event.call.toolCallId)) {
          throw new ModelProtocolError(`duplicate tool call id: ${event.call.toolCallId}`)
        }
        this.#toolCallIds.add(event.call.toolCallId)
        this.#toolCalls.push(event.call)
        break
      case "usage":
        this.#usage = event.usage
        break
      case "finish":
        this.#finishReason = event.reason
        break
    }
  }

  finish(): ModelDecision {
    const finishReason = this.#finishReason
    if (finishReason === undefined) {
      throw new ModelProtocolError("model stream ended without finish event")
    }

    const reasoning = this.#reasoning.join("")
    const text = this.#text.join("")
    if (finishReason === "tool_calls") {
      if (this.#toolCalls.length === 0) {
        throw new ModelProtocolError("tool_calls finish requires at least one tool call")
      }
      return {
        kind: "tool_calls",
        reasoning,
        text,
        toolCalls: [...this.#toolCalls],
        usage: this.#usage,
        finishReason,
      }
    }

    if (this.#toolCalls.length > 0) {
      throw new ModelProtocolError(`tool calls are incompatible with finish reason: ${finishReason}`)
    }

    if (finishReason === "stop") {
      return { kind: "final", reasoning, text, usage: this.#usage, finishReason }
    }

    return { kind: "incomplete", reasoning, text, usage: this.#usage, finishReason }
  }
}
