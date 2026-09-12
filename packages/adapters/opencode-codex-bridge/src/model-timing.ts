import type { ModelPort, ModelStreamEvent } from "../../../kernel/src/index.js"

export interface ModelTimingEvent {
  event: "model_request_started" | "model_first_event" | "model_stream_progress" | "model_request_finished"
  turn: number
  elapsedMs: number
  eventCounts: Partial<Record<ModelStreamEvent["type"], number>>
  firstEventMs?: number
  lastEventMs?: number
  maxEventGapMs: number
  outcome?: "ended" | "error" | "aborted" | "interrupted"
}

/** ModelPort timing only: this does not claim to measure HTTP or provider queue time. */
export function withModelTiming(delegate: ModelPort, record: (event: ModelTimingEvent) => Promise<void>,
  now: () => number = () => performance.now()): ModelPort {
  return { async *stream(request, signal) {
    const start = now(), counts: ModelTimingEvent["eventCounts"] = {}
    let first: number | undefined, last: number | undefined, maxGap = 0, lastReport = start
    let terminal: Promise<void> | undefined
    let outcome: NonNullable<ModelTimingEvent["outcome"]> = "interrupted"
    const ms = (value: number) => Math.max(0, Math.round(value))
    const emit = (event: ModelTimingEvent["event"], outcome?: ModelTimingEvent["outcome"]) => {
      const at = now()
      return record({ event, turn: request.turn, elapsedMs: ms(at - start), eventCounts: { ...counts },
        maxEventGapMs: ms(Math.max(maxGap, at - (last ?? start))),
        ...(first === undefined ? {} : { firstEventMs: ms(first - start) }),
        ...(last === undefined ? {} : { lastEventMs: ms(last - start) }),
        ...(outcome === undefined ? {} : { outcome }),
      })
    }
    const finish = (value: NonNullable<ModelTimingEvent["outcome"]>) => terminal ??= emit("model_request_finished", value)
    const aborted = () => { void finish("aborted").catch(() => {}) }
    await emit("model_request_started")
    signal.addEventListener("abort", aborted, { once: true })
    try {
      signal.throwIfAborted()
      for await (const event of delegate.stream(request, signal)) {
        signal.throwIfAborted()
        const at = now(), isFirst = first === undefined
        if (isFirst) first = at
        maxGap = Math.max(maxGap, at - (last ?? start)); last = at
        // Never serialize untrusted event payloads, tool names, arguments or error text.
        if (["reasoning_delta", "text_delta", "tool_call", "usage", "finish"].includes(event.type)) {
          counts[event.type] = (counts[event.type] ?? 0) + 1
        }
        if (isFirst) { await emit("model_first_event"); lastReport = at }
        else if (at - lastReport >= 15_000) { await emit("model_stream_progress"); lastReport = at }
        yield event
      }
      outcome = "ended"
    } catch (error) {
      outcome = signal.aborted ? "aborted" : "error"
      throw error
    } finally {
      signal.removeEventListener("abort", aborted)
      await finish(signal.aborted ? "aborted" : outcome)
    }
  } }
}
