/** One caller-owned clock for the whole execution, including recovery and verification. */
export class ExecutionDeadline {
  readonly deadlineAtMs: number
  readonly closureWindowMs: number
  readonly signal: AbortSignal
  readonly #timer: ReturnType<typeof setTimeout>

  constructor(options: { deadlineAtMs: number; closureWindowMs: number }) {
    const remaining = options.deadlineAtMs - Date.now()
    if (!Number.isSafeInteger(options.deadlineAtMs) || !Number.isSafeInteger(options.closureWindowMs) ||
        options.closureWindowMs < 1 || remaining <= options.closureWindowMs || remaining > 2_147_483_647) {
      throw new TypeError("Execution deadline requires a future bounded deadline and a smaller positive closure window")
    }
    this.deadlineAtMs = options.deadlineAtMs
    this.closureWindowMs = options.closureWindowMs
    const controller = new AbortController()
    this.signal = controller.signal
    this.#timer = setTimeout(() => controller.abort(new Error("deadline_exceeded")), remaining)
    this.#timer.unref?.()
    Object.freeze(this)
  }

  get remainingMs(): number { return this.signal.aborted ? 0 : Math.max(0, this.deadlineAtMs - Date.now()) }
  get expired(): boolean { return this.remainingMs === 0 }
  get closing(): boolean { return this.remainingMs <= this.closureWindowMs }
  dispose(): void { clearTimeout(this.#timer) }
}
