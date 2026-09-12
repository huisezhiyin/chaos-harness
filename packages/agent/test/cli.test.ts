import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  AgentCliConfigurationError,
  resolveAgentCliConfig,
} from "../src/cli.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("Agent Alpha CLI config", () => {
  it("fails closed when the project config is absent", async () => {
    await expect(
      resolveAgentCliConfig(["inspect README.md"], {}, "/workspace"),
    ).rejects.toBeInstanceOf(AgentCliConfigurationError)
  })

  it("discovers the root config and reads the referenced env file", async () => {
    const root = await createConfiguredWorkspace("file-secret")
    const config = await resolveAgentCliConfig(
      ["--", "--root", root, "inspect", "README.md"],
      { HOME: root },
      "/fallback",
    )

    expect(config).toEqual({
      mode: "general",
      apiKey: "file-secret",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      maxTokens: 1000,
      configPath: join(root, "deepseek.config.json"),
      credentialSource: "env_file",
      workspaceRoot: root,
      prompt: "inspect README.md",
    })
  })

  it("gives process environment overrides precedence over the env file", async () => {
    const root = await createConfiguredWorkspace("file-secret")
    const config = await resolveAgentCliConfig(
      ["--root", root, "inspect README.md"],
      {
        HOME: root,
        DEEPSEEK_API_KEY: "process-secret",
        DEEPSEEK_MODEL: "deepseek-v4-pro",
        DEEPSEEK_MAX_TOKENS: "2048",
      },
      "/fallback",
    )

    expect(config.apiKey).toBe("process-secret")
    expect(config.credentialSource).toBe("process_env")
    expect(config.model).toBe("deepseek-v4-pro")
    expect(config.maxTokens).toBe(2048)
  })

  it("selects coding mode explicitly", async () => {
    const root = await createConfiguredWorkspace("file-secret")
    const config = await resolveAgentCliConfig(
      ["--mode", "coding", "--root", root, "fix the bug"],
      { HOME: root },
      "/fallback",
    )

    expect(config.mode).toBe("coding")
  })
})

async function createConfiguredWorkspace(apiKey: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-agent-cli-"))
  temporaryDirectories.push(root)
  await writeFile(join(root, ".credential.env"), `DEEPSEEK_API_KEY=${apiKey}\n`)
  await writeFile(
    join(root, "deepseek.config.json"),
    JSON.stringify({
      version: 1,
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      maxTokens: 1000,
      credential: {
        env: "DEEPSEEK_API_KEY",
        envFile: "${HOME}/.credential.env",
      },
    }),
  )
  return root
}
