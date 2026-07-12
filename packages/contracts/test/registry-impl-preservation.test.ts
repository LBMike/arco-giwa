import { expect } from "chai"
import { normalizeRegistry } from "../scripts/deploy-registry"
import type { ExtendedProductPlan } from "../scripts/deploy-plan"

// Regression guard for the normalizeRegistry impl-clobber bug.
//
// Invariant: products[]/assets[]/faucet are the source of truth for the CURRENT
// implementation (the upgrade + sync scripts write the live on-chain impl there
// post-deploy). deploymentRecords[] is the immutable deploy-time log. loadRegistry/
// normalizeRegistry re-applies every record on load and must NEVER revert a synced
// products[] impl back to the deploy-time record value — the bug that reverted all 6
// built-in ProductToken + DepositVault custody references during the bEQTY deploy.
describe("registry normalize preserves synced implementations", () => {
  const deployer = address(1)
  const PROXY_PT = address(0x11)
  const PROXY_DV = address(0x22)
  const UPGRADED_PT = address(0xaaaa) // current on-chain impl (e.g. ProductToken V2)
  const DEPLOYTIME_PT = address(0xbbbb) // original deploy-time impl kept in the record
  const UPGRADED_DV = address(0xcccc) // current on-chain impl (e.g. DepositVault withdrawTo)
  const DEPLOYTIME_DV = address(0xdddd)
  const HASH_UPGRADED_PT = hash(0xa1)
  const HASH_UPGRADED_DV = hash(0xc1)

  const products: ExtendedProductPlan[] = [
    { productId: "acapix", symbol: "aCAPIX", name: "Arco CAPIX", paymentAssetSymbol: "tUSDC" },
  ]

  // A registry file whose products[] carry UPGRADED impls while the deploy-time
  // deploymentRecords still carry the ORIGINAL impls (exactly the on-disk shape after an
  // upgrade sync that leaves the historical records untouched).
  function existingRegistry() {
    return {
      products: [
        {
          productId: "acapix",
          symbol: "aCAPIX",
          name: "Arco CAPIX",
          paymentAssetSymbol: "tUSDC",
          productToken: { proxy: PROXY_PT, implementation: UPGRADED_PT, bytecodeHash: HASH_UPGRADED_PT, blockNumber: 100 },
          // upgrade scripts write the upgrade block here too — must survive normalize.
          depositVault: { proxy: PROXY_DV, implementation: UPGRADED_DV, bytecodeHash: HASH_UPGRADED_DV, blockNumber: 900 },
          redemptionVault: { proxy: null, implementation: null, bytecodeHash: null },
          priceFeed: { proxy: null, implementation: null, bytecodeHash: null },
          deploymentBlock: 100,
          activationFlags: {},
        },
      ],
      deploymentRecords: [
        {
          key: "proxy:product:acapix:productToken",
          logicalLabel: "aCAPIX",
          contractName: "ProductToken",
          proxy: PROXY_PT,
          implementation: DEPLOYTIME_PT,
          bytecodeHash: hash(0xb1),
          deployTxHash: hash(0x1),
          blockNumber: 100,
        },
        {
          key: "proxy:product:acapix:depositVault",
          logicalLabel: "aCAPIX-deposit-vault",
          contractName: "ArcoDepositVault",
          proxy: PROXY_DV,
          implementation: DEPLOYTIME_DV,
          bytecodeHash: hash(0xd1),
          deployTxHash: hash(0x2),
          blockNumber: 101,
        },
      ],
    } as any
  }

  it("keeps the upgraded products[] ProductToken impl, not the deploy-time record impl", () => {
    const reg = normalizeRegistry(existingRegistry(), deployer, "commit", "cancun", products)
    const token = reg.products.find((p) => p.productId === "acapix")!.productToken
    expect(token.implementation).to.equal(UPGRADED_PT)
    expect(token.bytecodeHash).to.equal(HASH_UPGRADED_PT)
    // the deploy-time record itself stays untouched (historical log)
    const record = reg.deploymentRecords.find((r) => r.key === "proxy:product:acapix:productToken")!
    expect(record.implementation).to.equal(DEPLOYTIME_PT)
  })

  it("keeps the upgraded products[] DepositVault impl, not the deploy-time record impl", () => {
    const reg = normalizeRegistry(existingRegistry(), deployer, "commit", "cancun", products)
    const vault = reg.products.find((p) => p.productId === "acapix")!.depositVault
    expect(vault.implementation).to.equal(UPGRADED_DV)
    expect(vault.bytecodeHash).to.equal(HASH_UPGRADED_DV)
    // the synced upgrade block must be kept, not reverted to the record's deploy block (101)
    expect((vault as { blockNumber?: number }).blockNumber).to.equal(900)
  })

  it("still adopts the record impl for a slot with no synced impl yet (fresh deploy / cold load)", () => {
    const existing = existingRegistry()
    existing.deploymentRecords.push({
      key: "proxy:product:acapix:redemptionVault",
      logicalLabel: "aCAPIX-redemption-vault",
      contractName: "ArcoRedemptionVault",
      proxy: address(0x33),
      implementation: address(0xeeee),
      bytecodeHash: hash(0xe1),
      deployTxHash: hash(0x3),
      blockNumber: 102,
    })
    const reg = normalizeRegistry(existing, deployer, "commit", "cancun", products)
    const vault = reg.products.find((p) => p.productId === "acapix")!.redemptionVault
    expect(vault.implementation).to.equal(address(0xeeee))
    expect(vault.proxy).to.equal(address(0x33))
  })
})

function address(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, "0")}`
}

function hash(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(64, "0")}`
}
