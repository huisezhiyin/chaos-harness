import { describe, expect, it, vi } from "vitest"
import { CodexAppServerClient } from "../src/client.js"
import { runCodexAppServerSelfCheck } from "../src/self-check.js"
import { isRecord } from "../src/protocol.js"
import { FakeAppServerProcess } from "./fake-process.js"

describe("runCodexAppServerSelfCheck", () => {
  it("reports ready from initialize and model/list without starting a turn", async () => {
    const process = scriptedSelfCheckProcess({ data: [{ id: "model-a" }] })

    const result = await runCodexAppServerSelfCheck({
      readVersion: async () => "0.133.0",
      createClient: () => new CodexAppServerClient({ processFactory: () => process }),
    })

    expect(result).toMatchObject({
      status: "ready",
      liveReady: false,
      cliVersion: "0.133.0",
      schemaCompatibility: "codex-cli/0.133.0:stable",
      modelList: { status: "ready", count: 1 },
    })
    expect(process.received).not.toContainEqual(expect.objectContaining({ method: "turn/start" }))
  })

  it("classifies model/list timeout as degraded but safe", async () => {
    const process = scriptedSelfCheckProcess(undefined)

    const result = await runCodexAppServerSelfCheck({
      readVersion: async () => "0.133.0",
      createClient: () => new CodexAppServerClient({ processFactory: () => process }),
      modelListTimeoutMs: 5,
    })

    expect(result).toMatchObject({
      status: "degraded",
      liveReady: false,
      modelList: { status: "safe_timeout" },
    })
  })

  it("fails closed before spawning when the CLI version drifts", async () => {
    const createClient = vi.fn()

    await expect(runCodexAppServerSelfCheck({
      readVersion: async () => "0.134.0",
      createClient,
    })).rejects.toThrow("Unsupported Codex CLI version")
    expect(createClient).not.toHaveBeenCalled()
  })
})

function scriptedSelfCheckProcess(modelList: unknown): FakeAppServerProcess {
  const process = new FakeAppServerProcess()
  process.onMessage = (message) => {
    const record = isRecord(message) ? message : undefined
    if (record?.method === "initialize") {
      process.send({
        id: record.id,
        result: {
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "codex-cli/0.133.0",
        },
      })
    } else if (record?.method === "model/list" && modelList !== undefined) {
      process.send({ id: record.id, result: modelList })
    }
  }
  return process
}
