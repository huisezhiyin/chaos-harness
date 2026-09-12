import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

type Scenario = "benign" | "fatal-hung-flush"

const args = parseArgs(process.argv.slice(2))
const root = await realpath(args.root)

// Block transport before importing any target module. The verifier checks only
// local process behavior and must never send PostHog or other network traffic.
globalThis.fetch = (() => new Promise<never>(() => undefined)) as typeof fetch

const debugModule = await importTarget(root, "src/utils/debug.ts") as {
  configureLogFile(options: { enabled: boolean }): void
}
const uncaughtModule = await importTarget(root, "src/lib/errors/uncaught.ts") as {
  installUncaughtExceptionHandler(): void
}
debugModule.configureLogFile({ enabled: false })
uncaughtModule.installUncaughtExceptionHandler()

if (args.scenario === "benign") {
  setTimeout(() => process.stdout.write("CHAOS_PROBE_ALIVE\n"), 1_200)
  setTimeout(() => {
    const error = new Error("socket idle timeout")
    error.name = "InformationalError"
    throw error
  }, 100).unref()
} else {
  const analyticsModule = await importTarget(root, "src/utils/analytics.ts") as {
    analytics: { flush(): Promise<void> }
  }
  analyticsModule.analytics.flush = () => new Promise<void>(() => undefined)
  setImmediate(() => {
    throw new Error("genuine fatal boom")
  })
}

function importTarget(rootPath: string, relativePath: string): Promise<unknown> {
  return import(pathToFileURL(join(rootPath, relativePath)).href)
}

function parseArgs(argv: readonly string[]): { root: string; scenario: Scenario } {
  let root: string | undefined
  let scenario: Scenario | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new TypeError(`Missing value for ${String(flag)}`)
    if (flag === "--root") root = value
    else if (flag === "--scenario" && (value === "benign" || value === "fatal-hung-flush")) {
      scenario = value
    } else {
      throw new TypeError(`Invalid PostHog #1198 probe option: ${String(flag)}`)
    }
  }
  if (root === undefined || scenario === undefined) {
    throw new TypeError("PostHog #1198 probe requires --root and --scenario")
  }
  return { root, scenario }
}
