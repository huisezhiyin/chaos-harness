import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile, realpath, access, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { launchOpenCodeQwen } from "../packages/adapters/opencode-codex-bridge/src/qwen.js"
import { resolveDefaultOpenCodeCommand } from "../packages/adapters/opencode-codex-bridge/src/cli.js"
import { startOpenCodeQwenLoopBridge, type QwenLoopJournalEvent } from "../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js"
import type { ModelPort } from "../packages/kernel/src/index.js"

// Real pinned Host, deterministic in-process ModelPort, no provider or old eval target.
const exec = promisify(execFile)
const scratch = await realpath(await mkdtemp(join(tmpdir(), "chaos-native-terminal-check-")))
const root = join(scratch, "repo"), sibling = join(scratch, "outside"), witness = join(sibling, "must-not-exist")
const events: QwenLoopJournalEvent[] = []
let calls = 0, nativeErrors = 0, nativeTools = 0, automaticRejection = false
try {
  await mkdir(root); await mkdir(sibling)
  await exec("git", ["init", "--bare", join(root, ".git")])
  await exec("git", ["-C", root, "config", "core.bare", "false"])
  await writeFile(join(root, "README.md"), "Local Host observation fixture.\n")
  const model: ModelPort = { async *stream(request) {
    calls++
    if (calls === 1) {
      yield { type: "tool_call", call: { toolCallId: "native-allowed-read", name: "read", arguments: { filePath: join(root, "README.md") } } }
    } else if (calls === 2) {
      assert(request.messages.some(message => message.role === "tool" && message.content.includes("Local Host observation fixture")))
      // Fixture intentionally requests a path beyond this temporary repo to exercise native denial.
      // Host may inspect it but must not execute mkdir. No user data or real eval candidate is involved.
      yield { type: "tool_call", call: { toolCallId: "native-denied-mkdir", name: "bash", arguments: {
        workdir: root, command: `mkdir '${witness.replaceAll("'", "'\\''")}'`, description: "Controlled permission refusal fixture",
      } } }
    } else throw new Error("A native permission refusal must not resume the model")
    yield { type: "finish", reason: "tool_calls" }
  } }
  const code = await launchOpenCodeQwen({ root, opencodeCommand: resolveDefaultOpenCodeCommand(), workspaceBoundary: "root-only",
    profile: { apiKey: "local-fixture-only", model: "scripted-local", baseUrl: "http://127.0.0.1:1/unused" },
    recordEvent: async e => { events.push(e) },
  }, {
    startBridge: options => startOpenCodeQwenLoopBridge({ ...options, modelFactory: () => model }),
    runTui: async input => {
      const running = exec(input.command, ["run", "--dir", root, "--agent", "build", "--model", "chaos-qwen/code-agent",
        "--format", "json", "Read README and summarize. Do not modify repository files."],
      { cwd: root, env: { ...input.env, PWD: root }, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })
      running.child.stdin?.end()
      const { stdout, stderr } = await running
      // Inspect in memory; never print raw Host text, paths or payloads.
      automaticRejection = (stdout + stderr).includes("auto-rejecting")
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line)
          if (event.type !== "tool_use") continue
          nativeTools++
          if (event.part?.state?.status === "error") nativeErrors++
        } catch { /* CLI also writes a non-JSON permission notice */ }
      }
      return 0
    },
  })
  assert.equal(code, 0)
  assert.equal(calls, 2)
  assert.equal(nativeTools, 2); assert.equal(nativeErrors, 1)
  assert.equal(automaticRejection, true)
  assert.equal(events.filter(e => e.event === "action_observed").length, 1)
  const terminal = events.filter(e => e.event === "host_terminal_observation_received")
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]?.hostTerminalError, "host_permission_rejected")
  assert.equal(events.filter(e => e.event === "attempt_started").length, 1)
  assert(events.some(e => e.event === "mission_finished" && e.outcome === "cancelled" && e.reason === "host_exit"))
  await assert.rejects(access(witness))
  assert(!JSON.stringify(events).includes(scratch))
  console.log(JSON.stringify({ passed: true, providerCalls: 0, scriptedModelCalls: calls, nativeTools, nativeErrors,
    automaticRejection, loopObservations: 1, authenticatedTerminalErrors: 1, deniedCommandExecuted: false, resumedAfterDenial: false }))
} catch {
  console.error(JSON.stringify({ passed: false, providerCalls: 0, scriptedModelCalls: calls, nativeTools, nativeErrors,
    automaticRejection, authenticatedTerminalErrors: events.filter(e => e.event === "host_terminal_observation_received").length }))
  process.exitCode = 1
} finally { await rm(scratch, { recursive: true, force: true }) }
