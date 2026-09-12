import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import type { ModelPort, ModelRequest, ModelStreamEvent, ToolCall } from "../../../kernel/src/index.js"
import { checkWorkspaceAction, diagnoseWorkspaceAction } from "../src/workspace-action-boundary.js"
import { startOpenCodeQwenLoopBridge, QWEN_LOOP_MODEL_ID, type OpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../src/qwen-loop-bridge.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"

const call = (name: string, args: ToolCall["arguments"], n = 1): ToolCall => ({ name, arguments: args, toolCallId: `call-${n}` })
const profile = { apiKey: "fake-key", baseUrl: "https://unused.invalid/v1", model: "fake-model" }
function script(steps: (request: ModelRequest) => ToolCall | ToolCall[] | string, requests: ModelRequest[]): ModelPort {
  return { async *stream(request): AsyncIterable<ModelStreamEvent> {
    requests.push(structuredClone(request))
    const result = steps(request)
    if (typeof result === "string") { yield { type: "text_delta", delta: result }; yield { type: "finish", reason: "stop" } }
    else { for (const item of Array.isArray(result) ? result : [result]) yield { type: "tool_call", call: item }; yield { type: "finish", reason: "tool_calls" } }
  } }
}
async function send(bridge: OpenCodeQwenLoopBridge, observation?: { id: string; ok: boolean; content: string }, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: QWEN_LOOP_MODEL_ID, messages: [
      { role: "user", content: "只读查看 TASK.md，不修改文件。" },
      ...(observation ? [{ role: "tool", tool_call_id: observation.id, content: encodeOpenCodeToolObservation({ token: bridge.observationToken, toolCallId: observation.id, ok: observation.ok, content: observation.content }) }] : []),
    ], tools: ["read", "write"].map(name => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } })) }),
  })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(expectedStatus)
  return body
}

