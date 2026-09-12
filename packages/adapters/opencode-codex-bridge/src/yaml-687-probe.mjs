import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// No workspace scripts, config, dependencies, or dist are loaded.
const root = process.argv[2]
if (!root || process.argv.length !== 3) throw new TypeError("Expected source root")
const { parseDocument } = await import(pathToFileURL(resolve(root, "src/index.ts")).href)
const inputs = []
for (const style of ["|", ">"]) {
  for (const indent of [1, 5, 9]) {
    for (const multi of [false, true]) {
      inputs.push([
        `root-${style}-${indent}-${multi ? "multi" : "single"}`,
        `${style}${indent}\n${multi ? "#first\n#second\n" : "#comment"}`,
      ])
    }
  }
}
inputs.push(
  ["mapping-empty", "a: |5\n#comment"],
  ["sequence-empty", "- |5\n#comment"],
  ["nested-empty", "a:\n  b: |5\n#comment"],
  ["empty-no-comment", "|5\n"],
  ["hash-content", "|2\n  #content\n"],
  ["nonempty-comment", "|2\n  text\n#comment"],
)
const cases = inputs.map(([id, input]) => {
  try {
    const before = parseDocument(input)
    const after = parseDocument(before.toString())
    return {
      id,
      beforeValue: JSON.stringify(before.toJS()),
      afterValue: JSON.stringify(after.toJS()),
      beforeComment: before.comment,
      afterComment: after.comment,
      beforeErrors: before.errors.length,
      afterErrors: after.errors.length,
      threw: false,
    }
  } catch {
    return { id, beforeValue: "", afterValue: "", beforeComment: null,
      afterComment: null, beforeErrors: 0, afterErrors: 0, threw: true }
  }
})
process.stdout.write(JSON.stringify({ version: 1, cases }) + "\n")
