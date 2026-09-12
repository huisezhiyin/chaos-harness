import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { launchOpenCodeQwen } from "../packages/adapters/opencode-codex-bridge/src/qwen.js"
import { loadTokenSwitchProfile } from "../packages/adapters/opencode-codex-bridge/src/token-switch-profile.js"
import { startOpenCodeQwenLoopBridge } from "../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js"
import { createProfileChatModel } from "../packages/adapters/opencode-codex-bridge/src/model-profiles.js"
import { IncompleteChatStreamError } from "../packages/adapters/deepseek/src/index.js"
import { verifyOpenCodeHostProfile } from "../packages/adapters/opencode-codex-bridge/src/opencode-host-profile.js"
import type { ModelPort } from "../packages/kernel/src/index.js"

const root = process.env.CHAOS_STREAM_DIAGNOSTIC_ROOT ?? join(homedir(), "chaos-dogfood", "yaml-687-stream-smoke")
const exec = promisify(execFile)
const hostArgs = (prompt: string) => ["run", "--dir", root, "--format", "json", "--model", "chaos-qwen/code-agent", "--title", "Chaos stream diagnostic", prompt]
const shouldHalt = (event: { event: string; ok?: boolean }) =>
  event.event === "mission_finished" || (event.event === "action_observed" && event.ok === false)
