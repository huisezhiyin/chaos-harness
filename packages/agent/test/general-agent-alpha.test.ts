import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeepSeekChatModelPort } from "../../adapters/deepseek/src/index.js"
import {
  finishChunk,
  sseResponse,
  usageChunk,
} from "../../adapters/deepseek/test/fixtures.js"
import { runGeneralAgentAlpha } from "../src/index.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("GeneralAgentAlpha", () => {
  it("runs mocked DeepSeek -> real read_file -> observation -> final", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-harness-vertical-"))
    temporaryRoots.push(root)
    await writeFile(join(root, "note.txt"), "the checkpoint is green", "utf8")
    const requests: Array<Record<string, unknown>> = []
    const responses = [toolResponse(), finalResponse("The checkpoint is green.")]
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const response = responses.shift()
      if (response === undefined) {
        throw new Error("unexpected model call")
      }
      return response
    }) as unknown as typeof fetch
    const model = new DeepSeekChatModelPort({
      apiKey: "test-secret",
      fetch: fetchMock,
    })

    const result = await runGeneralAgentAlpha({
      model,
      workspaceRoot: root,
      prompt: "Read note.txt and report its checkpoint state.",
    })

    expect(result).toMatchObject({
      status: "completion_proposed",
      completion: "The checkpoint is green.",
      usage: { turns: 2, actions: 1 },
    })
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests)).not.toContain("test-secret")
    const secondMessages = requests[1]?.messages
    expect(secondMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
          content: "the checkpoint is green",
        }),
      ]),
    )
    expect(result.events.some((event) => event.type === "tool_observed")).toBe(true)
  })
})

function toolResponse(): Response {
  return sseResponse([
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: {
                  name: "read_file",
                  arguments: '{"path":"note.txt"}',
                },
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
  ])
}

function finalResponse(content: string): Response {
  return sseResponse([
    JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
      usage: null,
    }),
    finishChunk("stop"),
    usageChunk,
    "[DONE]",
  ])
}
