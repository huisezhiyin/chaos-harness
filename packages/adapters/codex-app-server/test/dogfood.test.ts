import { execFile } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import { type HostAttemptPort } from "../../../kernel/src/index.js"
import { recordCodexDogfoodReview, runCodexDogfoodAttempt } from "../src/dogfood.js"

const execFileAsync = promisify(execFile)

describe("Codex dogfood runner", () => {
  it("runs one exact attempt and persists only sanitized lifecycle evidence", async () => {
    const fixture = await gitFixture()
    const recordPath = join(fixture.parent, "dogfood.jsonl")
    const run = vi.fn(async (request, _signal?: AbortSignal) => ({
      attemptId: request.attempt.attemptId,
      runtime: {
        profile: "codex-app-server",
        cliVersion: "0.133.0",
        backendSessionId: "private-thread-id",
        backendRunId: "private-turn-id",
      },
      actions: [
        {
          sequence: 1,
          actionId: "command-1",
          name: "commandExecution",
          kind: "execute" as const,
          status: "completed" as const,
          input: { command: "private command" },
          output: "private output",
        },
      ],
      artifacts: [
        { path: join(fixture.root, "src", "value.js") },
        { path: join(fixture.parent, "outside.txt") },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        cost: 0,
      },
      events: [{
        sequence: 1,
        type: "permission_requested" as const,
        permission: "private permission",
        title: "private title",
      }],
      status: "completion_proposed" as const,
      completion: "private completion",
    }))
    const attemptPort: HostAttemptPort = {
      capabilities: [],
      run,
    }
    const moments = [new Date("2026-09-02T01:00:00.000Z"), new Date("2026-09-02T01:00:03.000Z")]

    const result = await runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "private user goal",
      model: "gpt-test-exact",
      recordPath,
      attemptPort,
      createRunId: () => "run-safe-id",
      now: () => moments.shift() ?? new Date("2026-09-02T01:00:03.000Z"),
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      workspaceRoot: fixture.root,
      model: { provider: "openai", model: "gpt-test-exact" },
    })
    expect(run.mock.calls[0]?.[0].prompt).toContain("Goal: private user goal")
    expect(result).toMatchObject({ verification: "pending", boundaryViolation: true })

    const raw = await readFile(recordPath, "utf8")
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ event: "started", runId: "run-safe-id" })
    expect(records[1]).toMatchObject({
      event: "finished",
      terminalState: "completion_proposed",
      artifactPaths: ["src/value.js"],
      outOfBoundsArtifactCount: 1,
      verification: "pending",
    })
    expect(raw).not.toContain("private user goal")
    expect(raw).not.toContain("private completion")
    expect(raw).not.toContain("private-thread-id")
    expect(raw).not.toContain("private-turn-id")
    expect(raw).not.toContain("private command")
    expect(raw).not.toContain("private output")
    expect(raw).not.toContain(fixture.root)
    expect((await stat(recordPath)).mode & 0o077).toBe(0)
  })

  it("forwards caller cancellation to the exact attempt", async () => {
    const fixture = await gitFixture()
    const controller = new AbortController()
    const run = vi.fn(async (request, _signal?: AbortSignal) => ({
      attemptId: request.attempt.attemptId,
      runtime: { profile: "codex-app-server" },
      actions: [],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      },
      events: [],
      status: "aborted" as const,
      failure: { kind: "aborted" as const, message: "cancelled", retryable: false },
    }))

    await runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "goal",
      model: "model",
      recordPath: join(fixture.parent, "dogfood.jsonl"),
      attemptPort: { capabilities: [], run } as HostAttemptPort,
      signal: controller.signal,
    })

    expect(run.mock.calls[0]?.[1]).toBe(controller.signal)
  })

  it("rejects a dirty workspace unless explicitly acknowledged", async () => {
    const fixture = await gitFixture()
    await writeFile(join(fixture.root, "tracked.txt"), "dirty\n", "utf8")
    const run = vi.fn()

    await expect(runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "goal",
      model: "model",
      recordPath: join(fixture.parent, "dogfood.jsonl"),
      attemptPort: { capabilities: [], run } as HostAttemptPort,
    })).rejects.toThrow("Workspace is dirty")
    expect(run).not.toHaveBeenCalled()
  })

  it("closes the sanitized journal when the attempt port throws", async () => {
    const fixture = await gitFixture()
    const recordPath = join(fixture.parent, "dogfood.jsonl")

    const result = await runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "private failing goal",
      model: "gpt-test-exact",
      recordPath,
      attemptPort: {
        capabilities: [],
        run: async () => {
          throw new Error("private provider failure")
        },
      },
      createRunId: () => "failed-safe-id",
    })

    expect(result.result).toMatchObject({
      status: "failed",
      failure: { kind: "unknown", retryable: false },
    })
    const raw = await readFile(recordPath, "utf8")
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.map((record) => record.event)).toEqual(["started", "finished"])
    expect(raw).not.toContain("private failing goal")
    expect(raw).not.toContain("private provider failure")
  })

  it("rejects records inside the workspace", async () => {
    const fixture = await gitFixture()

    await expect(runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "goal",
      model: "model",
      recordPath: join(fixture.root, "dogfood.jsonl"),
      attemptPort: neverRunPort(),
    })).rejects.toThrow("outside the workspace")
  })

  it("rejects symlink and group-readable record files", async () => {
    const fixture = await gitFixture()
    const target = join(fixture.parent, "target.jsonl")
    const link = join(fixture.parent, "link.jsonl")
    await writeFile(target, "", { mode: 0o600 })
    await symlink(target, link)

    await expect(runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "goal",
      model: "model",
      recordPath: link,
      attemptPort: neverRunPort(),
    })).rejects.toThrow("non-symlink")

    await chmod(target, 0o640)
    await expect(runCodexDogfoodAttempt({
      workspaceRoot: fixture.root,
      goal: "goal",
      model: "model",
      recordPath: target,
      attemptPort: neverRunPort(),
    })).rejects.toThrow("mode 0600")
  })

  it("appends one enum-only review event for an existing finished run", async () => {
    const fixture = await gitFixture()
    const recordPath = join(fixture.parent, "dogfood.jsonl")
    await writeFile(recordPath, `${JSON.stringify({
      schemaVersion: 1,
      event: "finished",
      runId: "finished-run-id",
      occurredAt: "2026-09-02T01:00:00.000Z",
      goalSha256: "private-goal-hash",
      completionPresent: true,
      artifactPaths: ["src/value.js"],
      verification: "pending",
    })}\n`, { mode: 0o600 })

    const result = await recordCodexDogfoodReview({
      recordPath,
      runId: "finished-run-id",
      verification: "passed",
      experience: "smooth",
      intervention: "none",
      now: () => new Date("2026-09-02T02:00:00.000Z"),
    })

    expect(result).toMatchObject({
      runId: "finished-run-id",
      recordPath,
      verification: "passed",
      experience: "smooth",
      intervention: "none",
    })
    const raw = await readFile(recordPath, "utf8")
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(2)
    expect(records[1]).toEqual({
      schemaVersion: 1,
      event: "review",
      runId: "finished-run-id",
      occurredAt: "2026-09-02T02:00:00.000Z",
      verification: "passed",
      experience: "smooth",
      intervention: "none",
    })
    expect(Object.keys(records[1] ?? {})).toEqual([
      "schemaVersion",
      "event",
      "runId",
      "occurredAt",
      "verification",
      "experience",
      "intervention",
    ])
    expect(raw).not.toContain("private user goal")
    expect(raw).not.toContain("private completion")
    expect(raw).not.toContain("private command")
    expect(raw).not.toContain(fixture.root)
  })

  it("rejects unknown and duplicate review run IDs", async () => {
    const fixture = await gitFixture()
    const recordPath = join(fixture.parent, "dogfood.jsonl")
    await writeFile(recordPath, [
      JSON.stringify({ schemaVersion: 1, event: "finished", runId: "finished-run-id" }),
      JSON.stringify({ schemaVersion: 1, event: "review", runId: "reviewed-run-id" }),
      JSON.stringify({ schemaVersion: 1, event: "finished", runId: "reviewed-run-id" }),
      "",
    ].join("\n"), { mode: 0o600 })

    await expect(recordCodexDogfoodReview({
      recordPath,
      runId: "missing-run-id",
      verification: "failed",
      experience: "blocked",
      intervention: "major",
    })).rejects.toThrow("existing finished run ID")

    await expect(recordCodexDogfoodReview({
      recordPath,
      runId: "reviewed-run-id",
      verification: "failed",
      experience: "blocked",
      intervention: "major",
    })).rejects.toThrow("already exists")

    const records = (await readFile(recordPath, "utf8")).trim().split("\n")
    expect(records).toHaveLength(3)
  })

  it("rejects unsafe review record files", async () => {
    const fixture = await gitFixture()
    const target = join(fixture.parent, "target.jsonl")
    const link = join(fixture.parent, "link.jsonl")
    await writeFile(target, `${JSON.stringify({
      schemaVersion: 1,
      event: "finished",
      runId: "finished-run-id",
    })}\n`, { mode: 0o600 })
    await symlink(target, link)

    await expect(recordCodexDogfoodReview({
      recordPath: link,
      runId: "finished-run-id",
      verification: "passed",
      experience: "mixed",
      intervention: "minor",
    })).rejects.toThrow("non-symlink")

    await chmod(target, 0o640)
    await expect(recordCodexDogfoodReview({
      recordPath: target,
      runId: "finished-run-id",
      verification: "passed",
      experience: "mixed",
      intervention: "minor",
    })).rejects.toThrow("mode 0600")
  })
})

async function gitFixture(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "chaos-codex-dogfood-"))
  const root = join(parent, "workspace")
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "tracked.txt"), "clean\n", "utf8")
  await execFileAsync("git", ["init", "-q", root])
  await execFileAsync("git", ["-C", root, "config", "user.name", "Chaos Harness Test"])
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"])
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"])
  await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "fixture"])
  return { parent: await realpath(parent), root: await realpath(root) }
}

function neverRunPort(): HostAttemptPort {
  return {
    capabilities: [],
    run: async () => {
      throw new Error("attempt must not run")
    },
  }
}
