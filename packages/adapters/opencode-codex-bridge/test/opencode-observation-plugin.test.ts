import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CHAOS_OBSERVATION_TOKEN_ENV,
  decodeOpenCodeToolObservation,
} from "../src/opencode-observation-envelope.js"

describe("OpenCode observation bridge plugin", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("authenticates completed and error states and removes its token from child env", async () => {
    const token = "observation-token-with-at-least-32-characters"
    vi.stubEnv(CHAOS_OBSERVATION_TOKEN_ENV, token)
    vi.resetModules()
    const { ChaosObservationBridgePlugin } = await import("../src/opencode-observation-plugin.js")
    const hooks = await ChaosObservationBridgePlugin()
    expect(process.env[CHAOS_OBSERVATION_TOKEN_ENV]).toBeUndefined()

    const errorPart = {
      type: "tool" as const,
      callID: "call-error",
      state: { status: "error", error: "File not found" },
    }
    const successPart = {
      type: "tool" as const,
      callID: "call-success",
      state: { status: "completed", output: "success output" },
    }
    const transform = hooks["experimental.chat.messages.transform"]
    await transform({}, { messages: [{ parts: [errorPart, successPart] }] })
    const encodedOnce = errorPart.state.error
    await transform({}, { messages: [{ parts: [errorPart, successPart] }] })

    expect(errorPart.state.error).toBe(encodedOnce)
    expect(errorPart.state.error).not.toContain(token)
    expect(decodeOpenCodeToolObservation(errorPart.state.error, token, "call-error")).toEqual({
      ok: false,
      content: "File not found",
    })
    expect(decodeOpenCodeToolObservation(successPart.state.output, token, "call-success")).toEqual({
      ok: true,
      content: "success output",
    })

    await expect(ChaosObservationBridgePlugin()).resolves.toHaveProperty("experimental.chat.messages.transform")
  })

  it("refuses to start without the per-launch token", async () => {
    vi.stubEnv(CHAOS_OBSERVATION_TOKEN_ENV, "")
    vi.resetModules()
    const { ChaosObservationBridgePlugin } = await import("../src/opencode-observation-plugin.js")
    await expect(ChaosObservationBridgePlugin()).rejects.toThrow("token is missing or invalid")
  })
})
