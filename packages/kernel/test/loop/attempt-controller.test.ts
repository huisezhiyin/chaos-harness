import { describe, expect, it } from "vitest"
import { AttemptController } from "../../src/index.js"

describe("AttemptController", () => {
  it("preserves submission order with monotonic control ids", () => {
    const controller = new AttemptController()

    const first = controller.steer("inspect the tests first")
    const second = controller.stopAfterTurn("pause for review")

    expect(controller.drain()).toEqual([first, second])
    expect(first.controlId).toBe("attempt-control-1")
    expect(second.controlId).toBe("attempt-control-2")
    expect(controller.drain()).toEqual([])
  })

  it("makes cancellation idempotent and closes boundary submissions", () => {
    const controller = new AttemptController()

    const first = controller.cancel("user cancelled")
    const second = controller.cancel("duplicate cancel")

    expect(second).toBe(first)
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe(first)
    expect(() => controller.steer("too late")).toThrow("attempt controller is cancelled")
    expect(() => controller.stopAfterTurn()).toThrow("attempt controller is cancelled")
  })

  it("rejects empty control content", () => {
    const controller = new AttemptController()

    expect(() => controller.steer("  ")).toThrow(TypeError)
    expect(() => controller.stopAfterTurn(" ")).toThrow(TypeError)
    expect(() => controller.cancel(" ")).toThrow(TypeError)
  })
})
