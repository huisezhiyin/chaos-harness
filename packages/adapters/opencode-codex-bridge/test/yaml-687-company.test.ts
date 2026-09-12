import { expect, it, vi } from "vitest"
import { main } from "../src/yaml-687-company-dogfood.js"
import { YAML_DELIVERY_V2_ROOT } from "../src/yaml-687-delivery-v2-dogfood.js"
import { YAML_687_ATTEMPT_BUDGET } from "../src/yaml-687-dogfood.js"
import { YAML_687_P81_POLICY } from "../src/yaml-687-p81-dogfood.js"

it("binds company continuation to v2 and keeps its verifier, budget and capture launcher", async () => {
  const baseline = vi.fn(async (root: string) => root), dailyCli = vi.fn(async () => 0)
  expect(await main(["--check-profile"], { baseline, dailyCli })).toBe(0)
  expect(baseline).toHaveBeenCalledWith(YAML_DELIVERY_V2_ROOT)
  expect(dailyCli).toHaveBeenCalledWith(["--root", YAML_DELIVERY_V2_ROOT, "--check-profile", "--qwen", "company"], expect.objectContaining({
    attemptBudget: YAML_687_ATTEMPT_BUDGET, progressPolicy: YAML_687_P81_POLICY,
    completionVerifier: expect.objectContaining({ id: "yaml-687-source-and-delivery-v1" }), qwenLauncher: expect.any(Function),
  }))
})

it("rejects override and changed artifacts before daily launch", async () => {
  const dailyCli = vi.fn(), stderr = vi.fn()
  expect(await main(["--root", "/other"], { dailyCli, stderr })).toBe(2)
  expect(await main([], { baseline: async () => { throw new Error("changed") }, dailyCli, stderr })).toBe(2)
  expect(dailyCli).not.toHaveBeenCalled()
})