const redact = (text: string, key: string) => text.replaceAll(key, "[REDACTED]")
  .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
  .replace(/https?:\/\/[^\s"<>]+/g, "[endpoint]")

if (process.argv[2] === "--self-check") {
  assert.equal(redact("keysecret Bearer abcd https://private.invalid", "keysecret"), "[REDACTED] Bearer [REDACTED] [endpoint]")
  assert.equal(resolve(root, "../README.md").startsWith(`${root}/`), false)
  assert.equal(hostArgs("test")[2], root)
  assert.equal(shouldHalt({ event: "action_observed", ok: false }), true)
  assert.equal(shouldHalt({ event: "action_observed", ok: true }), false)
  console.log("capture runner self-check passed; no provider loaded")
} else if (["--run-once", "--pool-check", "--company-check", "--host-check", "--host-failure-check"].includes(process.argv[2] ?? "") && process.argv.length === 3) {
  const companyCheck = process.argv[2] === "--company-check"
  const poolCheck = process.argv[2] === "--pool-check" || companyCheck
  const hostCheck = process.argv[2] === "--host-check" || process.argv[2] === "--host-failure-check"
  const requestLimit = poolCheck ? 2 : 4
  const failureCheck = process.argv[2] === "--host-failure-check"
  const { stdout: head } = await exec("git", ["-C", root, "rev-parse", "HEAD"])
  const { stdout: status } = await exec("git", ["-C", root, "status", "--porcelain"])
  assert.equal(head.trim(), "b91c3747333c7379bfd6edb6000fa163ca33805b")
  assert.equal(status, "")
  const state = join(homedir(), ".local/state/chaos-harness/diagnostics")
  await mkdir(state, { recursive: true, mode: 0o700 })
  // Explicitly one authorization, including unsuccessful reproduction.
  if (!hostCheck) await writeFile(join(state, companyCheck ? "20260904-company-advanced-check.used" : poolCheck ? "20260904-shared-pool-recheck.used" : "20260904-owner-stream-probe-v2.used"), new Date().toISOString(), { flag: "wx", mode: 0o600 })
  const output = await mkdtemp(join(state, "stream-probe-"))
  const profile = hostCheck ? { apiKey: "unused-local-fixture", model: "local-fixture", baseUrl: "http://127.0.0.1:1" } : await loadTokenSwitchProfile(undefined, companyCheck ? "company" : "dogfood", companyCheck ? "高级" : "Qwen3.8-Max-DogFooding")
  let requests = 0, halted = false, captured = false, missionFinished = false, toolFailures = 0, drivers = 0
  const allowedFiles = new Set((poolCheck ? ["README.md"] : ["README.md", "package.json", "vitest.config.js"]).map(p => resolve(root, p)))
  if (failureCheck) allowedFiles.add(resolve(root, "diagnostic-deliberately-missing.txt"))
  let successfulReads = 0
  const fixture: ModelPort = { async *stream(request) {
    const files = failureCheck ? ["diagnostic-deliberately-missing.txt"] : ["README.md", "package.json", "vitest.config.js"]
    const markers = ["human friendly data serialization standard", "eemeli/yaml", "Testing build output from dist/"]
    if (request.turn > 1) assert.ok(JSON.stringify(request.messages).includes(markers[request.turn - 2]!))
    if (request.turn <= files.length) yield { type: "tool_call", call: { toolCallId: `fixture-${request.turn}`, name: "read", arguments: { filePath: resolve(root, files[request.turn - 1]!) } } }
    else yield { type: "text_delta", delta: "Three YAML files inspected read-only." }
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cost: 0 } }
    yield { type: "finish", reason: request.turn <= files.length ? "tool_calls" : "stop" }
  } }
  const prompt = poolCheck ? "只读使用 Read 读取 README.md，然后用一句中文说明项目用途。不修改文件，不运行命令，不调用其他工具。" : await readFile(new URL("../mydocs/prompts/dogfood-stream-smoke.txt", import.meta.url), "utf8")
  let exitCode: number | undefined
  let runnerFailed = false
  try {
    exitCode = await launchOpenCodeQwen({ root, profile, opencodeCommand: join(homedir(), ".opencode/bin/opencode"),
      attemptBudget: { maxTurns: 4, maxActions: 3 },
      recordEvent: async event => {
        if (event.event === "mission_finished") missionFinished = true
        if (event.event === "action_observed" && event.ok === false) toolFailures++
        if (event.event === "action_observed" && event.ok === true) successfulReads++
        if (shouldHalt(event)) halted = true
        await appendFile(join(output, "lifecycle.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 })
      },
    }, {
      startBridge: options => startOpenCodeQwenLoopBridge({ ...options, modelFactory: selected => {
        if (++drivers > 1) { halted = true; throw new Error("Diagnostic recovery disabled") }
        const delegate = hostCheck ? fixture : createProfileChatModel(selected)
        return { async *stream(request, signal) {
          if (halted || requests >= requestLimit) throw new Error("Diagnostic request boundary reached")
          requests++
          let text = ""
          try {
            for await (const event of delegate.stream(request, AbortSignal.any([signal, AbortSignal.timeout(45_000)]))) {
              if (event.type === "text_delta") text = (text + event.delta).slice(0, 32_768)
              if (event.type === "tool_call") {
                const file = event.call.arguments.filePath
                if (event.call.name !== "read" || typeof file !== "string" || !allowedFiles.has(resolve(root, file))) {
                  throw new Error("Diagnostic tool boundary reached")
                }
              }
              yield event
            }
          } catch (error) {
            halted = true
            if (error instanceof IncompleteChatStreamError) {
              await writeFile(join(output, "incomplete-response.json"), JSON.stringify({
                stream: error.diagnostics, text: redact(text, selected.apiKey),
              }, null, 2), { flag: "wx", mode: 0o600 })
              captured = true
            }
            throw error
          }
        } }
      } }),
      runTui: async input => {
        const config = JSON.parse(input.env.OPENCODE_CONFIG_CONTENT!)
        config.permission = { "*": "deny", read: "allow", external_directory: "deny" }
        const env = { ...input.env, PWD: root, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
        await verifyOpenCodeHostProfile({ command: input.command, root, env, observationPlugin: config.plugin[0] })
        const running = exec(input.command, hostArgs(prompt),
          { cwd: root, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
        running.child.stdin?.end()
        try { await running; return 0 } catch { return 1 }
      },
    })
  } catch { runnerFailed = true }
  const { stdout: after } = await exec("git", ["-C", root, "status", "--porcelain"])
  const summary = { hostCheck, source: companyCheck ? "company-advanced" : "dogfood", requests, captured, missionFinished, successfulReads, toolFailures, exitCode, runnerFailed, workspaceUnchanged: after === status }
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ...summary, privateEvidenceDirectory: output }))
  if (hostCheck) {
    assert.equal(runnerFailed, false)
    assert.equal(after, status)
    assert.equal(requests, failureCheck ? 1 : 4)
    assert.equal(successfulReads, failureCheck ? 0 : 3)
    assert.equal(toolFailures, failureCheck ? 1 : 0)
    assert.equal(missionFinished, true)
  }
} else {
  console.error("Use --self-check or the explicitly authorized --run-once")
  process.exitCode = 2
}
