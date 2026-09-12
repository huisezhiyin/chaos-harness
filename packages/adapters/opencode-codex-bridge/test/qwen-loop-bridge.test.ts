import { describe, expect, it, vi } from "vitest"
import type {
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
} from "../../../kernel/src/index.js"
import {
  QWEN_LOOP_METADATA_MODEL_ID,
  QWEN_LOOP_MODEL_ID,
  startOpenCodeQwenLoopBridge,
  type OpenCodeQwenLoopBridge,
  type QwenLoopJournalEvent,
} from "../src/qwen-loop-bridge.js"
import { encodeOpenCodeToolObservation } from "../src/opencode-observation-envelope.js"
import { GitArtifactStateError } from "../src/git-artifact-state.js"

describe("OpenCode Qwen Chaos Loop bridge", () => {
  it("keeps one NativeAttemptEngine Attempt across OpenCode tool relay requests", async () => {
    const goal = "只读查看 README.md，用一句话说明这个项目做什么，不修改任何文件。"
    const capture = vi.fn(async () => { throw new GitArtifactStateError("untracked_bytes_limit") })
    const requests: ModelRequest[] = []
    const events: QwenLoopJournalEvent[] = []
    const model = scriptedModel(requests)
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => model,
      workspaceArtifactProbe: { capture },
      createAttemptId: () => "qwen-attempt-exact",
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const first = await request(bridge, codeRequest([
        { role: "user", content: goal },
      ]))
      expect(first.status).toBe(200)
      const firstBody = await first.json() as Record<string, any>
      expect(firstBody.choices[0]).toMatchObject({
        finish_reason: "tool_calls",
        message: {
          reasoning_content: "I should inspect README before answering.",
          tool_calls: [{
            id: "call-read",
            function: { name: "read", arguments: "{\"filePath\":\"README.md\"}" },
          }],
        },
      })
      expect(firstBody.usage).toMatchObject({
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: {
          cached_tokens: 6,
          cache_creation_input_tokens: 1,
        },
        completion_tokens_details: { reasoning_tokens: 2 },
      })

      const second = await request(bridge, codeRequest([
        { role: "user", content: goal },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-read",
            type: "function",
            function: { name: "read", arguments: "{\"filePath\":\"README.md\"}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "call-read",
            ok: true,
            content: "# Harness\n",
          }),
        },
      ]))
      expect(second.status).toBe(200)
      const secondBody = await second.json() as Record<string, any>
      expect(secondBody.choices[0]).toMatchObject({
        finish_reason: "stop",
        message: {
          reasoning_content: "The observation is sufficient for a concise report.",
          content: "README was inspected through the Chaos Loop.",
        },
      })
      expect(secondBody.usage).toMatchObject({
        prompt_tokens: 15,
        completion_tokens: 7,
        total_tokens: 22,
        prompt_tokens_details: {
          cached_tokens: 12,
          cache_creation_input_tokens: 0,
        },
        completion_tokens_details: { reasoning_tokens: 3 },
      })

      expect(requests).toHaveLength(2)
      expect(requests.map((item) => item.attemptId)).toEqual([
        "qwen-attempt-exact",
        "qwen-attempt-exact",
      ])
      expect(requests.map((item) => item.turn)).toEqual([1, 2])
      expect(requests[0]?.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining('exact Git worktree root for this Attempt is "/workspace"'),
      })
      expect(requests[1]?.messages).toContainEqual({
        role: "assistant",
        content: "",
        reasoning: "I should inspect README before answering.",
        toolCalls: [{
          toolCallId: "call-read",
          name: "read",
          arguments: { filePath: "README.md" },
        }],
      })
      expect(requests[1]?.messages).toContainEqual({
        role: "tool",
        content: "# Harness\n",
        toolCallId: "call-read",
        toolName: "read",
        ok: true,
      })
      expect(events.filter(event => !event.event.startsWith("model_") && event.event !== "host_observation_received").map((event) => event.event)).toEqual([
        "mission_started",
        "unit_proposed",
        "unit_admitted",
        "checkpoint_opened",
        "checkpoint_resolved",
        "attempt_started",
        "action_proposed",
        "action_observed",
        "action_accounted",
        "attempt_finished",
        "completion_proposed",
        "verification_completed",
        "unit_finished",
        "mission_finished",
      ])
      expect(events.find((event) => event.event === "action_observed")).toMatchObject({
        action: "read",
        ok: true,
      })
      expect(events.filter(event => event.event === "model_request_started")).toHaveLength(2)
      expect(events.filter(event => event.event === "model_request_finished")).toHaveLength(2)
      expect(events.find(event => event.event === "host_observation_received")).toMatchObject({ hostRoundTripMs: expect.any(Number) })
      expect(events.find(event => event.event === "action_observed")).toMatchObject({ observationProcessingMs: expect.any(Number) })
      expect(events.every((event) => JSON.stringify(event).includes(goal) === false)).toBe(true)
      expect(events.find((event) => event.event === "attempt_finished")).toMatchObject({
        attemptId: "qwen-attempt-exact",
        terminalState: "completion_proposed",
        turns: 2,
        actions: 1,
        reasoningTokens: 5,
        cacheReadTokens: 18,
        cacheWriteTokens: 1,
      })
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
      expect(capture).not.toHaveBeenCalled()
      const mutation = await request(bridge, codeRequest([{ role: "user", content: "修改 README.md" }]))
      expect(mutation.status).toBe(500)
      expect(await mutation.text()).toContain("Untracked file content exceeds the 32 MiB capture limit")
      expect(capture).toHaveBeenCalledTimes(1)
      expect(requests).toHaveLength(2)
    } finally {
      await bridge.close()
    }
  })

  it("does not impose the old 24-turn daily-profile ceiling", async () => {
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => longReadModel(25),
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      let response = await request(bridge, codeRequest([{ role: "user", content: "inspect many files" }]))
      for (let turn = 1; turn <= 25; turn += 1) {
        const body = await response.json() as Record<string, any>
        expect(body.choices[0].finish_reason).toBe("tool_calls")
        const callId = body.choices[0].message.tool_calls[0].id as string
        response = await request(bridge, codeRequest([
          { role: "user", content: "inspect many files" },
          {
            role: "tool",
            tool_call_id: callId,
            content: encodeOpenCodeToolObservation({
              token: bridge.observationToken,
              toolCallId: callId,
              ok: true,
              content: `file ${turn}`,
            }),
          },
        ]))
      }

      expect(response.status).toBe(200)
      expect((await response.json() as Record<string, any>).choices[0].message.content).toBe("inspection complete")
      expect(events.find((event) => event.event === "attempt_finished")).toMatchObject({
        turns: 26,
        actions: 25,
        terminalState: "completion_proposed",
      })
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
    } finally {
      await bridge.close()
    }
  })

  it("applies an explicit task-bound Attempt budget without changing the daily default", async () => {
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => longReadModel(5),
      attemptBudget: { maxTurns: 2, maxActions: 1 },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const first = await request(bridge, codeRequest([{ role: "user", content: "bounded inspection" }]))
      const callId = (await first.json() as Record<string, any>).choices[0].message.tool_calls[0].id as string
      const stopped = await request(bridge, codeRequest([
        { role: "user", content: "bounded inspection" },
        {
          role: "tool",
          tool_call_id: callId,
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: callId,
            ok: true,
            content: "first file",
          }),
        },
      ]))

      expect(stopped.status).toBe(422)
      expect(await stopped.text()).toContain("max_actions")
      expect(events.find((event) => event.event === "attempt_finished")).toMatchObject({
        terminalState: "stopped",
        stopReason: "max_actions",
        turns: 2,
        actions: 1,
      })
    } finally {
      await bridge.close()
    }
  })

  it("rejects invalid task-bound Attempt budgets before opening the bridge", async () => {
    await expect(startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      attemptBudget: { maxTurns: 0 },
    })).rejects.toThrow("maxTurns must be a positive integer")

    await expect(startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      attemptBudget: {
        maxTurns: 2,
        evidenceClosure: { maxTurns: 0, maxActions: 2, allowedToolNames: ["bash"] },
      },
    })).rejects.toThrow("evidenceClosure.maxTurns must be a positive integer")

    await expect(startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      attemptBudget: {
        evidenceClosure: { maxTurns: 2, maxActions: 2, allowedToolNames: ["bash"] },
      },
    })).rejects.toThrow("evidenceClosure requires maxTurns or maxActions")

    await expect(startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      mutationProgressSteer: { afterActions: 1 },
    })).rejects.toThrow("requires a task-bound maxActions budget")

    await expect(startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      attemptBudget: { maxActions: 2 },
      mutationProgressSteer: { afterActions: 2 },
    })).rejects.toThrow("must run before the task-bound maxActions guard")
  })

  it("steers each mutation Attempt once when the action threshold has no artifact progress", async () => {
    const attemptIds = ["progress-attempt", "progress-recovery"]
    const firstRequests: ModelRequest[] = []
    const recoveryRequests: ModelRequest[] = []
    const models = [
      readThenFinalModel(firstRequests, "progress-first"),
      readThenFinalModel(recoveryRequests, "progress-recovery"),
    ]
    const events: QwenLoopJournalEvent[] = []
    const capture = artifactProbe([
      artifactState("a", 0),
      artifactState("a", 0),
      artifactState("a", 0),
      artifactState("a", 0),
      artifactState("a", 0),
    ])
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      workspaceArtifactProbe: capture,
      attemptBudget: { maxTurns: 4, maxActions: 3 },
      mutationProgressSteer: { afterActions: 1 },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const first = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "fix the parser" }],
        ["read"],
      ))
      expect((await first.json() as Record<string, any>).choices[0].message.tool_calls[0].id)
        .toBe("progress-first-read")

      const recovery = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the parser" },
        toolObservation(bridge, "progress-first-read", "diagnosis complete"),
      ], ["read"]))
      expect((await recovery.json() as Record<string, any>).choices[0].message.tool_calls[0].id)
        .toBe("progress-recovery-read")

      const pending = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the parser" },
        toolObservation(bridge, "progress-recovery-read", "same diagnosis repeated"),
      ], ["read"]))
      expect((await pending.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING/)

      for (const requests of [firstRequests, recoveryRequests]) {
        expect(requests[1]?.messages.filter((message) => message.role === "control"))
          .toHaveLength(1)
        expect(requests[1]?.messages).toContainEqual(expect.objectContaining({
          role: "control",
          content: expect.stringContaining("Stop expanding read-only investigation"),
        }))
      }
      expect(events.filter((event) => event.event === "mutation_progress_checked"))
        .toEqual([
          expect.objectContaining({
            attemptId: "progress-attempt",
            workActions: 1,
            artifactProgress: "unchanged",
            intervention: "steer",
          }),
          expect.objectContaining({
            attemptId: "progress-recovery",
            workActions: 1,
            artifactProgress: "unchanged",
            intervention: "steer",
          }),
        ])
      expect(capture.capture).toHaveBeenCalledTimes(5)
    } finally {
      await bridge.close()
    }
  })

  it("records artifact progress without steering and does not recheck the same Attempt", async () => {
    const requests: ModelRequest[] = []
    const events: QwenLoopJournalEvent[] = []
    const capture = artifactProbe([
      artifactState("a", 0),
      artifactState("b", 1),
    ])
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => repeatedReadModel(requests),
      workspaceArtifactProbe: capture,
      attemptBudget: { maxTurns: 5, maxActions: 4 },
      mutationProgressSteer: { afterActions: 1 },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const first = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "fix the parser" }],
        ["read"],
      ))
      expect((await first.json() as Record<string, any>).choices[0].message.tool_calls[0].id)
        .toBe("progress-read-1")
      const second = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the parser" },
        toolObservation(bridge, "progress-read-1", "artifact now exists"),
      ], ["read"]))
      expect((await second.json() as Record<string, any>).choices[0].message.tool_calls[0].id)
        .toBe("progress-read-2")
      const third = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the parser" },
        toolObservation(bridge, "progress-read-2", "continued inspection"),
      ], ["read"]))
      expect((await third.json() as Record<string, any>).choices[0].message.tool_calls[0].id)
        .toBe("progress-read-3")

      expect(requests.flatMap((request) => request.messages)
        .filter((message) => message.role === "control")).toEqual([])
      expect(events.filter((event) => event.event === "mutation_progress_checked"))
        .toEqual([expect.objectContaining({
          workActions: 1,
          artifactProgress: "advanced",
          intervention: "none",
        })])
      expect(capture.capture).toHaveBeenCalledTimes(2)
    } finally {
      await bridge.close()
    }
  })

  it("leaves read-only and below-threshold Attempts unintervened", async () => {
    const readOnlyRequests: ModelRequest[] = []
    const readOnlyCapture = vi.fn(async () => artifactState("a", 0))
    const readOnly = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => repeatedReadModel(readOnlyRequests),
      workspaceArtifactProbe: { capture: readOnlyCapture },
      attemptBudget: { maxTurns: 5, maxActions: 4 },
      mutationProgressSteer: { afterActions: 1 },
    })
    try {
      const first = await request(readOnly, codeRequest([{ role: "user", content: "inspect the parser" }]))
      const callId = (await first.json() as Record<string, any>).choices[0].message.tool_calls[0].id as string
      await request(readOnly, codeRequest([
        { role: "user", content: "inspect the parser" },
        toolObservation(readOnly, callId, "read-only evidence"),
      ]))
      expect(readOnlyCapture).not.toHaveBeenCalled()
      expect(readOnlyRequests[1]?.messages.some((message) => message.role === "control")).toBe(false)
    } finally {
      await readOnly.close()
    }

    const mutationRequests: ModelRequest[] = []
    const capture = artifactProbe([artifactState("a", 0)])
    const mutation = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => repeatedReadModel(mutationRequests),
      workspaceArtifactProbe: capture,
      attemptBudget: { maxTurns: 5, maxActions: 4 },
      mutationProgressSteer: { afterActions: 2 },
    })
    try {
      const first = await request(mutation, codeRequestWithTools(
        [{ role: "user", content: "fix the parser" }],
        ["read"],
      ))
      const callId = (await first.json() as Record<string, any>).choices[0].message.tool_calls[0].id as string
      await request(mutation, codeRequestWithTools([
        { role: "user", content: "fix the parser" },
        toolObservation(mutation, callId, "first investigation action"),
      ], ["read"]))
      expect(capture.capture).toHaveBeenCalledTimes(1)
      expect(mutationRequests[1]?.messages.some((message) => message.role === "control")).toBe(false)
    } finally {
      await mutation.close()
    }
  })

  it("steers conservatively when the progress probe is unavailable without journaling its error", async () => {
    const requests: ModelRequest[] = []
    const events: QwenLoopJournalEvent[] = []
    let captures = 0
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => repeatedReadModel(requests),
      workspaceArtifactProbe: {
        capture: vi.fn(async () => {
          captures += 1
          if (captures === 1) return artifactState("a", 0)
          throw new Error("private path and diff must stay hidden")
        }),
      },
      attemptBudget: { maxTurns: 5, maxActions: 4 },
      mutationProgressSteer: { afterActions: 1 },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const first = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "fix the parser" }],
        ["read"],
      ))
      const callId = (await first.json() as Record<string, any>).choices[0].message.tool_calls[0].id as string
      await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the parser" },
        toolObservation(bridge, callId, "diagnosis"),
      ], ["read"]))

      expect(requests[1]?.messages).toContainEqual(expect.objectContaining({
        role: "control",
        content: expect.stringContaining("could not verify a durable workspace artifact"),
      }))
      expect(events.find((event) => event.event === "mutation_progress_checked"))
        .toMatchObject({ artifactProgress: "unavailable", intervention: "steer" })
      expect(JSON.stringify(events)).not.toContain("private path")
    } finally {
      await bridge.close()
    }
  })

  it("uses task-bound evidence closure to validate and inspect after the work action guard", async () => {
    const modelRequests: ModelRequest[] = []
    const events: QwenLoopJournalEvent[] = []
    const verify = vi.fn(async () => ({ passed: true }))
    const model: ModelPort = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        modelRequests.push(structuredClone(request))
        if (request.turn === 1) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "closure-edit",
              name: "edit",
              arguments: { filePath: "src/rule.ts", oldString: "a", newString: "b" },
            },
          }
        } else if (request.turn === 2) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "closure-test",
              name: "bash",
              arguments: { command: "pnpm exec vitest src/rule.test.ts" },
            },
          }
        } else if (request.turn === 3) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "closure-diff",
              name: "bash",
              arguments: { command: "git diff --check && git status --short" },
            },
          }
        } else {
          yield { type: "text_delta", delta: "verified completion" }
        }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0 } }
        yield { type: "finish", reason: request.turn < 4 ? "tool_calls" : "stop" }
      },
    }
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => model,
      workspaceArtifactProbe: artifactProbe([
        artifactState("a", 0),
        artifactState("b", 1),
      ]),
      completionVerifier: { id: "artifact-bound-task-test", verify },
      attemptBudget: {
        maxTurns: 8,
        maxActions: 1,
        evidenceClosure: {
          maxTurns: 5,
          maxActions: 3,
          allowedToolNames: ["bash", "read", "todowrite"],
        },
      },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const edit = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "fix the rule" }],
        ["edit", "bash", "read", "todowrite"],
      ))
      expect((await edit.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "closure-edit", function: { name: "edit" } })

      const validation = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        {
          role: "tool",
          tool_call_id: "closure-edit",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "closure-edit",
            ok: true,
            content: "edited",
          }),
        },
      ], ["edit", "bash", "read", "todowrite"]))
      expect((await validation.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "closure-test", function: { name: "bash" } })

      const inspection = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        {
          role: "tool",
          tool_call_id: "closure-test",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "closure-test",
            ok: true,
            content: "tests passed",
          }),
        },
      ], ["edit", "bash", "read", "todowrite"]))
      expect((await inspection.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "closure-diff", function: { name: "bash" } })

      const completed = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        {
          role: "tool",
          tool_call_id: "closure-diff",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "closure-diff",
            ok: true,
            content: "diff clean",
          }),
        },
      ], ["edit", "bash", "read", "todowrite"]))

      expect(completed.status).toBe(200)
      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toBe("verified completion")
      expect(modelRequests[1]?.tools.map((tool) => tool.name)).toEqual(["bash", "read", "todowrite"])
      expect(modelRequests[1]?.messages.at(-1)).toMatchObject({
        role: "system",
        content: expect.stringContaining("no successful validation ran after the latest mutation"),
      })
      expect(modelRequests[2]?.messages.at(-1)).toMatchObject({
        role: "system",
        content: expect.stringContaining("no successful change inspection ran after the latest mutation"),
      })
      expect(events.find((event) => event.event === "attempt_finished")).toMatchObject({
        terminalState: "completion_proposed",
        turns: 4,
        actions: 3,
      })
      expect(events.find((event) => event.event === "evidence_closure_started")).toMatchObject({
        closureTrigger: "actions",
        workTurns: 1,
        workActions: 1,
      })
      expect(verify).toHaveBeenCalledOnce()
      expect(events.find((event) => event.event === "external_verification_completed"))
        .toMatchObject({ verifierId: "artifact-bound-task-test", passed: true })
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
    } finally {
      await bridge.close()
    }
  })

  it("blocks mutation-capable shell commands inside evidence closure before OpenCode executes them", async () => {
    const modelRequests: ModelRequest[] = []
    const unsafeClosureModel: ModelPort = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        modelRequests.push(structuredClone(request))
        if (request.turn === 1) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "unsafe-closure-edit",
              name: "edit",
              arguments: { filePath: "src/rule.ts", oldString: "a", newString: "b" },
            },
          }
        } else if (request.turn === 2) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "unsafe-closure-shell",
              name: "bash",
              arguments: { command: "sed -i '' 's/b/c/' src/rule.ts && pnpm test" },
            },
          }
        } else {
          yield { type: "text_delta", delta: "could not close evidence" }
        }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0 } }
        yield { type: "finish", reason: request.turn < 3 ? "tool_calls" : "stop" }
      },
    }
    const models = [unsafeClosureModel, ungroundedFinalModel("recovery still pending")]
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      workspaceArtifactProbe: artifactProbe([
        artifactState("a", 0),
        artifactState("b", 1),
        artifactState("b", 1),
      ]),
      attemptBudget: {
        maxTurns: 8,
        maxActions: 1,
        evidenceClosure: {
          maxTurns: 4,
          maxActions: 2,
          allowedToolNames: ["bash", "read", "todowrite"],
        },
      },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const edit = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "fix the rule" }],
        ["edit", "bash", "read", "todowrite"],
      ))
      expect((await edit.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "unsafe-closure-edit", function: { name: "edit" } })

      const pending = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        {
          role: "tool",
          tool_call_id: "unsafe-closure-edit",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "unsafe-closure-edit",
            ok: true,
            content: "edited",
          }),
        },
      ], ["edit", "bash", "read", "todowrite"]))

      expect(pending.status).toBe(200)
      expect((await pending.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE\./)
      expect(modelRequests[1]?.tools.map((tool) => tool.name)).toEqual(["bash", "read", "todowrite"])
      expect(events.flatMap((event) => event.event === "action_proposed" ? [event.action] : []))
        .toEqual(["edit"])
      expect(events.find((event) => event.event === "unit_finished")).toMatchObject({
        outcome: "verification_pending",
      })
    } finally {
      await bridge.close()
    }
  })

  it("turns an evidence gap into a checkpoint and clean recovery Attempt", async () => {
    const attemptIds = ["mutation-attempt", "recovery-attempt"]
    const models = [mutationThenFinalModel(), validationRecoveryModel()]
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      workspaceArtifactProbe: artifactProbe([
        artifactState("a", 0),
        artifactState("b", 1),
        artifactState("b", 1),
      ]),
      attemptBudget: {
        maxTurns: 8,
        maxActions: 1,
        evidenceClosure: {
          maxTurns: 3,
          maxActions: 2,
          allowedToolNames: ["bash"],
        },
      },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const started = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "change the code and verify it" }],
        ["write", "bash"],
      ))
      expect((await started.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "mutation-write", function: { name: "write" } })

      const recoveryValidation = await request(bridge, codeRequestWithTools([
        { role: "user", content: "change the code and verify it" },
        {
          role: "tool",
          tool_call_id: "mutation-write",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "mutation-write",
            ok: true,
            content: "file written",
          }),
        },
      ], ["write", "bash"]))
      expect((await recoveryValidation.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "recovery-test", function: { name: "bash" } })

      const recoveryInspection = await request(bridge, codeRequestWithTools([
        { role: "user", content: "change the code and verify it" },
        {
          role: "tool",
          tool_call_id: "recovery-test",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "recovery-test",
            ok: true,
            content: "tests passed",
          }),
        },
      ], ["write", "bash"]))
      expect((await recoveryInspection.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "recovery-diff", function: { name: "bash" } })

      const completed = await request(bridge, codeRequestWithTools([
        { role: "user", content: "change the code and verify it" },
        {
          role: "tool",
          tool_call_id: "recovery-diff",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "recovery-diff",
            ok: true,
            content: "diff inspected",
          }),
        },
      ], ["write", "bash"]))

      expect(completed.status).toBe(200)
      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toBe("work verified after recovery")
      expect(events.flatMap((event) => event.event === "attempt_started" ? [event.attemptId] : []))
        .toEqual(["mutation-attempt", "recovery-attempt"])
      expect(events.find((event) => event.event === "recovery_started")).toMatchObject({
        attemptId: "recovery-attempt",
        previousAttemptId: "mutation-attempt",
      })
      expect(events.flatMap((event) =>
        event.event === "evidence_closure_started" ? [event.attemptId] : []))
        .toEqual(["mutation-attempt", "recovery-attempt"])
      expect(events.flatMap((event) => event.event === "verification_completed" ? [event.passed] : []))
        .toEqual([false, true])
      expect(events.find((event) => event.event === "unit_finished" && event.outcome === "unit_verified"))
        .toMatchObject({
        event: "unit_finished",
        outcome: "unit_verified",
        attempts: 2,
      })
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
    } finally {
      await bridge.close()
    }
  })

  it("lets an independent completion verifier reject generic evidence and drive same-Unit recovery", async () => {
    const attemptIds = ["review-attempt", "review-recovery-attempt"]
    const recoveryRequests: ModelRequest[] = []
    const models = [
      groundedFinalModel("generic evidence says complete", "review-read"),
      externalVerifierRecoveryModel(recoveryRequests),
    ]
    const events: QwenLoopJournalEvent[] = []
    const verify = vi.fn(async (context: { attemptId: string }) =>
      context.attemptId === "review-attempt"
        ? {
            passed: false,
            guidance: "Add the zero-handle child-process regression before completing.",
          }
        : { passed: true })
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      completionVerifier: {
        id: "task-specific-child-process",
        verify,
      },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const started = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
      ]))
      expect((await started.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "review-read", function: { name: "read" } })

      const completed = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
        {
          role: "tool",
          tool_call_id: "review-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "review-read",
            ok: true,
            content: "README evidence",
          }),
        },
      ]))

      expect(completed.status).toBe(200)
      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toBe("task-specific repair verified")
      expect(verify).toHaveBeenCalledTimes(2)
      expect(verify.mock.calls.map(([context]) => context.attemptId)).toEqual([
        "review-attempt",
        "review-recovery-attempt",
      ])
      expect(recoveryRequests[0]?.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining(
          "Add the zero-handle child-process regression before completing.",
        ),
      })
      expect(events.flatMap((event) =>
        event.event === "external_verification_completed" ? [event.passed] : []))
        .toEqual([false, true])
      expect(events.find((event) => event.event === "recovery_started")).toMatchObject({
        attemptId: "review-recovery-attempt",
        previousAttemptId: "review-attempt",
      })
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
      expect(JSON.stringify(events)).not.toContain("zero-handle")
    } finally {
      await bridge.close()
    }
  })

  it("does not invoke the independent verifier when successful edits leave no durable Git artifact", async () => {
    const attemptIds = ["reverted-attempt", "reverted-recovery"]
    const mutationModel: ModelPort = {
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        if (request.turn === 1) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "reverted-edit",
              name: "edit",
              arguments: { filePath: "src/rule.ts", oldString: "a", newString: "b" },
            },
          }
        } else if (request.turn === 2) {
          yield {
            type: "tool_call",
            call: { toolCallId: "reverted-test", name: "bash", arguments: { command: "pnpm test" } },
          }
        } else if (request.turn === 3) {
          yield {
            type: "tool_call",
            call: {
              toolCallId: "reverted-diff",
              name: "bash",
              arguments: { command: "git diff --check && git status --short" },
            },
          }
        } else {
          yield { type: "text_delta", delta: "all evidence looks complete" }
        }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0 } }
        yield { type: "finish", reason: request.turn < 4 ? "tool_calls" : "stop" }
      },
    }
    const models = [mutationModel, ungroundedFinalModel("recovery still has no artifact")]
    const capture = vi.fn(async () => artifactState("a", 0))
    const verify = vi.fn(async () => ({ passed: true }))
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      workspaceArtifactProbe: { capture },
      completionVerifier: { id: "task-specific-test", verify },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const edit = await request(bridge, codeRequestWithTools(
        [{ role: "user", content: "fix the rule" }],
        ["edit", "bash"],
      ))
      expect((await edit.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "reverted-edit" })

      const validation = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        toolObservation(bridge, "reverted-edit", "edited then restored"),
      ], ["edit", "bash"]))
      expect((await validation.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "reverted-test" })

      const inspection = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        toolObservation(bridge, "reverted-test", "tests passed"),
      ], ["edit", "bash"]))
      expect((await inspection.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "reverted-diff" })

      const completed = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
        toolObservation(bridge, "reverted-diff", "working tree clean"),
      ], ["edit", "bash"]))

      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE\./)
      expect(capture).toHaveBeenCalledTimes(3)
      expect(verify).not.toHaveBeenCalled()
      expect(events.flatMap((event) =>
        event.event === "verification_completed" ? event.failedRequirements : []))
        .toContain("the requested mutation left no durable workspace artifact")
      expect(events.some((event) => event.event === "external_verification_completed")).toBe(false)
      expect(events.at(-1)).toMatchObject({ event: "unit_finished", outcome: "verification_pending" })
    } finally {
      await bridge.close()
    }
  })

  it("fails before the model call when the mutation Unit baseline cannot be bound", async () => {
    const modelFactory = vi.fn(() => ungroundedFinalModel("must not run"))
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory,
      workspaceArtifactProbe: {
        capture: vi.fn(async () => { throw new Error("private git failure") }),
      },
    })
    try {
      const response = await request(bridge, codeRequestWithTools([
        { role: "user", content: "fix the rule" },
      ], ["edit", "bash"]))
      const body = await response.text()

      expect(response.status).toBe(500)
      expect(body).toContain("artifact_baseline_unavailable")
      expect(body).not.toContain("private git failure")
      expect(modelFactory).not.toHaveBeenCalled()
    } finally {
      await bridge.close()
    }
  })

  it("defers the independent verifier until generic evidence is complete", async () => {
    const models = [
      ungroundedFinalModel("first ungrounded completion"),
      ungroundedFinalModel("second ungrounded completion"),
    ]
    const verify = vi.fn(async () => ({ passed: true }))
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      completionVerifier: { id: "task-specific-test", verify },
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const response = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
      ]))

      expect(response.status).toBe(200)
      expect((await response.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE\./)
      expect(verify).not.toHaveBeenCalled()
      expect(events.some((event) => event.event === "external_verification_completed")).toBe(false)
      expect(events.flatMap((event) =>
        event.event === "verification_completed" ? event.failedRequirements : []))
        .not.toContain("independent completion verifier did not return a verdict")
    } finally {
      await bridge.close()
    }
  })

  it("fails closed within a bound when the independent verifier never settles", async () => {
    const attemptIds = ["timeout-attempt", "timeout-recovery-attempt"]
    const models = [
      groundedFinalModel("first completion", "timeout-read"),
      ungroundedFinalModel("recovery completion"),
    ]
    const events: QwenLoopJournalEvent[] = []
    const verify = vi.fn(() => new Promise<never>(() => undefined))
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      completionVerifier: { id: "task-specific-timeout", verify },
      completionVerifierTimeoutMs: 5,
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const started = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
      ]))
      expect((await started.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "timeout-read", function: { name: "read" } })

      const completed = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
        {
          role: "tool",
          tool_call_id: "timeout-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "timeout-read",
            ok: true,
            content: "README evidence",
          }),
        },
      ]))

      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE\./)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(events.flatMap((event) =>
        event.event === "external_verification_completed" ? [event.passed] : []))
        .toEqual([false])
      expect(events.at(-1)).toMatchObject({ event: "unit_finished", outcome: "verification_pending" })
      expect(events.filter(event => event.event === "recovery_started")).toHaveLength(0)
      await bridge.close()
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", reason: "host_exit", verificationFailureCode: "verifier_timeout" })
    } finally {
      await bridge.close()
    }
  })

  it.each(["dependencies_changed", "dependency_mount_changed", "candidate_identity_mismatch", "unknown_secret_code"])("pauses on verifier exception %s without leaking thrown details or automatic recovery", async (code) => {
    const attemptIds = ["timeout-attempt", "timeout-recovery-attempt"]
    const models = [
      groundedFinalModel("first completion", "timeout-read"),
      ungroundedFinalModel("recovery completion"),
    ]
    const events: QwenLoopJournalEvent[] = []
    const verify = vi.fn(async () => { throw Object.assign(new Error("SECRET_PRIVATE_PATH_TOKEN"), { code }) })
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      completionVerifier: { id: "task-specific-timeout", verify },
      completionVerifierTimeoutMs: 1000,
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const started = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
      ]))
      expect((await started.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "timeout-read", function: { name: "read" } })

      const completed = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
        {
          role: "tool",
          tool_call_id: "timeout-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "timeout-read",
            ok: true,
            content: "README evidence",
          }),
        },
      ]))

      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE\./)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(events.flatMap((event) =>
        event.event === "external_verification_completed" ? [event.passed] : []))
        .toEqual([false])
      expect(events.at(-1)).toMatchObject({ event: "unit_finished", outcome: "verification_pending" })
      expect(events.filter(event => event.event === "recovery_started")).toHaveLength(0)
      expect(JSON.stringify(events)).not.toContain("SECRET_PRIVATE_PATH_TOKEN")
      expect(JSON.stringify(events)).not.toContain("unknown_secret_code")
      await bridge.close()
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", reason: "host_exit", verificationFailureCode: code === "unknown_secret_code" ? "verifier_exception" : code })
    } finally {
      await bridge.close()
    }
  })

  it("lets the next user message resume an open verification checkpoint", async () => {
    const attemptIds = ["attempt-one", "attempt-two", "attempt-three"]
    const models = [
      ungroundedFinalModel("first unverified final"),
      ungroundedFinalModel("second unverified final"),
      groundedFinalModel("verified after user direction", "resume-read"),
    ]
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const pending = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
      ]))
      expect((await pending.json() as Record<string, any>).choices[0].message.content)
        .toMatch(/^CHAOS HARNESS: VERIFICATION PENDING — THIS TASK IS NOT ACCEPTED AS COMPLETE\./)

      const resumed = await request(bridge, codeRequest([
        { role: "user", content: "inspect the repository" },
        { role: "assistant", content: "verification pending" },
        { role: "user", content: "continue and inspect README" },
      ]))
      expect((await resumed.json() as Record<string, any>).choices[0].message.tool_calls[0])
        .toMatchObject({ id: "resume-read", function: { name: "read" } })
      const completed = await request(bridge, codeRequest([
        { role: "user", content: "continue and inspect README" },
        {
          role: "tool",
          tool_call_id: "resume-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "resume-read",
            ok: true,
            content: "README evidence",
          }),
        },
      ]))
      expect((await completed.json() as Record<string, any>).choices[0].message.content)
        .toBe("verified after user direction")

      const attemptEvents = events.flatMap((event) => event.event === "attempt_started" ? [event] : [])
      expect(attemptEvents.map((event) => event.attemptId)).toEqual([
        "attempt-one",
        "attempt-two",
        "attempt-three",
      ])
      expect(new Set(attemptEvents.map((event) => event.missionId)).size).toBe(1)
      expect(new Set(attemptEvents.map((event) => event.unitId)).size).toBe(1)
      expect(events.filter((event) => event.event === "checkpoint_resolved")).toHaveLength(3)
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
    } finally {
      await bridge.close()
    }
  })

  it("preserves an authenticated OpenCode tool failure as a failed Kernel observation", async () => {
    const requests: ModelRequest[] = []
    const events: QwenLoopJournalEvent[] = []
    const observationToken = "observation-token-with-at-least-32-characters"
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => scriptedModel(requests),
      observationToken,
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      expect((await request(bridge, codeRequest([
        { role: "user", content: "Inspect README and report" },
      ]))).status).toBe(200)

      const error = "File not found: /workspace/missing.md"
      const encoded = encodeOpenCodeToolObservation({
        token: observationToken,
        toolCallId: "call-read",
        ok: false,
        content: error,
      })
      const completed = await request(bridge, codeRequest([
        { role: "user", content: "Inspect README and report" },
        { role: "tool", tool_call_id: "call-read", content: encoded },
      ]))

      expect(completed.status).toBe(200)
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-read",
        toolName: "read",
        ok: false,
        content: error,
      })
      expect(JSON.stringify(requests[1])).not.toContain("__CHAOS_TOOL_OBSERVATION_V1__")
      expect(events.find((event) => event.event === "action_observed")).toMatchObject({
        action: "read",
        ok: false,
      })
    } finally {
      await bridge.close()
    }
  })

  it("fails closed on a forged OpenCode tool error envelope", async () => {
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => scriptedModel([]),
      observationToken: "observation-token-with-at-least-32-characters",
    })
    try {
      expect((await request(bridge, codeRequest([
        { role: "user", content: "read" },
      ]))).status).toBe(200)

      const forged = await request(bridge, codeRequest([
        { role: "user", content: "read" },
        { role: "tool", tool_call_id: "call-read", content: "__CHAOS_TOOL_OBSERVATION_V1__:forged\nerror" },
      ]))
      expect(forged.status).toBe(400)
      expect(await forged.text()).toContain("invalid_observation_envelope")
    } finally {
      await bridge.close()
    }
  })

  it("fails closed when the OpenCode observation adapter is absent", async () => {
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => scriptedModel([]),
    })
    try {
      expect((await request(bridge, codeRequest([
        { role: "user", content: "read" },
      ]))).status).toBe(200)

      const untrusted = await request(bridge, codeRequest([
        { role: "user", content: "read" },
        { role: "tool", tool_call_id: "call-read", content: "plain host output" },
      ]))
      expect(untrusted.status).toBe(400)
      expect(await untrusted.text()).toContain("invalid_observation_envelope")
    } finally {
      await bridge.close()
    }
  })

  it("supports streaming tool calls without exposing the DashScope key", async () => {
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => scriptedModel([]),
    })
    try {
      const response = await request(bridge, { ...codeRequest([
        { role: "user", content: "read" },
      ]), stream: true })
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(body).toContain('"finish_reason":"tool_calls"')
      expect(body).toContain('"reasoning_content":"I should inspect README before answering."')
      expect(body).toContain('"completion_tokens_details":{"reasoning_tokens":2}')
      expect(body).toContain('"prompt_tokens_details":{"cached_tokens":6,"cache_creation_input_tokens":1}')
      expect(body).toContain('"name":"read"')
      expect(body.indexOf('"reasoning_content"')).toBeLessThan(body.indexOf('"tool_calls"'))
      expect(body).not.toContain("dashscope-secret")
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it("answers metadata locally without creating a Qwen Attempt", async () => {
    const modelFactory = vi.fn(() => scriptedModel([]))
    const events: QwenLoopJournalEvent[] = []
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory,
      recordEvent: async (event) => { events.push(event) },
    })
    try {
      const response = await request(bridge, {
        model: QWEN_LOOP_METADATA_MODEL_ID,
        messages: [{ role: "user", content: "A useful session title" }],
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: "A useful session title" } }],
      })
      expect(modelFactory).not.toHaveBeenCalled()
      expect(events).toEqual([])
    } finally {
      await bridge.close()
    }
  })

  it("starts a fresh Attempt for a later user message instead of replaying an old observation", async () => {
    const attemptIds = ["attempt-one", "attempt-two"]
    const models = [
      groundedFinalModel("first complete", "first-read"),
      groundedFinalModel("second complete", "second-read"),
    ]
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
      createAttemptId: () => attemptIds.shift()!,
    })
    try {
      const firstStart = await request(bridge, codeRequest([
        { role: "user", content: "first goal" },
      ]))
      expect((await firstStart.json() as Record<string, any>).choices[0].finish_reason).toBe("tool_calls")
      const first = await request(bridge, codeRequest([
        { role: "user", content: "first goal" },
        {
          role: "tool",
          tool_call_id: "first-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "first-read",
            ok: true,
            content: "first evidence",
          }),
        },
      ]))
      expect((await first.json() as Record<string, any>).choices[0].message.content).toBe("first complete")

      const secondStart = await request(bridge, codeRequest([
        { role: "user", content: "first goal" },
        { role: "assistant", content: "first complete" },
        { role: "user", content: "second goal" },
      ]))
      expect((await secondStart.json() as Record<string, any>).choices[0].finish_reason).toBe("tool_calls")
      const second = await request(bridge, codeRequest([
        { role: "user", content: "second goal" },
        {
          role: "tool",
          tool_call_id: "second-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "second-read",
            ok: true,
            content: "second evidence",
          }),
        },
      ]))
      expect(second.status).toBe(200)
      expect((await second.json() as Record<string, any>).choices[0].message.content).toBe("second complete")
    } finally {
      await bridge.close()
    }
  })

  it("fails closed for busy, mismatched, and observation-without-Attempt requests", async () => {
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => scriptedModel([]),
    })
    try {
      expect((await request(bridge, codeRequest([
        { role: "tool", tool_call_id: "orphan", content: "result" },
      ]))).status).toBe(409)

      expect((await request(bridge, codeRequest([
        { role: "user", content: "read" },
      ]))).status).toBe(200)

      const busy = await request(bridge, codeRequest([
        { role: "user", content: "a second prompt while waiting" },
      ]))
      expect(busy.status).toBe(409)
      expect(await busy.text()).toContain("attempt_busy")

      const mismatch = await request(bridge, codeRequest([
        { role: "user", content: "read" },
        { role: "tool", tool_call_id: "wrong-call", content: "result" },
      ]))
      expect(mismatch.status).toBe(409)
      expect(await mismatch.text()).toContain("observation_mismatch")
    } finally {
      await bridge.close()
    }
  })

  it("does not turn a model failure or unknown model into assistant success", async () => {
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => ({
        async *stream(): AsyncIterable<ModelStreamEvent> {
          throw new Error("provider echoed dashscope-secret")
        },
      }),
    })
    try {
      const unknown = await request(bridge, {
        model: "unknown",
        messages: [{ role: "user", content: "goal" }],
      })
      expect(unknown.status).toBe(400)

      const failed = await request(bridge, codeRequest([
        { role: "user", content: "goal" },
      ]))
      const body = await failed.text()
      expect(failed.status).toBe(422)
      expect(body).toContain("attempt_model_error")
      expect(body).not.toContain("dashscope-secret")
      expect(body).not.toContain("assistant")
    } finally {
      await bridge.close()
    }
  })

  it.each(["length", "content_filter", "error"] as const)("records %s termination without content or automatic redispatch", async (reason) => {
    const events: QwenLoopJournalEvent[] = []
    let calls = 0
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      recordEvent: async event => { events.push(event) },
      modelFactory: () => ({
        async *stream(): AsyncIterable<ModelStreamEvent> {
          calls++
          yield { type: "reasoning_delta", delta: "private reasoning sentinel" }
          yield { type: "text_delta", delta: "private text sentinel" }
          yield { type: "usage", usage: { inputTokens: 12, outputTokens: 32000, reasoningTokens: 31999, cost: 0 } }
          yield { type: "finish", reason }
        },
      }),
    })
    try {
      const body = codeRequest([{ role: "user", content: "inspect the repository" }])
      const stopped = await request(bridge, body)
      expect(stopped.status).toBe(422)
      expect(await stopped.text()).toContain("attempt_model_incomplete")
      // Native host retries of the terminal request must preserve the same failure.
      const retry = await request(bridge, body)
      expect(retry.status).toBe(422)
      expect(await retry.text()).toContain("attempt_model_incomplete")
      expect(calls).toBe(1)
      expect(events.filter(event => event.event === "attempt_finished")).toEqual([
        expect.objectContaining({ terminalState: "stopped", stopReason: "model_incomplete",
          modelTermination: { finishReason: reason, turn: 1, inputTokens: 12, outputTokens: 32000, reasoningTokens: 31999 },
        }),
      ])
      expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "cancelled" })
      expect(JSON.stringify(events)).not.toContain("private reasoning sentinel")
      expect(JSON.stringify(events)).not.toContain("private text sentinel")
    } finally {
      await bridge.close()
    }
  })

  it.each([true, false])("bounds length recovery across a Unit and retains external verification (accepted=%s)", async accepted => {
    const events: QwenLoopJournalEvent[] = [], requests: ModelRequest[] = []
    let attempts = 0
    const verify = vi.fn(async () => ({ passed: accepted }))
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace", profile: profile(), modelLengthRecovery: "once-per-unit",
      attemptBudget: { maxTurns: 8, maxActions: 4 },
      recordEvent: async e => { events.push(e) },
      completionVerifier: { id: "independent-length-gate", verify },
      modelFactory: () => {
        const attempt = ++attempts
        return { async *stream(r): AsyncIterable<ModelStreamEvent> {
          requests.push(structuredClone(r))
          if (r.turn === 1) {
            yield { type: "reasoning_delta", delta: "truncated private reasoning" }
            yield { type: "usage", usage: { inputTokens: 12, outputTokens: 32000, reasoningTokens: 32000, cost: 0, cacheReadTokens: 4 } }
            yield { type: "finish", reason: "length" }
          } else if (r.turn === 2) {
            yield { type: "tool_call", call: { toolCallId: "length-read", name: "read", arguments: { filePath: "README.md" } } }
            yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, cost: 0, cacheReadTokens: 1 } }
            yield { type: "finish", reason: "tool_calls" }
          } else {
            yield { type: "text_delta", delta: `inspection complete ${attempt}` }
            yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0 } }
            yield { type: "finish", reason: "stop" }
          }
        } }
      },
    })
    try {
      const goal = "Read README and report the project purpose"
      const first = await request(bridge, codeRequest([{ role: "user", content: goal }]))
      expect(first.status).toBe(200)
      const body = await first.json() as Record<string, any>
      expect(body.usage).toMatchObject({ prompt_tokens: 15, completion_tokens: 32002,
        completion_tokens_details: { reasoning_tokens: 32000 }, prompt_tokens_details: { cached_tokens: 5 } })
      expect(body.choices[0].message.tool_calls[0].id).toBe("length-read")
      const done = await request(bridge, codeRequest([{ role: "user", content: goal }, {
        role: "tool", tool_call_id: "length-read", content: encodeOpenCodeToolObservation({
          token: bridge.observationToken, toolCallId: "length-read", ok: true, content: "# Project purpose",
        }),
      }]))
      expect(verify).toHaveBeenCalledTimes(1)
      expect(events.filter(e => e.event === "model_length_recovery_started")).toHaveLength(1)
      expect(JSON.stringify(events)).not.toContain("truncated private reasoning")
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("truncated private reasoning")
      if (accepted) {
        expect(done.status).toBe(200)
        expect(attempts).toBe(1)
        expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "succeeded" })
        expect(events.find(e => e.event === "attempt_finished")).toMatchObject({ turns: 3, actions: 1, outputTokens: 32003 })
      } else {
        // A clean recovery Attempt must not replenish the Unit's length allowance.
        expect(done.status).toBe(422)
        expect(await done.text()).toContain("attempt_model_incomplete")
        expect(attempts).toBe(2)
        expect(requests).toHaveLength(4)
        expect(events.at(-1)).toMatchObject({ event: "mission_finished", outcome: "cancelled" })
      }
    } finally { await bridge.close() }
  })

  it("ends an already-started reasoning stream with a sanitized error instead of success", async () => {
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => ({
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield { type: "reasoning_delta", delta: "partial reasoning" }
          throw new Error("provider echoed dashscope-secret")
        },
      }),
    })
    try {
      const failed = await request(bridge, {
        ...codeRequest([{ role: "user", content: "goal" }]),
        stream: true,
      })
      const body = await failed.text()
      expect(failed.status).toBe(200)
      expect(body).toContain('"reasoning_content":"partial reasoning"')
      expect(body).toContain('"code":"attempt_model_error"')
      expect(body).not.toContain("dashscope-secret")
      expect(body).not.toContain('"finish_reason":"stop"')
    } finally {
      await bridge.close()
    }
  })

  it("aborts and releases the active Attempt when the OpenCode request disconnects", async () => {
    let started = false
    let observedAbort = false
    const models: ModelPort[] = [
      {
        async *stream(_request, signal): AsyncIterable<ModelStreamEvent> {
          started = true
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
            observedAbort = true
            resolve()
          }, { once: true }))
          throw signal.reason
        },
      },
      groundedFinalModel("replacement attempt complete", "replacement-read"),
    ]
    const bridge = await startOpenCodeQwenLoopBridge({
      workspaceRoot: "/workspace",
      profile: profile(),
      modelFactory: () => models.shift()!,
    })
    try {
      const controller = new AbortController()
      const pending = fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(codeRequest([{ role: "user", content: "wait" }])),
        signal: controller.signal,
      }).catch(() => undefined)
      await vi.waitFor(() => expect(started).toBe(true))
      controller.abort()
      await pending
      await vi.waitFor(() => expect(observedAbort).toBe(true))

      const replacementStart = await request(bridge, codeRequest([
        { role: "user", content: "new attempt" },
      ]))
      expect(replacementStart.status).toBe(200)
      expect((await replacementStart.json() as Record<string, any>).choices[0].finish_reason).toBe("tool_calls")
      const replacement = await request(bridge, codeRequest([
        { role: "user", content: "new attempt" },
        {
          role: "tool",
          tool_call_id: "replacement-read",
          content: encodeOpenCodeToolObservation({
            token: bridge.observationToken,
            toolCallId: "replacement-read",
            ok: true,
            content: "replacement evidence",
          }),
        },
      ]))
      expect(replacement.status).toBe(200)
      expect((await replacement.json() as Record<string, any>).choices[0].message.content)
        .toBe("replacement attempt complete")
    } finally {
      await bridge.close()
    }
  })
})