describe("workspace boundary recovery before Host dispatch", () => {
  it("explains rejected paths with enums and permits real in-root ancestor chains", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-boundary-")))
    try {
      await mkdir(join(root, "internal"))
      await symlink(join(root, "internal"), join(root, "alias"))
      await writeFile(join(root, "file"), "private contents")
      await symlink(join(root, "absent"), join(root, "broken"))
      await symlink(root + "-outside", join(root, "escape"))
      for (const filePath of ["new/deep/file.ts", "alias/deep/file.ts", join(root, "internal/file.ts")]) {
        expect(await diagnoseWorkspaceAction(root, call("write", { filePath }))).toBeUndefined()
      }
      const cases = [
        [{}, "missing_path", "missing"], [{ filePath: 1 }, "invalid_path_type", "invalid"],
        [{ filePath: " " }, "empty_path", "relative"], [{ filePath: "~/secret" }, "home_shorthand", "home"],
        [{ filePath: "secret\0" }, "null_byte", "relative"], [{ filePath: "../private-secret" }, "lexical_escape", "relative"],
        [{ filePath: "file/child.ts" }, "resolution_failed", "relative"], [{ filePath: "broken/child.ts" }, "resolution_failed", "relative"],
      ] as const
      for (const [args, detail, pathKind] of cases) {
        const diagnosis = await diagnoseWorkspaceAction(root, call("write", args))
        expect(diagnosis).toEqual({ reason: detail === "lexical_escape" ? "outside_workspace" : "unresolved_path", detail, pathKind, pathField: "filePath" })
        expect(JSON.stringify(diagnosis)).not.toContain("private-secret")
        expect(JSON.stringify(diagnosis)).not.toContain(root)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it("checks lexical escapes and real symlink ancestors without reading external contents", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-boundary-")))
    const outside = await realpath(await mkdtemp(join(tmpdir(), "chaos-outside-")))
    try {
      await writeFile(join(root, "TASK.md"), "task")
      await symlink(outside, join(root, "link"))
      await symlink(join(outside, "absent"), join(root, "broken"))
      for (const filePath of ["TASK.md", "new/file.js", join(root, "TASK.md")]) expect(await checkWorkspaceAction(root, call("read", { filePath }))).toBeUndefined()
      for (const filePath of ["../other", `${root}-typo/TASK.md`, "link/new/file.js"]) expect(await checkWorkspaceAction(root, call("read", { filePath }))).toBe("outside_workspace")
      expect(await checkWorkspaceAction(root, call("write", { filePath: "broken/new.js" }))).toBe("unresolved_path")
      expect(await checkWorkspaceAction(root, call("read", { filePath: "~/other" }))).toBe("unresolved_path")
      expect(await checkWorkspaceAction(root, call("bash", { workdir: outside }))).toBe("outside_workspace")
      expect(await checkWorkspaceAction(root, call("grep", { path: outside }))).toBe("outside_workspace")
      expect(await checkWorkspaceAction(root, call("glob", {}))).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })

  it("turns a typo into a failed observation, then relays the corrected call in the same Attempt", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-boundary-")))
    const requests: ModelRequest[] = [], events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: root, profile, workspaceBoundary: "root-only",
      modelFactory: () => script(r => r.turn === 1 ? call("read", { filePath: `${root}-typo/TASK.md` }) : r.turn === 2 ? call("read", { filePath: "TASK.md" }, 2) : "Inspected TASK.md", requests),
      recordEvent: async e => { events.push(e) }, attemptBudget: { maxTurns: 6, maxActions: 6 },
    })
    try {
      const first = await send(bridge)
      expect(first.choices[0].message.tool_calls[0]).toMatchObject({ id: "call-2", function: { arguments: '{"filePath":"TASK.md"}' } })
      expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "tool", ok: false, content: expect.stringContaining(root) }))
      expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "tool", content: expect.stringContaining("not sent to the Host") }))
      const last = await send(bridge, { id: "call-2", ok: true, content: "Task requirements" })
      expect(last.choices[0].message.content).toBe("Inspected TASK.md")
      expect(new Set(requests.map(r => r.attemptId)).size).toBe(1)
      expect(events.flatMap(e => e.event === "action_observed" ? [e.ok] : [])).toEqual([false, true])
      expect(events.find(e => e.event === "action_observed" && e.observationSource === "workspace_preflight")).toMatchObject({
        workspaceBoundary: { reason: "outside_workspace", detail: "lexical_escape", pathKind: "absolute", pathField: "filePath" }, workspaceRejectionLimitReached: false,
      })
      expect(events.filter(e => e.event === "action_proposed")).toHaveLength(1)
      expect(events.find(e => e.event === "attempt_finished")).toMatchObject({
        actionAccounting: { proposed: 2, hostForwarded: 1, hostObserved: 1, workspaceRejected: 1, controllerBlocked: 0 },
      })
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
      expect(JSON.stringify(events)).not.toContain(root)
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })

  it("stops after two rejected proposals and does not dispatch later actions in that turn", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chaos-boundary-")))
    const requests: ModelRequest[] = [], events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: root, profile, workspaceBoundary: "root-only",
      modelFactory: () => script(r => r.turn === 1 ? call("read", { filePath: `${root}-typo/TASK.md` }) : [call("read", { filePath: "../other" }, 2), call("write", { filePath: "safe.js" }, 3)], requests),
      recordEvent: async e => { events.push(e) },
    })
    try {
      const result = await send(bridge, undefined, 422)
      expect(result.error.code).toBe("attempt_stop_after_turn")
      expect(requests).toHaveLength(2)
      expect(events.filter(e => e.event === "action_proposed")).toHaveLength(0)
      expect(events.find(e => e.event === "attempt_finished")).toMatchObject({ stopReason: "stop_after_turn" })
      expect(events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")).toBe(false)
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })

  it("keeps the default Host boundary and never manufactures success for a signed native refusal", async () => {
    const requests: ModelRequest[] = []
    const bridge = await startOpenCodeQwenLoopBridge({ workspaceRoot: "/workspace", profile,
      modelFactory: () => script(r => r.turn === 1 ? call("read", { filePath: "/other/TASK.md" }) : "Blocked", requests), attemptBudget: { maxTurns: 3, maxActions: 2 },
    })
    try {
      expect((await send(bridge)).choices[0].message.tool_calls[0].id).toBe("call-1")
      await send(bridge, { id: "call-1", ok: false, content: "The user rejected permission to use this specific tool call." })
      expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "tool", ok: false, content: expect.stringContaining("user rejected permission") }))
    } finally { await bridge.close() }
  })
})
