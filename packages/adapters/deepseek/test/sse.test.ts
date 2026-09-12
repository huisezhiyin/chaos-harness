import { describe, expect, it, vi } from "vitest"
import { readSseData } from "../src/index.js"
import { collect } from "./fixtures.js"

describe("readSseData", () => {
  it.each([false, true])("cancels early termination and preserves the consumer error (cancel fails=%s)", async fails => {
    const cancel = vi.fn(() => { if (fails) throw new Error("cancellation failed") })
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
    }, cancel })
    const error = new Error("original consumer error")
    const consume = async () => {
      for await (const _ of readSseData(body, new AbortController().signal)) throw error
    }
    await expect(consume()).rejects.toBe(error)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })
  it("parses events split across transport chunks", async () => {
    const bytes = new TextEncoder().encode(
      ": keepalive\r\ndata: {\"value\":1}\r\n\r\ndata: [DONE]\r\n\r\n",
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 3) {
          controller.enqueue(bytes.slice(offset, offset + 3))
        }
        controller.close()
      },
    })

    const values = await collect(readSseData(body, new AbortController().signal))

    expect(values).toEqual(['{"value":1}', "[DONE]"])
  })

  it("joins multiple data lines in one event", async () => {
    const bytes = new TextEncoder().encode("data: first\ndata: second\n\n")
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })

    await expect(
      collect(readSseData(body, new AbortController().signal)),
    ).resolves.toEqual(["first\nsecond"])
  })
})