function profile() {
  return {
    apiKey: "dashscope-secret",
    baseUrl: "https://dashscope.example.test/v1",
    model: "qwen3.8-max",
  }
}

function artifactState(seed: string, changedPathCount: number): {
  available: true
  digest: string
  changedPathCount: number
} {
  return {
    available: true,
    digest: `sha256:${seed.repeat(64)}`,
    changedPathCount,
  }
}

function artifactProbe(states: Array<ReturnType<typeof artifactState>>) {
  return {
    capture: vi.fn(async () => {
      const state = states.shift()
      if (state === undefined) throw new Error("unexpected artifact capture")
      return state
    }),
  }
}

function toolObservation(
  bridge: OpenCodeQwenLoopBridge,
  toolCallId: string,
  content: string,
) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: encodeOpenCodeToolObservation({
      token: bridge.observationToken,
      toolCallId,
      ok: true,
      content,
    }),
  }
}

function scriptedModel(requests: ModelRequest[]): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(request)
      if (request.turn === 1) {
        yield { type: "reasoning_delta", delta: "I should inspect README before answering." }
        yield {
          type: "tool_call",
          call: {
            toolCallId: "call-read",
            name: "read",
            arguments: { filePath: "README.md" },
          },
        }
        yield {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 2,
            cacheReadTokens: 6,
            cacheWriteTokens: 1,
            cost: 0,
          },
        }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      yield { type: "reasoning_delta", delta: "The observation is sufficient for a concise report." }
      yield { type: "text_delta", delta: "README was inspected through the Chaos Loop." }
      yield {
        type: "usage",
        usage: {
          inputTokens: 15,
          outputTokens: 7,
          reasoningTokens: 3,
          cacheReadTokens: 12,
          cacheWriteTokens: 0,
          cost: 0,
        },
      }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function groundedFinalModel(text: string, toolCallId: string): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      if (request.turn === 1) {
        yield {
          type: "tool_call",
          call: { toolCallId, name: "read", arguments: { filePath: "README.md" } },
        }
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0 } }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      yield { type: "text_delta", delta: text }
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function ungroundedFinalModel(text: string): ModelPort {
  return {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: text }
      yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function externalVerifierRecoveryModel(requests: ModelRequest[]): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(request)
      yield { type: "text_delta", delta: "task-specific repair verified" }
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function longReadModel(toolTurns: number): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      if (request.turn <= toolTurns) {
        yield {
          type: "tool_call",
          call: {
            toolCallId: `long-read-${request.turn}`,
            name: "read",
            arguments: { filePath: `file-${request.turn}.txt` },
          },
        }
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0 } }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      yield { type: "text_delta", delta: "inspection complete" }
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function readThenFinalModel(
  requests: ModelRequest[],
  prefix: string,
): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(structuredClone(request))
      if (request.turn === 1) {
        yield {
          type: "tool_call",
          call: {
            toolCallId: `${prefix}-read`,
            name: "read",
            arguments: { filePath: "src/parser.ts" },
          },
        }
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0 } }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      yield { type: "text_delta", delta: "diagnosis only" }
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function repeatedReadModel(requests: ModelRequest[]): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(structuredClone(request))
      yield {
        type: "tool_call",
        call: {
          toolCallId: `progress-read-${request.turn}`,
          name: "read",
          arguments: { filePath: `src/file-${request.turn}.ts` },
        },
      }
      yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, cost: 0 } }
      yield { type: "finish", reason: "tool_calls" }
    },
  }
}

