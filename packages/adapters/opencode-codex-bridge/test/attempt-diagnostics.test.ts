import { expect, it } from "vitest"
import { attemptStopMetadata } from "../src/attempt-diagnostics.js"
import { ids, type AttemptRunResult, type AttemptStopReason } from "../../../kernel/src/index.js"

it("distinguishes terminal sources without promoting a recovered progress failure", () => {
  const result = (stopReason: AttemptStopReason): (AttemptRunResult & { status: "stopped" }) => ({
    status: "stopped", stopReason, attemptId: ids.attempt("diagnostics"), messages: [], events: [],
    usage: { turns: 1, actions: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  })
  expect(attemptStopMetadata(result("stop_after_turn"))).toEqual({ kind: "interruption", stopReason: "stop_after_turn" })
  expect(attemptStopMetadata(result("stop_after_turn"), "no_artifact_after_steer")).toMatchObject({ kind: "controller_progress", failureCode: "no_artifact_after_steer" })
  for (const reason of ["max_actions", "max_turns", "max_cost"] as const) {
    expect(attemptStopMetadata(result(reason), "no_artifact_after_steer")).toEqual({ kind: "budget", stopReason: reason })
  }
  expect(attemptStopMetadata(result("model_error"), "repeated_error")).toEqual({ kind: "model", stopReason: "model_error" })
  const { stopReason: _, ...base } = result("stop_after_turn")
  expect(attemptStopMetadata({ ...base, status: "completion_proposed", completion: "accepted" }, "repeated_cycle")).toBeUndefined()
})
