import { mkdtemp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  YAML_687_FIXED_HEAD, YAML_687_ROOT, assessYaml687Result, assertYaml687ProbeIntegrity,
  createYaml687Verifier, parseYaml687Result, runYaml687Probe, sourceDigest,
  validateYaml687Identity, yaml687ChildEnvironment, yaml687QualificationSource,
  type Yaml687Case, type Yaml687Result,
} from "../src/yaml-687-verifier.js"

function fixed(): Yaml687Result {
  const cases: Yaml687Case[] = []
  const add = (id: string, value: unknown, comment: string | null) => cases.push({
    id, beforeValue: JSON.stringify(value), afterValue: JSON.stringify(value),
    beforeComment: comment, afterComment: comment, beforeErrors: 0, afterErrors: 0, threw: false,
  })
  for (const style of ["|", ">"]) for (const indent of [1, 5, 9]) for (const multi of [false, true]) {
    add(`root-${style}-${indent}-${multi ? "multi" : "single"}`, "", multi ? "first\nsecond" : "comment")
  }
  add("mapping-empty", { a: "" }, "comment")
  add("sequence-empty", [""], "comment")
  add("nested-empty", { a: { b: "" } }, "comment")
  add("empty-no-comment", "", null)
  add("hash-content", "#content\n", null)
  add("nonempty-comment", "text\n", "comment")
  return { version: 1, cases }
}
const context = () => ({ missionId: "m", unitId: "u", unitRevision: 1, attemptId: "a",
  workspaceRoot: YAML_687_ROOT, goal: "fix YAML #687", completion: "done", signal: new AbortController().signal })

describe("YAML #687 trusted source verifier", () => {
  it("accepts exact values and comments in all 18 cases", () => {
    expect(assessYaml687Result(parseYaml687Result(JSON.stringify(fixed())))).toEqual({ passed: true, failedChecks: [] })
  })
  it.each(["afterValue", "afterComment", "beforeValue", "beforeComment", "afterErrors", "threw"] as const)(
    "rejects corrupted %s even when serialization did not crash", field => {
      const result = fixed()
      Object.assign(result.cases[0]!, { [field]: field.endsWith("Errors") ? 1 : field === "threw" ? true : "corrupt" })
      expect(assessYaml687Result(result).passed).toBe(false)
    },
  )
  it("rejects partial, duplicate, and unexpected coverage", () => {
    const result = fixed()
    expect(assessYaml687Result({ ...result, cases: result.cases.slice(1) }).passed).toBe(false)
    expect(assessYaml687Result({ ...result, cases: [...result.cases.slice(1), result.cases[1]!] }).passed).toBe(false)
    expect(assessYaml687Result({ ...result, cases: [...result.cases, result.cases[0]!] }).passed).toBe(false)
  })
  it("checks controls as well as the issue's root example", () => {
    const result = fixed()
    result.cases.find(c => c.id === "hash-content")!.afterValue = JSON.stringify("")
    expect(assessYaml687Result(result).failedChecks).toContain("hash-content: value not preserved")
  })
  it("rejects malformed JSON, envelopes and case fields", () => {
    for (const raw of ["oops", "{}", '{"version":2,"cases":[]}', JSON.stringify({ version: 1, cases: [{}] })]) {
      expect(() => parseYaml687Result(raw)).toThrow()
    }
    const result = fixed()
    result.cases[0]!.afterErrors = -1
    expect(() => parseYaml687Result(JSON.stringify(result))).toThrow()
  })
  it("validates exact root, SHA and official origin", () => {
    const identity = { root: YAML_687_ROOT, gitRoot: YAML_687_ROOT,
      head: YAML_687_FIXED_HEAD, origin: "https://github.com/eemeli/yaml.git" }
    expect(() => validateYaml687Identity(identity)).not.toThrow()
    for (const field of ["root", "gitRoot", "head", "origin"] as const) {
      expect(() => validateYaml687Identity({ ...identity, [field]: "wrong" })).toThrow()
    }
  })
  it("pins probe integrity and excludes loaders and all credential environment", async () => {
    await assertYaml687ProbeIntegrity()
    expect(yaml687ChildEnvironment({ PATH: "/bin", NODE_OPTIONS: "--import malicious",
      DASHSCOPE_API_KEY: "secret", GITHUB_TOKEN: "secret", HOME: "/private", SAFE_FLAG: "unused" }))
      .toEqual({ PATH: "/bin", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" })
  })
  it("fails closed on identity, probe exception and source drift without raw diagnostic leakage", async () => {
    const opts = { workspaceValidator: async () => YAML_687_ROOT, fingerprint: async () => "stable", probeRunner: async () => fixed() }
    expect(await createYaml687Verifier(opts).verify(context())).toEqual({ passed: true })
    const throws = async (): Promise<never> => { throw new Error("private-secret") }
    for (const options of [{ ...opts, workspaceValidator: throws }, { ...opts, probeRunner: throws }]) {
      const verdict = await createYaml687Verifier(options).verify(context())
      expect(verdict.passed).toBe(false)
      expect(JSON.stringify(verdict)).not.toContain("private-secret")
    }
    let count = 0
    const verdict = await createYaml687Verifier({ ...opts, fingerprint: async () => String(count++) }).verify(context())
    expect(verdict.passed).toBe(false)
    expect(verdict.guidance).toContain("changed during")
  })
  it("only reports trusted case descriptions, not raw values", async () => {
    const result = fixed()
    result.cases[0]!.afterValue = "private-secret"
    const verdict = await createYaml687Verifier({ workspaceValidator: async () => YAML_687_ROOT,
      fingerprint: async () => "stable", probeRunner: async () => result }).verify(context())
    expect(verdict.passed).toBe(false)
    expect(verdict.guidance).toContain("value not preserved")
    expect(JSON.stringify(verdict)).not.toContain("private-secret")
  })
  it("qualification transforms are bounded to the exact baseline anchor", () => {
    const source = "if (!value) return literal ? '|\\n' : '>\\n'"
    expect(yaml687QualificationSource(source, "baseline")).toBe(source)
    expect(yaml687QualificationSource(source, "fixed")).not.toBe(source)
    expect(yaml687QualificationSource(source, "literal-only")).not.toBe(yaml687QualificationSource(source, "fixed"))
    expect(() => yaml687QualificationSource("different source", "fixed")).toThrow()
    expect(() => yaml687QualificationSource(source + source, "fixed")).toThrow()
  })
  it("fingerprints content and refuses source symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-yaml-source-test-"))
    try {
      await mkdir(join(root, "src"))
      await writeFile(join(root, "src/index.ts"), "export const value = 1")
      const first = await sourceDigest(root)
      await writeFile(join(root, "src/index.ts"), "export const value = 2")
      expect(await sourceDigest(root)).not.toBe(first)
      await symlink(join(root, "src/index.ts"), join(root, "src/link.ts"))
      await expect(sourceDigest(root)).rejects.toThrow("symlinks")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform !== "darwin")("real child loads source instead of stale dist and cannot write files", async () => {
    const root = await mkdtemp(join(tmpdir(), "chaos-yaml-sandbox-test-"))
    try {
      await mkdir(join(root, "src"))
      await mkdir(join(root, "dist"))
      await writeFile(join(root, "dist/index.js"), "export function parseDocument() { return {} }")
      const marker = join(root, "must-not-exist")
      await writeFile(join(root, "src/index.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export const parseDocument = () => ({})`)
      await expect(runYaml687Probe(root, new AbortController().signal)).rejects.toThrow()
      await expect(access(marker)).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
