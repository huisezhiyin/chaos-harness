import { execFile } from "node:child_process"
import { CodexAppServerError } from "./errors.js"
import { DEFAULT_CODEX_COMMAND } from "./client.js"

export const SUPPORTED_CODEX_CLI_VERSION = "0.133.0"
export const CODEX_APP_SERVER_SCHEMA_PROFILE =
  `codex-cli/${SUPPORTED_CODEX_CLI_VERSION}:stable`

export async function readCodexCliVersion(
  command = DEFAULT_CODEX_COMMAND,
  timeoutMs = 5_000,
): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, ["--version"], { timeout: timeoutMs }, (error, output) => {
      if (error !== null) {
        reject(new CodexAppServerError(
          "configuration",
          `Unable to read Codex CLI version: ${error.message}`,
        ))
        return
      }
      resolve(output)
    })
  })
  const match = /^codex-cli\s+(\S+)\s*$/.exec(stdout)
  if (match?.[1] === undefined) {
    throw new CodexAppServerError("configuration", "Unrecognized Codex CLI version output")
  }
  return match[1]
}

export function assertCompatibleCodexCliVersion(version: string): void {
  if (version !== SUPPORTED_CODEX_CLI_VERSION) {
    throw new CodexAppServerError(
      "configuration",
      `Unsupported Codex CLI version ${version}; expected ${SUPPORTED_CODEX_CLI_VERSION}`,
    )
  }
}
