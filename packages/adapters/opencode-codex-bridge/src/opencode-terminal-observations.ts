import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

export const CHAOS_TERMINAL_OBSERVATIONS_ENV = "CHAOS_HARNESS_TERMINAL_OBSERVATIONS"
export const MAX_TERMINAL_OBSERVATIONS = 256
export const MAX_TERMINAL_OBSERVATION_BYTES = 1024
export const HOST_TOOL_ERROR = "host_tool_error"
export const HOST_PERMISSION_REJECTED = "host_permission_rejected"

/** Launch-private, bounded, signed diagnostics only; never a tool execution channel. */
export async function prepareTerminalObservations() {
  const directory = await mkdtemp(join(tmpdir(), "chaos-host-terminal-"))
  const path = join(directory, "observations.jsonl")
  await writeFile(path, "", { flag: "wx", mode: 0o600 })
  return {
    path,
    async read(): Promise<string[]> {
      const limit = MAX_TERMINAL_OBSERVATIONS * MAX_TERMINAL_OBSERVATION_BYTES
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let data: Buffer
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > limit) return []
        const buffer = Buffer.alloc(limit + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > limit) return []
        data = buffer.subarray(0, bytesRead)
      } finally { await file.close() }
      const lines = data.toString("utf8").split("\n").filter(Boolean)
      if (lines.length > MAX_TERMINAL_OBSERVATIONS) return []
      return lines.flatMap(line => {
        try {
          const value: unknown = JSON.parse(line)
          return typeof value === "string" && Buffer.byteLength(line) <= MAX_TERMINAL_OBSERVATION_BYTES ? [value] : []
        } catch { return [] }
      })
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}
