import { createHash } from "node:crypto"
import type {
  JsonObject,
  ModelMessage,
  ModelRequest,
  ToolCall,
} from "../../../kernel/src/index.js"

export type OpenAiChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant"
      content: string
      reasoning_content?: string
      tool_calls?: OpenAiToolCall[]
    }
  | { role: "tool"; content: string; tool_call_id: string }

export interface OpenAiToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface ChatWireOptions {
  setCacheKey?: boolean
  dialect: "openai" | "dashscope" | "deepseek" | "kimi" | "openrouter"
  thinking: "default" | "enabled" | "disabled"
}

export interface OpenAiChatRequestBody {
  model: string
  messages: OpenAiChatMessage[]
  tools: Array<{
    type: "function"
    function: {
      name: string
      description: string
      parameters: JsonObject
    }
  }>
  tool_choice: "auto" | "none"
  stream: true
  stream_options: { include_usage: true }
  thinking?: { type: "enabled" | "disabled" }
  enable_thinking?: boolean
  reasoning?: { enabled: boolean }
  provider?: { allow_fallbacks: false; require_parameters: true }
  max_tokens?: number
  prompt_cache_key?: string
}

export function mapChatRequest(
  request: ModelRequest,
  model: string,
  maxTokens: number | undefined,
  enableThinking = false,
  wire?: ChatWireOptions,
): OpenAiChatRequestBody {
  const body: OpenAiChatRequestBody = {
    model,
    messages: request.messages.map(mapMessage),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    tool_choice: request.tools.length === 0 ? "none" : "auto",
    stream: true,
    stream_options: { include_usage: true },
    ...(wire?.setCacheKey ? { prompt_cache_key: `chaos-${createHash("sha256").update(String(request.attemptId)).digest("hex")}` } : {}),
    ...(wire ? thinkingFields(wire) : enableThinking
      ? { enable_thinking: true as const }
      : { thinking: { type: "disabled" as const } }),
  }
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens
  }
  return body
}

function thinkingFields(wire: ChatWireOptions): Partial<OpenAiChatRequestBody> {
  if (wire.dialect === "openrouter") return {
    provider: { allow_fallbacks: false, require_parameters: true },
    ...(wire.thinking === "default" ? {} : { reasoning: { enabled: wire.thinking === "enabled" } }),
  }
  if (wire.thinking === "default" || wire.dialect === "openai") return {}
  if (wire.dialect === "dashscope") return { enable_thinking: wire.thinking === "enabled" }
  return { thinking: { type: wire.thinking } }
}

function mapMessage(message: ModelMessage): OpenAiChatMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content }
    case "control":
      return {
        role: "user",
        content: `Steering update from the user:\n${message.content}`,
      }
    case "assistant": {
      const mapped: OpenAiChatMessage = {
        role: "assistant",
        content: message.content,
        ...(message.reasoning === undefined ? {} : { reasoning_content: message.reasoning }),
      }
      if (message.toolCalls !== undefined) {
        mapped.tool_calls = message.toolCalls.map(mapToolCall)
      }
      return mapped
    }
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      }
  }
}

function mapToolCall(call: ToolCall): OpenAiToolCall {
  return {
    id: call.toolCallId,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }
}
