import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ids, type ModelPort, type ModelRequest, type ModelStreamEvent } from "../../../kernel/src/index.js"
import { collect } from "../../deepseek/test/fixtures.js"
import { assertDirectPersonalProfile, diagnosticArgs, diagnosticEnvironment, guardDiagnosticModel, main, newDiagnosticState } from "../src/stream-diagnostic.js"

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const request: ModelRequest = { attemptId: ids.attempt("fixture"), turn: 1, messages: [],
  tools: [{ name: "read", description: "Read", inputSchema: {} }, { name: "bash", description: "Shell", inputSchema: {} }] }
const end: ModelStreamEvent[] = [{ type: "usage", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } }, { type: "finish", reason: "stop" }]
const read = (filePath: string, name = "read"): ModelStreamEvent => ({ type: "tool_call", call: {
  toolCallId: "read-1", name, arguments: { filePath },
} })
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "chaos-stream-guard-")); dirs.push(dir)
  await writeFile(join(dir, "package.json"), '{"name":"fixture"}')
  return await realpath(dir)
}
const drain = (model: ModelPort, signal = new AbortController().signal) => collect(model.stream(request, signal))

describe("bounded stream diagnostic", () => {
  it("rejects proxy endpoint overrides for the personal direct experiment", () => {
    const profile = { apiKey: "fixture-secret", model: "fixture", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }
    expect(assertDirectPersonalProfile(profile)).toBe(profile)
    for (const baseUrl of ["http://127.0.0.1:15722/v1", "https://dashscope.aliyuncs.com.evil.invalid/compatible-mode/v1", "https://other.invalid/v1"]) {
      expect(() => assertDirectPersonalProfile({ ...profile, baseUrl })).toThrow("direct DashScope")
    }
  })
  it("binds the actual native directory and restricts the process overlay", () => {
    expect(diagnosticArgs("/workspace").slice(0, 3)).toEqual(["run", "--dir", "/workspace"])
    const env = { OPENCODE_CONFIG_CONTENT: '{"model":"existing-model"}', PWD: "/wrong" }
    const restricted = diagnosticEnvironment(env, "/workspace")
    expect(restricted.PWD).toBe("/workspace")
    expect(JSON.parse(restricted.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "existing-model",
      permission: { "*": "deny", read: { "*": "deny", "package.json": "allow", "/workspace/package.json": "allow" } } })
    expect(env.PWD).toBe("/wrong")
  })
  it("forwards only Read and rejects the fourth request before dispatch", async () => {
    const seen: ModelRequest[] = [], state = newDiagnosticState()
    const model = guardDiagnosticModel({ async *stream(request) { seen.push(request); yield* end } }, state, await root(), new AbortController().signal)
    for (let i = 0; i < 3; i++) await drain(model)
    await expect(drain(model)).rejects.toThrow("request limit")
    expect(state.requests).toBe(3)
    expect(seen).toHaveLength(3)
    expect(seen[0]!.tools.map(t => t.name)).toEqual(["read"])
    await expect(drain(model)).rejects.toThrow("stopped after a model failure")
  })
  it.each(["wrong-file", "wrong-tool", "two-reads", "truncated", "symlink"])("blocks %s before releasing any tool", async kind => {
    const dir = await root(), state = newDiagnosticState(), emitted: ModelStreamEvent[] = []
    if (kind === "symlink") { await rm(join(dir, "package.json")); await symlink(join(dir, "other.json"), join(dir, "package.json")); await writeFile(join(dir, "other.json"), '{}') }
    const model = guardDiagnosticModel({ async *stream() {
      yield read(kind === "wrong-file" ? "../package.json" : "package.json", kind === "wrong-tool" ? "bash" : "read")
      if (kind === "two-reads") yield read("package.json")
      if (kind === "truncated") throw new Error("fixture truncated")
      yield* end
    } }, state, dir, new AbortController().signal)
    await expect((async () => { for await (const event of model.stream(request, new AbortController().signal)) emitted.push(event) })()).rejects.toThrow()
    expect(emitted).toEqual([])
    expect(state.releasedReads).toBe(0)
    expect(state.stopped).toBe(true)
  })
  it("does not allow a second read even on a later request", async () => {
    const state = newDiagnosticState(), dir = await root()
    const model = guardDiagnosticModel({ async *stream() { yield read("package.json"); yield* end } }, state, dir, new AbortController().signal)
    expect(await drain(model)).toContainEqual(read("package.json"))
    await expect(drain(model)).rejects.toThrow("read limit")
    expect(state.releasedReads).toBe(1)
  })
  it("refuses dispatch after a failed observation or deadline", async () => {
    const state = newDiagnosticState(), dispatch = vi.fn(), deadline = new AbortController()
    const model = guardDiagnosticModel({ async *stream() { dispatch(); yield* end } }, state, await root(), deadline.signal)
    state.stopped = true
    await expect(drain(model)).rejects.toThrow("stopped after a model failure")
    state.stopped = false; deadline.abort(new Error("deadline"))
    await expect(drain(model)).rejects.toThrow("deadline")
    expect(dispatch).not.toHaveBeenCalled()
  })
  it("defaults to help and rejects accidental batch or provider arguments", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    expect(await main([])).toBe(0)
    expect(output).toHaveBeenCalledOnce()
    await expect(main(["run", "--batch", "coding-batch-v3"])).rejects.toThrow("no other arguments")
    await expect(main(["--source", "company"])).rejects.toThrow("no other arguments")
  })
})
