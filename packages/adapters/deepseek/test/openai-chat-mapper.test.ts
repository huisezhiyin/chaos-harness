import { describe, expect, it } from "vitest"
import { ids, type ModelRequest } from "../../../kernel/src/index.js"
import { mapChatRequest } from "../src/index.js"

describe("mapChatRequest", () => {
  it("maps normalized messages, controls and tools to ChatCompletions", () => {
    const request: ModelRequest = {
      attemptId: ids.attempt("attempt-1"),
      turn: 2,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: "",
          reasoning: "I should inspect README first.",
          toolCalls: [
            {
              toolCallId: "call-1",
              name: "read_file",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: "contents",
          toolCallId: "call-1",
          toolName: "read_file",
          ok: true,
        },
        {
          role: "control",
          content: "focus on the goal",
          controlId: ids.attemptControl("control-1"),
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ],
    }

    const body = mapChatRequest(request, "deepseek-v4-flash", 1_000)

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      max_tokens: 1_000,
    })
    expect(body.messages[2]).toMatchObject({
      role: "assistant",
      reasoning_content: "I should inspect README first.",
      tool_calls: [
        {
          id: "call-1",
          function: { arguments: '{"path":"README.md"}' },
        },
      ],
    })
    expect(body.messages[3]).toEqual({
      role: "tool",
      content: "contents",
      tool_call_id: "call-1",
    })
    expect(body.messages[4]).toEqual({
      role: "user",
      content: "Steering update from the user:\nfocus on the goal",
    })
  })

  it("uses the DashScope thinking switch only for thinking-enabled profiles", () => {
    const body = mapChatRequest(
      {
        attemptId: ids.attempt("attempt-1"),
        turn: 1,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      "qwen3.8-max",
      undefined,
      true,
    )

    expect(body).toMatchObject({ enable_thinking: true })
    expect(body).not.toHaveProperty("thinking")
  })

  it("disables tool choice when no tools are available", () => {
    const body = mapChatRequest(
      {
        attemptId: ids.attempt("attempt-1"),
        turn: 1,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      "deepseek-v4-flash",
      undefined,
    )

    expect(body.tool_choice).toBe("none")
    expect(body).not.toHaveProperty("max_tokens")
  })
})
