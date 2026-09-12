import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Pinned-host compatibility seam, not an OS sandbox. HOME for shell tools is unchanged. */
export async function prepareOpenCodeHostProfile(
  inherited: NodeJS.ProcessEnv,
  stateRoot = join(homedir(), ".local", "state", "chaos-harness", "opencode-profile"),
) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const info = await lstat(stateRoot)
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new Error("Chaos OpenCode profile must be a private owned directory")
  }
  await chmod(stateRoot, 0o700)
  const temporary = await mkdtemp(join(tmpdir(), "chaos-opencode-config-"))
  // No inherited config file/content/permission/plugin entry points. Managed policy
  // still loads normally; never set OPENCODE_TEST_MANAGED_CONFIG_DIR.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !key.startsWith("OPENCODE_") && !key.startsWith("DASHSCOPE_")))
  return {
    env: {
      ...env,
      XDG_CONFIG_HOME: join(temporary, "config"),
      XDG_DATA_HOME: join(stateRoot, "data"),
      XDG_STATE_HOME: join(stateRoot, "state"),
      OPENCODE_CONFIG_DIR: join(temporary, "config", "opencode"),
      // 1.18.26 also scans ~/.opencode independently of XDG_CONFIG_HOME.
      // This host-only lookup override avoids touching the user's real HOME.
      OPENCODE_TEST_HOME: join(temporary, "home"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    } as NodeJS.ProcessEnv,
    dispose: () => rm(temporary, { recursive: true, force: true }),
  }
}

export async function verifyOpenCodeHostProfile(input: {
  command: string; root: string; env: NodeJS.ProcessEnv; observationPlugin: string
}): Promise<void> {
  try {
    // debug config resolves configuration without initializing plugins or a model.
    const { stdout } = await exec(input.command, ["debug", "config"], {
      cwd: input.root, env: input.env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    })
    assertIsolatedOpenCodeConfig(JSON.parse(stdout), input.observationPlugin)
  } catch {
    // Never expose resolved config, tokens, or child stderr.
    throw new Error("Chaos OpenCode profile isolation failed; TUI was not opened. Check pinned host and managed configuration.")
  }
}

export function assertIsolatedOpenCodeConfig(value: unknown, observationPlugin: string): void {
  const config = value as Record<string, any> | null
  const allowed = new Set([observationPlugin, `file://${observationPlugin}`])
  if (!config || !Array.isArray(config.plugin) || config.plugin.length !== 1 ||
      !allowed.has(config.plugin[0]) ||
      !Array.isArray(config.plugin_origins) || config.plugin_origins.length !== 1 ||
      !allowed.has(config.plugin_origins[0]?.spec) ||
      config.model !== "chaos-qwen/code-agent" || config.small_model !== "chaos-qwen/metadata" ||
      JSON.stringify(config.enabled_providers) !== '["chaos-qwen"]' ||
      Object.keys(config.mcp ?? {}).length !== 0) {
    throw new Error("Unexpected OpenCode plugins, MCP servers, or model routing")
  }
}
