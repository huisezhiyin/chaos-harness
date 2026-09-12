import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { AppServerProcess } from "../src/client.js"

export class FakeAppServerProcess extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly received: unknown[] = []
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []
  autoExitOnEnd = true
  onMessage: ((message: unknown) => void) | undefined
  private input = ""
  private exited = false

  constructor() {
    super()
    this.stdin.setEncoding("utf8")
    this.stdin.on("data", (chunk: string) => {
      this.input += chunk
      while (true) {
        const newline = this.input.indexOf("\n")
        if (newline < 0) {
          break
        }
        const line = this.input.slice(0, newline)
        this.input = this.input.slice(newline + 1)
        if (line.length === 0) {
          continue
        }
        const message: unknown = JSON.parse(line)
        this.received.push(message)
        this.onMessage?.(message)
      }
    })
    this.stdin.on("finish", () => {
      if (this.autoExitOnEnd) {
        this.exit(0, null)
      }
    })
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.stdout.end()
    this.stderr.end()
    this.emit("exit", code, signal)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    this.exit(null, typeof signal === "string" ? signal : null)
    return true
  }
}
