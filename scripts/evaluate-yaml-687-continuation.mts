import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { launchOpenCodeQwen } from "../packages/adapters/opencode-codex-bridge/src/qwen.js"
import { startOpenCodeQwenLoopBridge } from "../packages/adapters/opencode-codex-bridge/src/qwen-loop-bridge.js"
import { createPrivateStreamCapture } from "../packages/adapters/opencode-codex-bridge/src/private-stream-capture.js"
import { loadTokenSwitchProfile } from "../packages/adapters/opencode-codex-bridge/src/token-switch-profile.js"
import { YAML_DELIVERY_V2_ROOT as root, validateV2Workspace } from "../packages/adapters/opencode-codex-bridge/src/yaml-687-delivery-v2-dogfood.js"
import { createYamlDeliveryVerifier } from "../packages/adapters/opencode-codex-bridge/src/yaml-687-delivery.js"
import { captureGitWorkspaceArtifactState } from "../packages/adapters/opencode-codex-bridge/src/git-artifact-state.js"
import { YAML_687_ATTEMPT_BUDGET } from "../packages/adapters/opencode-codex-bridge/src/yaml-687-dogfood.js"
import { YAML_687_P81_POLICY } from "../packages/adapters/opencode-codex-bridge/src/yaml-687-p81-dogfood.js"

const exec = promisify(execFile)
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const expected = {
  "src/stringify/stringifyString.ts": "90379f0b1df89e9896336bf471c96548e29c4732edb0107686eb0c031e82f741",
  "tests/doc/comments.ts": "2860d46cf425708d05403241c89e1964f6c0a6155497b37f28b9f3c6ac0f06d4",
}
const mode = process.argv[2]
assert.ok(process.argv.length === 3 && ["--check", "--run-once"].includes(mode ?? ""))
await validateV2Workspace(root)
const before = await captureGitWorkspaceArtifactState(root)
assert.ok(before.available && before.changedPathCount === 2)
for (const [path, digest] of Object.entries(expected)) assert.equal(sha(await readFile(join(root, path))), digest)
const { stdout: status } = await exec("git", ["-C", root, "status", "--porcelain"])
assert.equal(status, " M src/stringify/stringifyString.ts\n M tests/doc/comments.ts\n")
const prompt = await readFile(new URL("../mydocs/prompts/yaml-687-delivery-v2-continue.txt", import.meta.url), "utf8")
if (mode === "--check") {
  console.log("Continuation preflight passed: exact preserved artifact and pinned workspace; no provider loaded.")
} else {
  const state = join(homedir(), ".local/state/chaos-harness/diagnostics")
  await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(join(state, "20260904-yaml-v2-continuation.used"), new Date().toISOString(), { flag: "wx", mode: 0o600 })
  const output = await mkdtemp(join(state, "yaml-v2-continuation-"))
  await writeFile(join(output, "admission.json"), JSON.stringify({ before, fileHashes: expected, promptSha256: sha(prompt), runnerSha256: sha(await readFile(new URL(import.meta.url))), startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  const profile = await loadTokenSwitchProfile()
  let attempts = 0, observed = 0, failedTools = 0, missionOutcome: string | undefined, exitCode: number | undefined, runnerFailed = false
  const modelFactory = createPrivateStreamCapture({ onCapture: path => console.log(JSON.stringify({ privateCapture: path })) })
  console.log(JSON.stringify({ privateEvidenceDirectory: output, started: true }))
  try {
    exitCode = await launchOpenCodeQwen({ root, profile, opencodeCommand: join(homedir(), ".opencode/bin/opencode"),
      attemptBudget: YAML_687_ATTEMPT_BUDGET, progressPolicy: YAML_687_P81_POLICY,
      completionVerifier: createYamlDeliveryVerifier({ workspaceValidator: validateV2Workspace }),
      recordEvent: async event => {
        await appendFile(join(output, "lifecycle.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 })
        if (event.event === "attempt_started") attempts++
        if (event.event === "action_observed") { observed++; if (!event.ok) failedTools++ }
        if (event.event === "mission_finished") missionOutcome = event.outcome
        if (["attempt_started", "attempt_finished", "verification_completed", "mission_finished"].includes(event.event)) {
          console.log(JSON.stringify({ event: event.event, attempts, observed, failedTools, missionOutcome }))
        }
      },
    }, {
      startBridge: options => startOpenCodeQwenLoopBridge({ ...options, modelFactory }),
      runTui: async input => {
        const running = exec(input.command, ["run", "--dir", root, "--agent", "build", "--format", "json", "--model", "chaos-qwen/code-agent", "--title", "YAML 687 preserved-artifact continuation", prompt],
          { cwd: root, env: { ...input.env, PWD: root }, timeout: 900_000, maxBuffer: 8 * 1024 * 1024 })
        running.child.stdin?.end()
        try { await running; return 0 } catch { return 1 }
      },
    })
  } catch { runnerFailed = true }
  const after = await captureGitWorkspaceArtifactState(root)
  const summary = { attempts, observed, failedTools, missionOutcome, exitCode, runnerFailed, before, after, finishedAt: new Date().toISOString() }
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ attempts, observed, failedTools, missionOutcome, exitCode, runnerFailed }))
}
