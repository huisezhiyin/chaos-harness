import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { main as dailyMain } from "./daily-cli.js"
import { captureGitWorkspaceArtifactState } from "./git-artifact-state.js"
import { main as v2Main, validateV2Workspace, YAML_DELIVERY_V2_ROOT } from "./yaml-687-delivery-v2-dogfood.js"

const preservedFiles = {
  "src/stringify/stringifyString.ts": "90379f0b1df89e9896336bf471c96548e29c4732edb0107686eb0c031e82f741",
  "tests/doc/comments.ts": "2860d46cf425708d05403241c89e1964f6c0a6155497b37f28b9f3c6ac0f06d4",
}

export async function assertCompanyContinuation(root: string): Promise<string> {
  await validateV2Workspace(root)
  const artifact = await captureGitWorkspaceArtifactState(root)
  if (!artifact.available || artifact.changedPathCount !== 2) throw new Error("Preserved YAML artifact changed; inspect before continuing")
  for (const [path, hash] of Object.entries(preservedFiles)) {
    const actual = createHash("sha256").update(await readFile(join(root, path))).digest("hex")
    if (actual !== hash) throw new Error("Preserved YAML artifact changed; inspect before continuing")
  }
  return root
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: {
  baseline?: typeof assertCompanyContinuation
  dailyCli?: typeof dailyMain
  stdout?: (text: string) => void
  stderr?: (text: string) => void
} = {}): Promise<number> {
  const stdout = deps.stdout ?? (text => process.stdout.write(text))
  const stderr = deps.stderr ?? (text => process.stderr.write(text))
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    stdout(`YAML #687 preserved-artifact continuation with company 高级.\nExact root: ${YAML_DELIVERY_V2_ROOT}\nOption: --check-profile (no model request).\n`)
    return 0
  }
  if (argv.length > 1 || argv.some(arg => arg !== "--check-profile")) {
    stderr("Only --check-profile is supported; no root/model overrides.\n")
    return 2
  }
  return v2Main(argv, {
    baseline: deps.baseline ?? assertCompanyContinuation, stdout, stderr,
    dailyCli: (args = [], options) => (deps.dailyCli ?? dailyMain)([
      ...args.filter(arg => arg !== "--token-switch"), "--qwen", "company",
    ], options),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code }, () => { process.exitCode = 1 })
}
