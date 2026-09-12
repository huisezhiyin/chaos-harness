import type {
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  PermissionDecision,
  PermissionPort,
  ToolObservation,
  ToolPort,
  ToolProposal,
} from "../../src/index.js"

export class ScriptedModelPort implements ModelPort {
  readonly requests: ModelRequest[] = []
  readonly #scripts: ModelStreamEvent[][]

  constructor(scripts: readonly (readonly ModelStreamEvent[])[]) {
    this.#scripts = scripts.map((script) => [...script])
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    const script = this.#scripts.shift()
    if (script === undefined) {
      throw new Error("No scripted model response")
    }

    for (const event of script) {
      if (signal.aborted) {
        return
      }
      yield event
    }
  }
}

export class ScriptedToolPort implements ToolPort {
  readonly proposals: ToolProposal[] = []
  readonly #handler: (proposal: ToolProposal) => ToolObservation | Promise<ToolObservation>

  constructor(
    handler: (proposal: ToolProposal) => ToolObservation | Promise<ToolObservation>,
  ) {
    this.#handler = handler
  }

  async execute(proposal: ToolProposal, signal: AbortSignal): Promise<ToolObservation> {
    if (signal.aborted) {
      throw new Error("aborted")
    }
    this.proposals.push(structuredClone(proposal))
    return this.#handler(proposal)
  }
}

export class ScriptedPermissionPort implements PermissionPort {
  readonly proposals: ToolProposal[] = []
  readonly #handler: (proposal: ToolProposal) => PermissionDecision | Promise<PermissionDecision>

  constructor(
    handler: (proposal: ToolProposal) => PermissionDecision | Promise<PermissionDecision>,
  ) {
    this.#handler = handler
  }

  async evaluate(proposal: ToolProposal, signal: AbortSignal): Promise<PermissionDecision> {
    if (signal.aborted) {
      throw new Error("aborted")
    }
    this.proposals.push(structuredClone(proposal))
    return this.#handler(proposal)
  }
}

export const allowAll = (): ScriptedPermissionPort =>
  new ScriptedPermissionPort(() => ({ outcome: "allow" }))
