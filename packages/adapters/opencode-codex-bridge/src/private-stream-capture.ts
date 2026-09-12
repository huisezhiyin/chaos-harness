import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelPort } from "../../../kernel/src/index.js"
import { ChatStreamError } from "../../deepseek/src/index.js"
import { createProfileChatModel } from "./model-profiles.js"
import type { QwenProfile } from "./qwen.js"

export class ModelSessionStoppedError extends Error {
  constructor() {
    super("This host session stopped after a model failure; inspect its evidence before restarting")
    this.name = "ModelSessionStoppedError"
  }
}

/** Explicit launcher opt-in. Captures failures only; no response enters the journal. */
export function createPrivateStreamCapture(options: {
  parent?: string
  modelFactory?: (profile: QwenProfile) => ModelPort
  onCapture?: (path: string) => void
  onCaptureFailure?: () => void
} = {}): (profile: QwenProfile) => ModelPort {
  let stopped = false
  return profile => {
    const model = (options.modelFactory ?? createProfileChatModel)(profile)
    return { async *stream(request, signal) {
      if (stopped) throw new ModelSessionStoppedError()
      let text = Buffer.alloc(0)
      try {
        for await (const event of model.stream(request, signal)) {
          if (event.type === "text_delta" && text.length < 32_768) {
            text = Buffer.concat([text, Buffer.from(event.delta).subarray(0, 32_768 - text.length)])
          }
          yield event
        }
      } catch (error) {
        stopped = true
        if (error instanceof ChatStreamError) {
          try {
            const parent = options.parent ?? join(homedir(), ".local/state/chaos-harness/diagnostics")
            await mkdir(parent, { recursive: true, mode: 0o700 })
            const info = await lstat(parent)
            if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
                (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe diagnostics directory")
            const directory = await mkdtemp(join(parent, "incomplete-stream-"))
            const path = join(directory, "response.json")
            await writeFile(path, JSON.stringify({ code: error.code, upstreamCode: error.upstreamCode,
              stream: error.diagnostics, text: redact(text.toString("utf8"), profile.apiKey) }, null, 2),
              { flag: "wx", mode: 0o600 })
            options.onCapture?.(path)
          } catch { options.onCaptureFailure?.() }
        }
        throw error
      }
    } }
  }
}

function redact(text: string, key: string): string {
  let safe = key ? text.replaceAll(key, "[REDACTED]") : text
  // A response limit may cut a credential at the final byte.
  for (let size = key.length - 1; size >= 8; size--) {
    if (safe.endsWith(key.slice(0, size))) { safe = safe.slice(0, -size) + "[REDACTED]"; break }
  }
  return safe.replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s"<>]+/g, "[endpoint]")
}
