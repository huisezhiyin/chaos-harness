import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ExecutionDeadline, type ModelPort } from "../packages/kernel/src/index.js"
import { launchOpenCodeQwen } from "../packages/adapters/opencode-codex-bridge/src/qwen.js"
import { resolveDefaultOpenCodeCommand } from "../packages/adapters/opencode-codex-bridge/src/cli.js"
import { startOpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js"

// Real pinned Host; deterministic local ModelPort; no credentials, provider or eval target.
const exec = promisify(execFile), root = await realpath(fileURLToPath(new URL("../", import.meta.url)))
const before = await readFile(join(root, "package.json")), expected = JSON.parse(before.toString()).name
for (const scenario of ["closure", "hard-stop"] as const) {
  const deadline = new ExecutionDeadline({ deadlineAtMs: Date.now() + 30000, closureWindowMs: 20000 })
  const events: QwenLoopJournalEvent[] = []; let calls = 0
  try {
    const model: ModelPort = { async *stream(request, signal) {
      calls++
      if (scenario === "hard-stop") await delay(60000, undefined, { signal })
      if (calls === 1) {
        await delay(Math.max(0, deadline.remainingMs - deadline.closureWindowMs + 20), undefined, { signal })
        yield { type: "tool_call", call: { toolCallId: "deadline-read", name: "read", arguments: { filePath: join(root, "package.json") } } }
        yield { type: "finish", reason: "tool_calls" }
      } else {
        assert.equal(calls, 2)
        assert(request.messages.some(m => m.role === "tool" && m.content.includes(expected)))
        assert(request.messages.some(m => m.content.includes("Execution time remaining")))
        assert.deepEqual(request.tools.map(t => t.name), ["read"])
        yield { type: "text_delta", delta: expected }
        yield { type: "finish", reason: "stop" }
      }
    } }
    const code = await launchOpenCodeQwen({ root, deadline, opencodeCommand: resolveDefaultOpenCodeCommand(), workspaceBoundary: "root-only",
      profile: { apiKey: "fixture", model: "scripted-local", baseUrl: "http://127.0.0.1:1/unused" },
      attemptBudget: { maxTurns: 6, maxActions: 6, evidenceClosure: { maxTurns: 3, maxActions: 2, allowedToolNames: ["read"] } },
      completionVerifier: { id: "deadline-read", verify: async context => ({ passed: context.completion.trim() === expected && events.some(e => e.event === "action_observed" && e.action === "read" && e.ok) }) },
      recordEvent: async e => { events.push(e) },
    }, {
      startBridge: options => startOpenCodeQwenLoopBridge({ ...options, modelFactory: () => model }),
      runTui: async input => {
        assert.equal(input.deadline, deadline)
        const running = exec(input.command, ["run", "--dir", root, "--agent", "build", "--model", "chaos-qwen/code-agent", "--format", "json", "Read package.json and reply with its name. Do not modify files."],
          { cwd: root, env: { ...input.env, PWD: root }, signal: deadline.signal, timeout: Math.max(1, deadline.remainingMs), killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
        running.child.stdin?.end()
        try { await running; return 0 } catch { return 1 }
      },
    })
    const succeeded = events.some(e => e.event === "mission_finished" && e.outcome === "succeeded")
    if (scenario === "closure") {
      assert.equal(code, 0); assert.equal(succeeded, true); assert.equal(calls, 2)
      assert(events.some(e => e.event === "evidence_closure_started" && e.closureTrigger === "deadline"))
    } else {
      assert.equal(code, 1); assert.equal(succeeded, false); assert.equal(calls, 1)
      assert(events.some(e => e.event === "mission_finished" && e.reason === "deadline_exceeded"))
      assert(events.some(e => e.event === "attempt_finished" && e.stopReason === "deadline_exceeded"))
    }
    assert(before.equals(await readFile(join(root, "package.json"))))
    console.log(JSON.stringify({ scenario, passed: true, providerCalls: 0, scriptedModelCalls: calls, succeeded,
      observations: events.filter(e => e.event === "action_observed").length, inputUnchanged: true }))
  } catch {
    console.error(JSON.stringify({ scenario, passed: false, providerCalls: 0, scriptedModelCalls: calls,
      events: events.map(e => ({ event: e.event, ...(e.event === "attempt_finished" ? { stopReason: e.stopReason } : {}) })) }))
    process.exitCode = 1; break
  } finally { deadline.dispose() }
}
