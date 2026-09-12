#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const runner = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
const script = fileURLToPath(new URL('../packages/adapters/opencode-codex-bridge/src/stream-diagnostic.ts', import.meta.url))
const child = spawn(runner, [script, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
child.once('error', () => { console.error('Diagnostic runtime unavailable.'); process.exitCode = 2 })
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
