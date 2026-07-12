import { expect } from "chai"
import { buildDeploySteps, remainingSteps, type GrantStep, type ProxyStep } from "../scripts/deploy-plan"
import {
  normalizeRegistry,
  recordProxyDeployment,
  recordRoleGrant,
} from "../scripts/deploy-registry"

describe("resumable GIWA deployment plan", () => {
  it("skips proxy deployments and grants already recorded in a partial registry", () => {
    const deployer = address(1)
    const registry = normalizeRegistry({}, deployer, "abc123")
    const steps = buildDeploySteps()
    const assetStep = steps.find((step): step is ProxyStep => step.key === "proxy:asset:tUSDC" && step.type === "proxy")
    const grantStep = steps.find(
      (step): step is GrantStep => step.key === "grant:proxy:asset:tUSDC:MINTER_ROLE:proxy:faucet" && step.type === "grant",
    )
    if (!assetStep || !grantStep) throw new Error("expected test steps to exist")

    recordProxyDeployment(registry, assetStep, {
      proxy: address(2),
      implementation: address(3),
      bytecodeHash: hash(4),
      deployTxHash: hash(5),
      blockNumber: 42,
    })
    recordRoleGrant(registry, {
      key: grantStep.key,
      role: grantStep.role,
      roleHash: hash(6),
      target: address(2),
      targetKey: grantStep.targetKey,
      grantee: address(7),
      granteeKey: grantStep.granteeKey,
      txHash: hash(8),
      blockNumber: 43,
      status: "confirmed",
    })

    const remaining = remainingSteps(registry, steps).map((step) => step.key)
    expect(remaining).not.to.include(assetStep.key)
    expect(remaining).not.to.include(grantStep.key)
    expect(remaining).to.include("proxy:asset:tBTC")
    expect(registry.assets.find((asset) => asset.symbol === "tUSDC")?.contract.proxy).to.equal(address(2))
    expect(registry.deploymentBlock).to.equal(42)
  })
})

function address(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, "0")}`
}

function hash(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(64, "0")}`
}