function mutationThenFinalModel(): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      if (request.turn === 1) {
        yield {
          type: "tool_call",
          call: {
            toolCallId: "mutation-write",
            name: "write",
            arguments: { filePath: "src/new.ts", content: "export {}" },
          },
        }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0 } }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      yield { type: "text_delta", delta: "unverified completion" }
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function validationRecoveryModel(): ModelPort {
  return {
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      if (request.turn === 1) {
        expect(request.messages[0]).toMatchObject({
          role: "system",
          content: expect.stringContaining("verification checkpoint did not accept"),
        })
        yield {
          type: "tool_call",
          call: { toolCallId: "recovery-test", name: "bash", arguments: { command: "pnpm test" } },
        }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, cost: 0 } }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      if (request.turn === 2) {
        yield {
          type: "tool_call",
          call: {
            toolCallId: "recovery-diff",
            name: "bash",
            arguments: { command: "git diff --check && git status --short" },
          },
        }
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cost: 0 } }
        yield { type: "finish", reason: "tool_calls" }
        return
      }
      yield { type: "text_delta", delta: "work verified after recovery" }
      yield { type: "usage", usage: { inputTokens: 6, outputTokens: 2, cost: 0 } }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function codeRequest(messages: unknown[]) {
  return codeRequestWithTools(messages, ["read"])
}

function codeRequestWithTools(messages: unknown[], toolNames: readonly string[]) {
  return {
    model: QWEN_LOOP_MODEL_ID,
    stream: false,
    messages,
    tools: toolNames.map((name) => ({
      type: "function",
      function: {
        name,
        description: `${name} workspace tool`,
        parameters: {
          type: "object",
          additionalProperties: true,
        },
      },
    })),
  }
}

async function request(bridge: OpenCodeQwenLoopBridge, body: unknown): Promise<Response> {
  return await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}
