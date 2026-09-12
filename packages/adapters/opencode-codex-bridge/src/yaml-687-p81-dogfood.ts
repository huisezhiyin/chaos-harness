import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { main as dailyMain } from "./daily-cli.js"
import { main as originalMain, YAML_687_PROGRESS_POLICY } from "./yaml-687-dogfood.js"
import { YAML_687_ROOT, assertYaml687Workspace, validateYaml687Identity,
  createYaml687Verifier, qualifyYaml687Verifier } from "./yaml-687-verifier.js"

export const YAML_687_P81_ROOT = process.env.CHAOS_YAML_687_P81_ROOT ?? join(homedir(), "chaos-dogfood", "yaml-687-p81")
export const YAML_687_P81_POLICY = Object.freeze({ ...YAML_687_PROGRESS_POLICY, investigationExtensionActions: 4 })

export function validateYaml687P81Identity(identity: Parameters<typeof validateYaml687Identity>[0]): void {
  if (identity.root !== YAML_687_P81_ROOT || identity.gitRoot !== YAML_687_P81_ROOT) {
    throw new TypeError("YAML #687 P8.1 requires its independent exact root")
  }
  // Reuse the original SHA/origin checks only after checking the independent root.
  validateYaml687Identity({ ...identity, root: YAML_687_ROOT, gitRoot: YAML_687_ROOT })
}

export function assertYaml687P81Workspace(input: string): Promise<string> {
  return assertYaml687Workspace(input, validateYaml687P81Identity)
}

export function qualifyYaml687P81Verifier(root: string, signal: AbortSignal) {
  return qualifyYaml687Verifier(root, signal, assertYaml687P81Workspace)
}

export async function main(argv: readonly string[] = process.argv.slice(2),
  dependencies: NonNullable<Parameters<typeof originalMain>[1]> = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    (dependencies.stdout ?? (text => process.stdout.write(text)))([
      "Usage: ./bin/chaos-yaml-687-p81.mjs --root <independent-fixed-sha-root> [--qualify-only]",
      `Exact root: ${YAML_687_P81_ROOT}`,
      "Independent P8.1 experiment, not a resume of Episode 5. Model: qwen3.8-max.",
      "P8 soft 10 / grace 4 + at most one 4-action investigation extension; repeat pair 4 / error 3.",
      "Unchanged budget: 18 work turns / 24 actions, read-only closure 4 turns / 6 actions, at most one recovery.",
      "--qualify-only never loads a provider or starts a TUI. No bypass of original pending Unit.",
      "",
    ].join("\n"))
    return 0
  }
  const dailyCli = dependencies.dailyCli ?? dailyMain
  return originalMain(argv, {
    ...dependencies,
    workspaceValidator: dependencies.workspaceValidator ?? assertYaml687P81Workspace,
    qualifier: dependencies.qualifier ?? qualifyYaml687P81Verifier,
    verifier: dependencies.verifier ?? createYaml687Verifier({ workspaceValidator: assertYaml687P81Workspace }),
    dailyCli: (args, options) => dailyCli(args, { ...options, progressPolicy: YAML_687_P81_POLICY }),
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code }, () => { process.exitCode = 1 })
}
