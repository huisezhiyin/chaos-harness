/** Explicit total allowance shared by all Attempts of one Unit. No refunds on failure. */
export interface UnitBudgetLimits { maxTurns: number; maxActions: number }
export interface UnitBudgetSnapshot extends UnitBudgetLimits {
  turns: number; actions: number; remainingTurns: number; remainingActions: number
}
export class UnitBudget {
  readonly #limits: Readonly<UnitBudgetLimits>
  #turns = 0
  #actions = 0
  constructor(limits: UnitBudgetLimits) {
    for (const value of [limits.maxTurns, limits.maxActions]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Unit budget limits must be positive safe integers")
    }
    this.#limits = Object.freeze({ ...limits })
  }
  hasCapacity(resource: "turns" | "actions"): boolean {
    return resource === "turns" ? this.#turns < this.#limits.maxTurns : this.#actions < this.#limits.maxActions
  }
  consume(resource: "turns" | "actions"): boolean {
    if (!this.hasCapacity(resource)) return false
    if (resource === "turns") this.#turns++
    else this.#actions++
    return true
  }
  snapshot(): UnitBudgetSnapshot {
    return { ...this.#limits, turns: this.#turns, actions: this.#actions,
      remainingTurns: this.#limits.maxTurns - this.#turns, remainingActions: this.#limits.maxActions - this.#actions }
  }
}
