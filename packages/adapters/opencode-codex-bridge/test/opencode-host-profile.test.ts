import { mkdtemp, readFile, writeFile, access } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { prepareOpenCodeHostProfile, assertIsolatedOpenCodeConfig } from "../src/opencode-host-profile.js"

describe("isolated OpenCode host profile", () => {
  it("does not inherit plugin/config paths or overwrite the user's config or shell HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-profile-test-"))
    const config = join(root, "user.json")
    const original = '{"plugin":["company-feedback"]}'
    await writeFile(config, original)
    const host = await prepareOpenCodeHostProfile({ HOME: root, PATH: "/bin",
      OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: root, OPENCODE_PURE: "1",
      OPENCODE_CONFIG_CONTENT: original, DASHSCOPE_API_KEY: "secret",
    }, join(root, "profile"))
    try {
      expect(host.env.HOME).toBe(root)
      expect(host.env.OPENCODE_CONFIG).toBeUndefined()
      expect(host.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
      expect(host.env.OPENCODE_PURE).toBeUndefined()
      expect(host.env.DASHSCOPE_API_KEY).toBeUndefined()
      expect(host.env.OPENCODE_TEST_MANAGED_CONFIG_DIR).toBeUndefined()
      expect(host.env.OPENCODE_CONFIG_DIR).not.toBe(root)
      expect(host.env.OPENCODE_TEST_HOME).not.toBe(root)
      expect(host.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
      expect(await readFile(config, "utf8")).toBe(original)
    } finally { await host.dispose() }
    await expect(access(host.env.XDG_CONFIG_HOME!)).rejects.toThrow()
  })

  it("requires exactly the observation plugin and isolated model/MCP routing", () => {
    const config = { plugin: ["file:///trusted/observation.ts"],
      plugin_origins: [{ spec: "file:///trusted/observation.ts" }],
      model: "chaos-qwen/code-agent", small_model: "chaos-qwen/metadata", enabled_providers: ["chaos-qwen"] }
    expect(() => assertIsolatedOpenCodeConfig(config, "/trusted/observation.ts")).not.toThrow()
    for (const changed of [
      { plugin: [...config.plugin, "feedback"] },
      { plugin_origins: [...config.plugin_origins, { spec: "feedback" }] },
      { plugin: [] }, { model: "other/model" }, { mcp: { company: { enabled: true } } },
    ]) expect(() => assertIsolatedOpenCodeConfig({ ...config, ...changed }, "/trusted/observation.ts")).toThrow()
  })
})
