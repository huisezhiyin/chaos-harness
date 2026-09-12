import { describe, expect, it } from "vitest"
import { ids, type ModelPort, type ModelRequest } from "../../../kernel/src/index.js"
import { withModelTiming, type ModelTimingEvent } from "../src/model-timing.js"

const request: ModelRequest = { attemptId: ids.attempt("timing"), turn: 3, messages: [], tools: [] }
describe("privacy-safe ModelPort timing", () => {
  it("separates first-event delay from streaming progress without logging content", async () => {
    let clock = 0
    const events: ModelTimingEvent[] = []
    const port: ModelPort = { async *stream() {
      clock = 120_000; yield { type: "reasoning_delta", delta: "private reasoning" }
      clock = 121_000; yield { type: "reasoning_delta", delta: "private reasoning" }
      clock = 136_000; yield { type: "text_delta", delta: "private answer" }
      yield { type: "tool_call", call: { name: "private-tool", toolCallId: "private-id", arguments: { secret: "credential" } } }
      clock = 137_000; yield { type: "finish", reason: "tool_calls" }
    } }
    const observed = []
    for await (const event of withModelTiming(port, async e => { events.push(e) }, () => clock).stream(request, new AbortController().signal)) observed.push(event)
    expect(observed).toHaveLength(5)
    expect(events.map(e => e.event)).toEqual(["model_request_started", "model_first_event", "model_stream_progress", "model_request_finished"])
    expect(events[1]).toMatchObject({ firstEventMs: 120_000, eventCounts: { reasoning_delta: 1 } })
    expect(events.at(-1)).toMatchObject({ elapsedMs: 137_000, firstEventMs: 120_000, lastEventMs: 137_000,
      outcome: "ended", eventCounts: { reasoning_delta: 2, text_delta: 1, tool_call: 1, finish: 1 } })
    expect(JSON.stringify(events)).not.toMatch(/private|credential/)
  })
  it("records abort immediately even if the delegate ignores the signal, without double finishing", async () => {
    let clock = 0, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const events: ModelTimingEvent[] = [], controller = new AbortController()
    const port: ModelPort = { async *stream() { await gate; yield { type: "text_delta", delta: "never released" } } }
    const iterator = withModelTiming(port, async e => { events.push(e) }, () => clock).stream(request, controller.signal)[Symbol.asyncIterator]()
    const waiting = iterator.next()
    await Promise.resolve(); clock = 60_000; controller.abort(new Error("private abort reason"))
    expect(events.at(-1)).toMatchObject({ event: "model_request_finished", elapsedMs: 60_000, outcome: "aborted", eventCounts: {} })
    release(); await expect(waiting).rejects.toThrow()
    expect(events.filter(e => e.event === "model_request_finished")).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain("private")
  })
  it("records failure before any first event without inventing a response", async () => {
    const events: ModelTimingEvent[] = []
    const port: ModelPort = { async *stream() { throw new Error("private provider failure") } }
    const consume = async () => { for await (const _ of withModelTiming(port, async e => { events.push(e) }).stream(request, new AbortController().signal)) {} }
    await expect(consume()).rejects.toThrow("private provider failure")
    expect(events.map(e => e.event)).toEqual(["model_request_started", "model_request_finished"])
    expect(events.at(-1)).toMatchObject({ outcome: "error", eventCounts: {} })
    expect(events.at(-1)?.firstEventMs).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain("private")
  })
  it("marks a consumer-shortened stream as interrupted", async () => {
    const events: ModelTimingEvent[] = []
    const port: ModelPort = { async *stream() { yield { type: "text_delta", delta: "one" }; yield { type: "finish", reason: "stop" } } }
    for await (const _ of withModelTiming(port, async e => { events.push(e) }).stream(request, new AbortController().signal)) break
    expect(events.at(-1)).toMatchObject({ outcome: "interrupted", eventCounts: { text_delta: 1 } })
  })
})
