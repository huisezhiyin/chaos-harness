import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DeepSeekConfigurationError,
  loadDeepSeekProjectConfig,
  parseEnvAssignments,
} from "../src/deepseek-config.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("DeepSeek project config", () => {
  it("parses env assignments without executing the file", () => {
    expect(
      parseEnvAssignments([
        "# provider credentials",
        "export DEEPSEEK_API_KEY='quoted-secret'",
        "IGNORED command",
        "DEEPSEEK_MODEL=deepseek-v4-flash",
      ].join("\n")),
    ).toEqual({
      DEEPSEEK_API_KEY: "quoted-secret",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    })
  })

  it("rejects embedded secret fields without leaking their value", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-deepseek-config-"))
    temporaryDirectories.push(root)
    const configPath = join(root, "deepseek.config.json")
    await writeFile(configPath, JSON.stringify({ apiKey: "must-not-leak" }))

    let error: unknown
    try {
      await loadDeepSeekProjectConfig(configPath)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DeepSeekConfigurationError)
    expect((error as Error).message).toContain("Secret field is forbidden")
    expect((error as Error).message).not.toContain("must-not-leak")
  })

  it("rejects unknown project fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-deepseek-config-"))
    temporaryDirectories.push(root)
    const configPath = join(root, "deepseek.config.json")
    await writeFile(
      configPath,
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
        extra: true,
      }),
    )

    await expect(loadDeepSeekProjectConfig(configPath)).rejects.toThrow(
      "DeepSeek config contains unknown field: extra",
    )
  })
})
