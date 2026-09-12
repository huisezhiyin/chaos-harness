import { pathToFileURL } from "node:url"
import { main as dailyMain, parseChaosDailyCliArgs } from "./daily-cli.js"
import { YAML_687_ATTEMPT_BUDGET } from "./yaml-687-dogfood.js"
import { YAML_687_P81_POLICY } from "./yaml-687-p81-dogfood.js"
import { YAML_DELIVERY_ROOT, assertYamlDeliveryBaseline, createYamlDeliveryVerifier, qualifyYamlDelivery } from "./yaml-687-delivery.js"
import type { QwenCompletionVerifier } from "./qwen-loop-bridge.js"

export async function main(argv: readonly string[] = process.argv.slice(2), deps: {
  dailyCli?: typeof dailyMain
  workspaceValidator?: typeof assertYamlDeliveryBaseline
  qualifier?: typeof qualifyYamlDelivery
  verifier?: QwenCompletionVerifier
  stdout?: (text: string) => void
  stderr?: (text: string) => void
} = {}): Promise<number> {
  const stdout = deps.stdout ?? (text => process.stdout.write(text))
  const stderr = deps.stderr ?? (text => process.stderr.write(text))
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(`Usage: node bin/chaos-yaml-687-delivery.mjs [--qualify-only | --check-profile]\nExact root: ${YAML_DELIVERY_ROOT}\nKnown-case delivery regression, not a resume or blind benchmark. Token Switch DogFooding only.\nP8.1: 18 turns / 24 actions + 4 turns / 6 actions read-only closure, at most one recovery.\n--qualify-only checks source and delivery fixtures without loading a provider.\n`)
    return 0
  }
  if (argv.some(arg => arg !== "--qualify-only" && arg !== "--check-profile") || argv.length > 1) {
    stderr("Only --qualify-only or --check-profile is accepted; root/provider/policy overrides are not allowed.\n")
    return 2
  }
  try {
    const args = ["--root", YAML_DELIVERY_ROOT, "--token-switch"]
    // Reject conflicting inherited selections before any provider loading or dispatch.
    parseChaosDailyCliArgs(args)
    await (deps.workspaceValidator ?? assertYamlDeliveryBaseline)(YAML_DELIVERY_ROOT)
    if (argv.includes("--qualify-only")) {
      const result = await (deps.qualifier ?? qualifyYamlDelivery)(YAML_DELIVERY_ROOT, AbortSignal.timeout(120_000))
      stdout(`YAML DogFooding delivery qualification: ${result.passed ? "passed" : "failed"}\n${result.failedChecks.join("\n")}\n`)
      return result.passed ? 0 : 1
    }
    return await (deps.dailyCli ?? dailyMain)([...args, ...argv], {
      completionVerifier: deps.verifier ?? createYamlDeliveryVerifier(),
      attemptBudget: YAML_687_ATTEMPT_BUDGET, progressPolicy: YAML_687_P81_POLICY, stdout, stderr,
    })
  } catch {
    stderr("YAML delivery preflight/qualification failed; no alternate provider was selected.\n")
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code }, () => { process.exitCode = 1 })
}
