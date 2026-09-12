#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const child = spawn(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
  [fileURLToPath(new URL('../evals/csv-stringify-476-v4/cli.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' })
child.once('error', () => { console.error('Real task runtime unavailable'); process.exitCode = 2 })
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
