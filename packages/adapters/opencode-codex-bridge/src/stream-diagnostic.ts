import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { ModelProtocolError, type ModelPort, type ModelStreamEvent } from "../../../kernel/src/index.js"
import { resolveDefaultOpenCodeCommand } from "./cli.js"
import { summarizeModelFailure, type ModelFailureSummary } from "./model-failure.js"
import { createProfileChatModel } from "./model-profiles.js"
import { verifyOpenCodeHostProfile } from "./opencode-host-profile.js"
import { createPrivateStreamCapture, ModelSessionStoppedError } from "./private-stream-capture.js"
import { startOpenCodeQwenLoopBridge } from "./qwen-loop-bridge.js"
import { launchOpenCodeQwen, loadQwenProfile, DEFAULT_DASHSCOPE_BASE_URL, type QwenProfile } from "./qwen.js"
import { DEFAULT_QWEN_ENV_FILE } from "./daily-cli.js"
import { loadTokenSwitchProfile } from "./token-switch-profile.js"

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
export const DIAGNOSTIC_LIMITS = { requests: 3, reads: 1, milliseconds: 120_000 } as const
type Scenario = "success" | "missing_finish" | "upstream_error"
export interface DiagnosticState {
  requests: number
  completeStreams: number
  releasedReads: number
  observedReads: number
  stopped: boolean
  failure?: ModelFailureSummary
}
export const newDiagnosticState = (): DiagnosticState => ({ requests: 0, completeStreams: 0,
  releasedReads: 0, observedReads: 0, stopped: false })

/** Bound all requests/drivers together, and validate a whole turn before releasing tools. */
export function guardDiagnosticModel(model: ModelPort, state: DiagnosticState, root: string,
  deadline: AbortSignal): ModelPort {
  return { async *stream(request, signal) {
    if (state.stopped) throw new ModelSessionStoppedError()
    const combined = AbortSignal.any([signal, deadline])
    const deferred: ModelStreamEvent[] = []
    try {
      combined.throwIfAborted()
      if (state.requests >= DIAGNOSTIC_LIMITS.requests) throw new ModelProtocolError("Diagnostic request limit")
      state.requests++
      for await (const event of model.stream({ ...request, tools: request.tools.filter(t => t.name === "read") }, combined)) {
        if (event.type === "text_delta" || event.type === "reasoning_delta") yield event
        else deferred.push(event)
      }
      combined.throwIfAborted()
      const calls = deferred.filter(event => event.type === "tool_call")
      if (calls.length + state.releasedReads > DIAGNOSTIC_LIMITS.reads) throw new ModelProtocolError("Diagnostic read limit")
      for (const event of calls) {
        const path = event.call.arguments.filePath
        if (event.call.name !== "read" || typeof path !== "string" ||
            resolve(root, path) !== join(root, "package.json") ||
            await realpath(resolve(root, path)) !== join(root, "package.json")) {
          throw new ModelProtocolError("Diagnostic tool boundary")
        }
      }
      if (!deferred.some(e => e.type === "usage") || !deferred.some(e => e.type === "finish")) {
        throw new ModelProtocolError("Diagnostic incomplete response")
      }
      state.releasedReads += calls.length
      state.completeStreams++
      yield* deferred
    } catch (error) {
      state.stopped = true
      state.failure ??= summarizeModelFailure(error)
      throw error
    }
  } }
}

export function diagnosticEnvironment(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}")
  config.permission = { "*": "deny", read: { "*": "deny", "package.json": "allow", [join(root, "package.json")]: "allow" } }
  return { ...env, PWD: root, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
}

export function diagnosticArgs(root: string): string[] {
  return ["run", "--dir", root, "--agent", "build", "--model", "chaos-qwen/code-agent", "--format", "json",
    "--title", "Chaos stream diagnostic",
    "Read-only diagnostic: use the read tool exactly once to read package.json in the current workspace. " +
    "Then reply with only the value of its name property. Do not modify files or use any other tool."]
}

