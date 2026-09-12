import { describe, expect, it, vi } from "vitest"
import { main, YAML_DELIVERY_V2_ROOT } from "../src/yaml-687-delivery-v2-dogfood.js"
import { validateYamlDeliveryIdentity, YAML_DELIVERY_ROOT } from "../src/yaml-687-delivery.js"
import { YAML_687_FIXED_HEAD } from "../src/yaml-687-verifier.js"

function fixture() { return { baseline: vi.fn(async () => YAML_DELIVERY_V2_ROOT), dailyCli: vi.fn(async () => 0),
  qualifier: vi.fn(async () => ({ passed: true, failedChecks: [] })), stdout: vi.fn(), stderr: vi.fn() } }
describe("isolated v2 coding regression", () => {
  it("retains the historical exact-root guard while binding the new trusted root", () => {
    const identity = { root: YAML_DELIVERY_V2_ROOT, gitRoot: YAML_DELIVERY_V2_ROOT, head: YAML_687_FIXED_HEAD, origin: "https://github.com/eemeli/yaml.git" }
    expect(() => validateYamlDeliveryIdentity(identity)).toThrow()
    expect(() => validateYamlDeliveryIdentity(identity, YAML_DELIVERY_V2_ROOT)).not.toThrow()
    expect(() => validateYamlDeliveryIdentity({ ...identity, root: YAML_DELIVERY_ROOT }, YAML_DELIVERY_V2_ROOT)).toThrow()
    expect(() => validateYamlDeliveryIdentity({ ...identity, head: "wrong" }, YAML_DELIVERY_V2_ROOT)).toThrow()
  })
  it("qualifies without launching a provider", async () => {
    const d = fixture(); expect(await main(["--qualify-only"], d)).toBe(0)
    expect(d.qualifier).toHaveBeenCalledTimes(1); expect(d.dailyCli).not.toHaveBeenCalled()
  })
  it("pins the new root, Token Switch, verifier and capture-enabled launcher", async () => {
    const d = fixture(); expect(await main([], d)).toBe(0)
    expect(d.dailyCli).toHaveBeenCalledWith(["--root", YAML_DELIVERY_V2_ROOT, "--token-switch"], expect.objectContaining({
      qwenLauncher: expect.any(Function), completionVerifier: expect.objectContaining({ id: "yaml-687-source-and-delivery-v1" }),
    }))
  })
  it("rejects overrides and dirty baselines before any provider launch", async () => {
    const d = fixture(); expect(await main(["--root", "/other"], d)).toBe(2)
    d.baseline.mockRejectedValue(new Error("dirty")); expect(await main([], d)).toBe(2)
    expect(d.dailyCli).not.toHaveBeenCalled()
  })
})
