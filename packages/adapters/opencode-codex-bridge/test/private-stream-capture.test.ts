import { mkdtemp, readFile, readdir, rm, stat, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ids, type ModelPort, type ModelRequest } from "../../../kernel/src/index.js"
import { ChatStreamError, DeepSeekChatModelPort, IncompleteChatStreamError } from "../../deepseek/src/index.js"
import { finishChunk, sseResponse, usageChunk } from "../../deepseek/test/fixtures.js"
import { createPrivateStreamCapture } from "../src/private-stream-capture.js"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const profile = { model: "fake", baseUrl: "http://127.0.0.1:1", apiKey: "sensitive-private-key" }
const request: ModelRequest = { attemptId: ids.attempt("fixture"), turn: 1, messages: [], tools: [] }
const failure = () => new IncompleteChatStreamError({ httpStatus: 200, contentType: "sse", dataEvents: 1,
  finishObserved: true, usageObserved: false, textObserved: true, reasoningObserved: false, toolCallsObserved: 0 })
async function drain(model: ModelPort) { for await (const _event of model.stream(request, new AbortController().signal)) { /* consume */ } }
async function parent() { const path = await mkdtemp(join(tmpdir(), "chaos-capture-test-")); dirs.push(path); return path }

describe("private incomplete-stream capture", () => {
  it.each(["missing_finish", "missing_usage", "upstream_error"] as const)("captures real adapter %s errors and blocks redispatch", async code => {
    const base = await parent(), onCapture = vi.fn()
    const fetchMock = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: profile.apiKey, reasoning_content: "private-reasoning" }, finish_reason: null }] }),
      ...(code === "missing_finish" ? [] : [finishChunk("stop")]),
      ...(code === "missing_usage" ? [] : [usageChunk]),
      ...(code === "upstream_error" ? [JSON.stringify({ error: { message: "private-message", code: "private-code" } })] : []),
      "[DONE]",
    ], 7))
    const factory = createPrivateStreamCapture({ parent: base, onCapture,
      modelFactory: () => new DeepSeekChatModelPort({ apiKey: profile.apiKey, fetch: fetchMock }) })
    await expect(drain(factory(profile))).rejects.toMatchObject({ code })
    const path = onCapture.mock.calls[0]![0] as string
    const content = await readFile(path, "utf8")
    expect(JSON.parse(content)).toMatchObject({ code, text: "[REDACTED]", stream: {
      doneObserved: code !== "upstream_error", reasoningObserved: true,
    } })
    for (const secret of [profile.apiKey, "private-reasoning", "private-message", "private-code"]) expect(content).not.toContain(secret)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(drain(factory(profile))).rejects.toThrow("stopped after a model failure")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledTimes(1)
  })
  it("captures redacted text privately once and stops subsequent model dispatch across drivers", async () => {
    const base = await parent(), onCapture = vi.fn(), error = failure()
    let calls = 0
    const factory = createPrivateStreamCapture({ parent: base, onCapture, modelFactory: () => ({ async *stream() {
      calls++
      yield { type: "text_delta", delta: "upstream error sensitive-" }
      yield { type: "text_delta", delta: "private-key Bearer credential https://private.invalid/path" }
      throw error
    } }) })
    await expect(drain(factory(profile))).rejects.toBe(error)
    const path = onCapture.mock.calls[0]![0] as string
    const content = await readFile(path, "utf8")
    expect(content).toContain("upstream error")
    for (const secret of [profile.apiKey, "credential", "private.invalid"]) expect(content).not.toContain(secret)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700)
    await expect(drain(factory(profile))).rejects.toThrow("stopped after a model failure")
    expect(calls).toBe(1)
    expect(onCapture).toHaveBeenCalledTimes(1)
  })
  it("does not persist successful text and still permits later successful turns", async () => {
    const base = await parent()
    const model = createPrivateStreamCapture({ parent: base, modelFactory: () => ({ async *stream() {
      yield { type: "text_delta", delta: "successful response must not be retained" }
      yield { type: "finish", reason: "stop" }
    } }) })(profile)
    await drain(model); await drain(model)
    expect(await readdir(base)).toEqual([])
  })
  it("caps collected text and redacts a credential cut by the limit", async () => {
    const base = await parent(), onCapture = vi.fn()
    const model = createPrivateStreamCapture({ parent: base, onCapture, modelFactory: () => ({ async *stream() {
      yield { type: "text_delta", delta: "x".repeat(32_758) + profile.apiKey + "y".repeat(100_000) }
      throw failure()
    } }) })(profile)
    await expect(drain(model)).rejects.toBeInstanceOf(IncompleteChatStreamError)
    const capture = JSON.parse(await readFile(onCapture.mock.calls[0]![0] as string, "utf8"))
    expect(capture.text).toHaveLength(32_768)
    expect(capture.text.endsWith("[REDACTED]")).toBe(true)
    expect(capture.text).not.toContain(profile.apiKey.slice(0, 10))
  })
  it.each(["missing_done", "missing_finish", "missing_usage", "upstream_error"] as const)("preserves %s if the capture directory is unsafe", async code => {
    const base = await parent(); await chmod(base, 0o755)
    const onCaptureFailure = vi.fn(), error = new ChatStreamError(code, failure().diagnostics)
    const model = createPrivateStreamCapture({ parent: base, onCaptureFailure, modelFactory: () => ({ async *stream() { throw error } }) })(profile)
    await expect(drain(model)).rejects.toBe(error)
    expect(onCaptureFailure).toHaveBeenCalledTimes(1)
    expect(await readdir(base)).toEqual([])
  })
})