function fakeFetch(scenario: Scenario, root: string, source: "company" | "personal"): typeof fetch {
  let calls = 0
  return async (_input, init) => {
    const headers = new Headers(init?.headers)
    if (source === "company" && (!headers.get("user-agent") || headers.get("via") !== "1.1 chaos-harness")) {
      throw new Error("Diagnostic Host identity forwarding failed")
    }
    calls++
    const delta = calls === 1 ? { tool_calls: [{ index: 0, id: "diagnostic-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ filePath: join(root, "package.json") }) } }] } : { content: "chaos-harness" }
    const chunk = scenario === "upstream_error" ? { error: { code: "fixture_error", message: "fixture only" } }
      : { choices: [{ index: 0, delta, finish_reason: scenario === "missing_finish" ? null : calls === 1 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
}

async function runtimeDigest(root: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, "ls-files", "-c", "-o", "--exclude-standard", "-z", "--",
    "packages", "bin", "package.json", "tsconfig.json", "pnpm-lock.yaml", ":(exclude)**/node_modules/**"],
  { timeout: 5_000, maxBuffer: 1024 * 1024 })
  const paths = [...new Set(stdout.split("\0").filter(p => /\.(?:ts|js|mjs|json|yaml)$/.test(p)))].sort()
  const hash = createHash("sha256")
  for (const path of paths) {
    const full = join(root, path)
    if (!(await lstat(full)).isFile()) throw new Error("Unexpected runtime file")
    hash.update(path).update("\0").update(await readFile(full)).update("\0")
  }
  return hash.digest("hex")
}

export function assertDirectPersonalProfile(profile: QwenProfile): QwenProfile {
  if (profile.baseUrl !== DEFAULT_DASHSCOPE_BASE_URL) throw new Error("Personal diagnostic requires the direct DashScope endpoint")
  return profile
}

export async function runDiagnostic(mode: "check" | "run", scenario: Scenario = "success", source: "company" | "personal" = "company") {
  const root = await realpath(ROOT), file = join(root, "package.json")
  if ((await lstat(file)).isSymbolicLink()) throw new Error("Diagnostic input must not be a symlink")
  const before = await readFile(file), expected = JSON.parse(before.toString()).name as string
  const runtimeSha256 = await runtimeDigest(root)
  const parent = join(homedir(), ".local/state/chaos-harness/stream-check")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe diagnostic directory")
  const directory = await mkdtemp(join(parent, mode === "check" ? `model-free-${source}-` : `${source}-`))
  await writeFile(join(directory, "started.json"), JSON.stringify({ mode, source, scenario: mode === "check" ? scenario : undefined,
    startedAt: new Date().toISOString(), limits: DIAGNOSTIC_LIMITS,
    runtimeSha256 }), { flag: "wx", mode: 0o600 })
  const state = newDiagnosticState(), deadline = AbortSignal.timeout(DIAGNOSTIC_LIMITS.milliseconds)
  const deadlineAt = Date.now() + DIAGNOSTIC_LIMITS.milliseconds
  let factories = 0, attempts = 0, failedTools = 0, nativeErrors = 0, nativeReads = 0, nativeInvalid = false
  let missionOutcome: string | undefined, exitCode = 1, finalMatches = false, captured = false
  let hostFailure = false, captureFailed = false, permissionRejections = 0
  const capture = createPrivateStreamCapture({ parent: directory,
    onCapture: () => { captured = true }, onCaptureFailure: () => { captureFailed = true },
    modelFactory: profile => {
      if (++factories > 1) { state.stopped = true; throw new ModelSessionStoppedError() }
      return guardDiagnosticModel(createProfileChatModel(profile, mode === "check" ? fakeFetch(scenario, root, source) : undefined), state, root, deadline)
    },
  })
  try {
    const profile: QwenProfile = mode === "check"
      ? { apiKey: "fixture-secret", baseUrl: "http://127.0.0.1:1/v1", model: "fixture", preserveHostUserAgent: source === "company" }
      : source === "personal"
        ? assertDirectPersonalProfile(await loadQwenProfile({ envFilePath: DEFAULT_QWEN_ENV_FILE }))
        : await loadTokenSwitchProfile(undefined, "company", "高级")
    exitCode = await launchOpenCodeQwen({ root, profile, opencodeCommand: resolveDefaultOpenCodeCommand(),
      attemptBudget: { maxTurns: 3, maxActions: 2 }, workspaceBoundary: "root-only",
      recordEvent: async event => {
        if (event.event === "attempt_started") { attempts++; if (attempts > 1) state.stopped = true }
        if (event.event === "action_observed") {
          if (event.ok && event.action === "read") state.observedReads++
          else { failedTools++; state.stopped = true }
        }
        if (event.event === "attempt_finished" && event.modelFailure) state.failure ??= event.modelFailure
        if (event.event === "mission_finished") missionOutcome = event.outcome
      },
      completionVerifier: { id: "bounded-stream-read", verify: async context => {
        const passed = state.observedReads === 1 && !state.stopped && context.completion.trim() === expected
        if (!passed) state.stopped = true
        return { passed }
      } },
    }, {
      startBridge: options => startOpenCodeQwenLoopBridge({ ...options, modelFactory: capture }),
      verifyHostProfile: input => verifyOpenCodeHostProfile({ ...input, env: diagnosticEnvironment(input.env, root) }),
      runTui: async input => {
        const running = exec(input.command, diagnosticArgs(root), { cwd: root, env: diagnosticEnvironment(input.env, root),
          timeout: Math.max(1, deadlineAt - Date.now()), signal: deadline, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 })
        running.child.stdin?.end()
        let stdout = "", code = 0
        try { stdout = (await running).stdout } catch (error) {
          code = 1; stdout = String((error as { stdout?: string }).stdout ?? "")
        }
        const calls = new Set<string>(), texts: string[] = []
        for (const line of stdout.split("\n").filter(line => line.trim())) {
          let event
          try { event = JSON.parse(line) } catch { nativeInvalid = true; continue }
          if (event.type === "error") nativeErrors++
          if (event.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text)
          if (event.type === "tool_use") {
            const p = event.part
            if (p?.state?.status === "error" && /permission|rejected/i.test(String(p.state.error))) permissionRejections++
            if (p?.tool !== "read" || p.state?.status !== "completed" || typeof p.state.input?.filePath !== "string" ||
                resolve(root, p.state.input.filePath) !== file || typeof p.callID !== "string") nativeInvalid = true
            else calls.add(p.callID)
          }
        }
        nativeReads = calls.size
        finalMatches = texts.join("\n").trim() === expected
        return code
      },
    })
  } catch { hostFailure = true }
  const unchanged = before.equals(await readFile(file))
  const runtimeUnchanged = runtimeSha256 === await runtimeDigest(root)
  const passed = !hostFailure && !state.stopped && !state.failure && !captureFailed && exitCode === 0 &&
    attempts === 1 && missionOutcome === "succeeded" && state.observedReads === 1 && state.releasedReads === 1 &&
    nativeReads === 1 && !nativeInvalid && !nativeErrors && !failedTools && finalMatches && unchanged &&
    state.requests === state.completeStreams && runtimeUnchanged
  const result = { mode, source: mode === "run" ? source : "fixture", route: source, passed, ...state,
    attempts, failedTools, nativeReads, nativeErrors, nativeInvalid, missionOutcome, exitCode, finalMatches, unchanged,
    hostFailure, captured, captureFailed, permissionRejections, runtimeSha256, runtimeUnchanged }
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 })
  return { ...result, directory }
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log("Usage: node bin/chaos-stream-check.mjs check|run [--personal]\ncheck: real local Host + fake SSE; no provider.\nrun: company 高级 by default, --personal selects direct DashScope; at most 3 model requests, 1 package.json Read, 120 seconds. Requires live authorization.")
    return 0
  }
  if (args.length < 1 || args.length > 2 || !["check", "run"].includes(args[0]!) || (args.length === 2 && args[1] !== "--personal")) throw new Error("Choose check or run; no other arguments except --personal")
  const source = args[1] === "--personal" ? "personal" : "company"
  if (args[0] === "run") { const result = await runDiagnostic("run", "success", source); console.log(JSON.stringify(result)); return result.passed ? 0 : 1 }
  for (const scenario of ["success", "missing_finish", "upstream_error"] as const) {
    const result = await runDiagnostic("check", scenario, source)
    const verified = scenario === "success" ? result.passed : !result.passed && result.failure?.code === scenario &&
      result.requests === 1 && result.releasedReads === 0 && result.observedReads === 0 && result.captured && !result.captureFailed && result.unchanged
    console.log(JSON.stringify({ scenario, verified, ...result }))
    if (!verified) return 1
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, () => {
    console.error("Stream diagnostic failed; preserve its private evidence. No fallback or retry."); process.exitCode = 2
  })
}
