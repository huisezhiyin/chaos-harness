#!/usr/bin/env node
import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx")
const bun = join(homedir(), ".bun", "bin", "bun")
const entry = join(
  repositoryRoot,
  "packages",
  "adapters",
  "opencode-codex-bridge",
  "src",
  "jsx-a11y-954-dogfood.ts",
)

const runner = isExecutable(tsx) ? tsx : (isExecutable(bun) ? bun : undefined)
if (runner === undefined) {
  process.stderr.write(
    `Chaos Harness dependencies are missing. Run: pnpm --dir ${repositoryRoot} install --frozen-lockfile\n`,
  )
  process.exitCode = 1
  process.exit()
}

const child = spawn(runner, [entry, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
})

child.once("error", (error) => {
  process.stderr.write(`Unable to start the jsx-a11y #954 dogfood launcher: ${error.message}\n`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1
})

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
