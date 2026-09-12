#!/usr/bin/env node
import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [join(root, "node_modules/.bin/tsx"), join(homedir(), ".bun/bin/bun")]
const runner = candidates.find(path => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
})
if (!runner) {
  process.stderr.write("Chaos Harness dependencies are missing; prepare the Harness workspace first.\n")
  process.exitCode = 1
} else {
  const child = spawn(runner, [join(root, "packages/adapters/opencode-codex-bridge/src/yaml-687-delivery-dogfood.ts"), ...process.argv.slice(2)], {
    env: process.env, stdio: "inherit",
  })
  child.once("error", error => {
    process.stderr.write(`Unable to start the YAML DogFooding delivery launcher: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => { process.exitCode = signal === null ? (code ?? 1) : 1 })
}
