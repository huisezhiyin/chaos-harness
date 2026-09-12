import type { HostAttemptRequest, HostAttemptResult, HostCapability } from "./contracts.js"

export interface HostAttemptPort {
  readonly capabilities: readonly HostCapability[]
  run(request: HostAttemptRequest, signal?: AbortSignal): Promise<HostAttemptResult>
}
