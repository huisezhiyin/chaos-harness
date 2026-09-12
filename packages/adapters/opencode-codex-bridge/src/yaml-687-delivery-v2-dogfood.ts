import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { main as dailyMain, parseChaosDailyCliArgs } from "./daily-cli.js"
import { launchOpenCodeQwen } from "./qwen.js"
import { startOpenCodeQwenLoopBridge } from "./qwen-loop-bridge.js"
import { createPrivateStreamCapture } from "./private-stream-capture.js"
import { YAML_687_ATTEMPT_BUDGET } from "./yaml-687-dogfood.js"
import { YAML_687_P81_POLICY } from "./yaml-687-p81-dogfood.js"
import { assertYamlDeliveryBaseline, assertYamlDeliveryWorkspace, createYamlDeliveryVerifier, qualifyYamlDelivery } from "./yaml-687-delivery.js"

export const YAML_DELIVERY_V2_ROOT = process.env.CHAOS_YAML_DELIVERY_V2_ROOT ?? join(homedir(), "chaos-dogfood", "yaml-687-dogfood-delivery-v2")
export const validateV2Workspace = (root: string) => assertYamlDeliveryWorkspace(root, YAML_DELIVERY_V2_ROOT)
export async function main(argv: readonly string[] = process.argv.slice(2), deps: {
  dailyCli?: typeof dailyMain
  baseline?: (root: string) => Promise<string>
  qualifier?: () => Promise<{ passed: boolean; failedChecks: readonly string[] }>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
} = {}): Promise<number> {
  const stdout = deps.stdout ?? (text => process.stdout.write(text))
  const stderr = deps.stderr ?? (text => process.stderr.write(text))
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    stdout(`YAML #687 delivery v2: ${YAML_DELIVERY_V2_ROOT}\nOptions: --qualify-only | --check-profile\nToken Switch only; private incomplete-response capture; same P8.1 policy.\n`)
    return 0
  }
  if (argv.length > 1 || argv.some(arg => !["--qualify-only", "--check-profile"].includes(arg))) {
    stderr("Only --qualify-only or --check-profile is accepted; no root/provider overrides.\n"); return 2
  }
  try {
    const args = ["--root", YAML_DELIVERY_V2_ROOT, "--token-switch"]
    parseChaosDailyCliArgs(args)
    await (deps.baseline ?? (root => assertYamlDeliveryBaseline(root, YAML_DELIVERY_V2_ROOT)))(YAML_DELIVERY_V2_ROOT)
    if (argv[0] === "--qualify-only") {
      const result = await (deps.qualifier ?? (() => qualifyYamlDelivery(YAML_DELIVERY_V2_ROOT, AbortSignal.timeout(120_000), validateV2Workspace)))()
      stdout(`YAML v2 qualification: ${result.passed ? "passed" : "failed"}\n${result.failedChecks.join("\n")}\n`)
      return result.passed ? 0 : 1
    }
    return await (deps.dailyCli ?? dailyMain)([...args, ...argv], {
      completionVerifier: createYamlDeliveryVerifier({ workspaceValidator: validateV2Workspace }),
      attemptBudget: YAML_687_ATTEMPT_BUDGET, progressPolicy: YAML_687_P81_POLICY, stdout, stderr,
      qwenLauncher: options => {
        const modelFactory = createPrivateStreamCapture({
          onCapture: path => stderr(`Incomplete model response saved privately: ${path}\n`),
          onCaptureFailure: () => stderr("Private response capture failed; the original model failure is preserved.\n"),
        })
        return launchOpenCodeQwen(options, { startBridge: bridge => startOpenCodeQwenLoopBridge({ ...bridge, modelFactory }) })
      },
    })
  } catch {
    stderr("YAML v2 preflight/qualification failed. Preserve the target; no fallback or retry.\n")
    return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code }, () => { process.exitCode = 1 })
}
