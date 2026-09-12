import { ids, type AttemptControlId } from "../contracts/ids.js"
import type {
  AttemptBoundaryControl,
  AttemptCancelControl,
  AttemptSteerControl,
  AttemptStopAfterTurnControl,
} from "./contracts.js"
import type { AttemptControlPort } from "./ports.js"

export class AttemptController implements AttemptControlPort {
  readonly #abortController = new AbortController()
  readonly #pending: AttemptBoundaryControl[] = []
  #sequence = 0
  #cancellation?: AttemptCancelControl

  get signal(): AbortSignal {
    return this.#abortController.signal
  }

  get cancellation(): AttemptCancelControl | undefined {
    return this.#cancellation
  }

  steer(content: string): AttemptSteerControl {
    this.#assertOpen()
    const normalizedContent = nonEmpty(content, "steer content")
    const control: AttemptSteerControl = Object.freeze({
      controlId: this.#nextId(),
      kind: "steer",
      content: normalizedContent,
    })
    this.#pending.push(control)
    return control
  }

  stopAfterTurn(reason = "stop requested after current turn"): AttemptStopAfterTurnControl {
    this.#assertOpen()
    const normalizedReason = nonEmpty(reason, "stop reason")
    const control: AttemptStopAfterTurnControl = Object.freeze({
      controlId: this.#nextId(),
      kind: "stop_after_turn",
      reason: normalizedReason,
    })
    this.#pending.push(control)
    return control
  }

  cancel(reason = "attempt cancelled"): AttemptCancelControl {
    if (this.#cancellation !== undefined) {
      return this.#cancellation
    }

    const normalizedReason = nonEmpty(reason, "cancel reason")
    const control: AttemptCancelControl = Object.freeze({
      controlId: this.#nextId(),
      kind: "cancel",
      reason: normalizedReason,
    })
    this.#cancellation = control
    this.#abortController.abort(control)
    return control
  }

  drain(): readonly AttemptBoundaryControl[] {
    return this.#pending.splice(0)
  }

  #nextId(): AttemptControlId {
    this.#sequence += 1
    return ids.attemptControl(`attempt-control-${this.#sequence}`)
  }

  #assertOpen(): void {
    if (this.#cancellation !== undefined) {
      throw new Error("attempt controller is cancelled")
    }
  }
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
  return value
}
