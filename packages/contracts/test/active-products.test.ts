import { expect } from "chai"
import {
  PRODUCTS,
  buildDeploySteps,
  mergeActiveProducts,
  registryExtraProducts,
  remainingSteps,
  type ExtendedProductPlan,
  type ProxyStep,
} from "../scripts/deploy-plan"
import { normalizeRegistry, recordProxyDeployment, recordRoleGrant } from "../scripts/deploy-registry"
import { parseExtraProducts } from "../scripts/deploy-params"

// FIX 1: deploying a 2nd extra vault. The registry already holds prior extras (beqty/arcousd)
// with full records; ACTIVE_PRODUCTS must auto-include them so normalizeRegistry doesn't throw
// "Unknown product", and the resumable step logic skips their already-recorded steps.

const deployer = address(1)

const beqty: ExtendedProductPlan = {
  productId: "beqty",
  symbol: "bEQTY",
  name: "DigiFT U.S. Equity Income Fund",
  paymentAssetSymbol: "tUSDC",
}
const arcogold: ExtendedProductPlan = {
  productId: "arcogold",
  symbol: "aGOLD",
  name: "Arco GOLD",
  paymentAssetSymbol: "tUSDC",
}

describe("active products — prior-extra auto-merge (FIX 1)", () => {
  it("registryExtraProducts returns only the non-built-in products, as ExtendedProductPlan", () => {
    const registry = fullyDeployedRegistry([...PRODUCTS, beqty])
    const extras = registryExtraProducts(registry)
    expect(extras.map((extra) => extra.productId)).to.deep.equal(["beqty"])
    expect(extras[0]).to.deep.equal(beqty)
  })

  it("registryExtraProducts: built-ins-only / empty / missing products[] => []", () => {
    expect(registryExtraProducts(fullyDeployedRegistry(PRODUCTS))).to.deep.equal([])
    expect(registryExtraProducts({})).to.deep.equal([])
    expect(registryExtraProducts({ products: [] })).to.deep.equal([])
    expect(registryExtraProducts(null)).to.deep.equal([])
  })

  it("mergeActiveProducts = built-ins + registry extras + params extras, deduped by productId", () => {
    const merged = mergeActiveProducts([beqty], [arcogold])
    expect(merged.map((product) => product.productId)).to.deep.equal([
      ...PRODUCTS.map((product) => product.productId),
      "beqty",
      "arcogold",
    ])
    // defensive dedup net: a productId in both registry and params appears once
    const deduped = mergeActiveProducts([beqty], [beqty])
    expect(deduped.filter((product) => product.productId === "beqty")).to.have.length(1)
  })

  it("no-extras path is byte-identical: mergeActiveProducts([], []) deep-equals PRODUCTS", () => {
    expect(mergeActiveProducts([], [])).to.deep.equal([...PRODUCTS])
  })

  it("normalizeRegistry THROWS on a recorded prior extra missing from ACTIVE_PRODUCTS (the bug)", () => {
    const registry = fullyDeployedRegistry([...PRODUCTS, beqty])
    expect(() => normalizeRegistry(registry, deployer, "commit1", "cancun", PRODUCTS)).to.throw(/Unknown product beqty/)
  })

  it("merging the registry extra fixes it: no throw, remainingSteps = only the new extra's 12 steps", () => {
    const registry = fullyDeployedRegistry([...PRODUCTS, beqty])
    const active = mergeActiveProducts(registryExtraProducts(registry), [arcogold])
    expect(active.map((product) => product.productId)).to.include.members(["beqty", "arcogold"])
    expect(() => normalizeRegistry(registry, deployer, "commit1", "cancun", active)).not.to.throw()

    const normalized = normalizeRegistry(registry, deployer, "commit1", "cancun", active)
    const remaining = remainingSteps(normalized, buildDeploySteps(active))
    expect(remaining).to.have.length(12) // one product's 2 + 2 + 4 + 4 steps
    expect(remaining.every((step) => step.key.includes(":arcogold:") || step.key.includes(":product:arcogold:"))).to.equal(true)
    // beqty (already deployed) contributes NO remaining steps
    expect(remaining.some((step) => step.key.includes("beqty"))).to.equal(false)
  })

  it("empty params file: a PARTIAL registry extra still auto-merges and resumes (no throw)", () => {
    const gizmo: ExtendedProductPlan = { productId: "gizmo", symbol: "gIZMO", name: "Arco GIZMO", paymentAssetSymbol: "tUSDC" }
    // built-ins fully deployed; gizmo registered with only its productToken proxy recorded.
    const registry = normalizeRegistry(fullyDeployedRegistry(PRODUCTS), deployer, "commit1", "cancun", [...PRODUCTS, gizmo])
    const tokenStep = buildDeploySteps([...PRODUCTS, gizmo]).find(
      (step): step is ProxyStep => step.type === "proxy" && step.key === "proxy:product:gizmo:productToken",
    )
    if (!tokenStep) throw new Error("expected gizmo productToken step")
    recordProxyDeployment(registry, tokenStep, proxyRecord(900))

    // Resume with an EMPTY params file: registryExtras auto-includes the partial vault.
    const registryExtras = registryExtraProducts(registry)
    expect(registryExtras.map((extra) => extra.productId)).to.deep.equal(["gizmo"])
    const active = mergeActiveProducts(registryExtras, []) // no GIWA_EXTRA_PRODUCTS
    expect(() => normalizeRegistry(registry, deployer, "commit1", "cancun", active)).not.to.throw()

    const normalized = normalizeRegistry(registry, deployer, "commit1", "cancun", active)
    const remaining = remainingSteps(normalized, buildDeploySteps(active))
    expect(remaining).to.have.length(11) // 12 - the 1 recorded productToken proxy
    expect(remaining.every((step) => step.key.includes("gizmo"))).to.equal(true)
  })

  it("params validation rejects a NEW extra colliding with any existing vault (built-in OR registry)", () => {
    // Reserve built-ins PLUS the deployed registry extra (id + symbol), as loadExtraProducts does.
    const reservedIds = [...PRODUCTS.map((product) => product.productId), beqty.productId]
    const reservedSymbols = [...PRODUCTS.map((product) => product.symbol), beqty.symbol]

    // A genuinely new vault passes.
    expect(() => parseExtraProducts(paramsBlob("arcogold", "aGOLD"), reservedIds, reservedSymbols)).not.to.throw()

    // Re-listing the prior extra (id + symbol both collide) is rejected with guidance.
    expect(() => parseExtraProducts(paramsBlob("beqty", "bEQTY"), reservedIds, reservedSymbols)).to.throw(
      /already deployed[\s\S]*don't re-list/i,
    )
    // Symbol collision only (fresh id, but a registry extra's symbol) is rejected.
    expect(() => parseExtraProducts(paramsBlob("arcoequity", "bEQTY"), reservedIds, reservedSymbols)).to.throw(/already deployed/i)
    // Built-in collision is rejected.
    expect(() => parseExtraProducts(paramsBlob("acapix", "aXYZ"), reservedIds, reservedSymbols)).to.throw(/already deployed/i)
  })
})

// ── helpers ────────────────────────────────────────────────────────────────

// A registry with EVERY step for `products` recorded (fully deployed).
function fullyDeployedRegistry(products: readonly ExtendedProductPlan[]) {
  const registry = normalizeRegistry({}, deployer, "commit0", "cancun", products)
  let seed = 100
  for (const step of buildDeploySteps(products)) {
    seed += 1
    if (step.type === "proxy") {
      recordProxyDeployment(registry, step, proxyRecord(seed))
    } else {
      recordRoleGrant(registry, {
        key: step.key,
        role: step.role,
        roleHash: hash(seed),
        target: address(seed),
        targetKey: step.targetKey,
        grantee: address(seed + 1),
        granteeKey: step.granteeKey,
        txHash: hash(seed + 3000),
        blockNumber: seed,
        status: "confirmed",
      })
    }
  }
  return registry
}

function proxyRecord(seed: number) {
  return {
    proxy: address(seed),
    implementation: address(seed + 1000),
    bytecodeHash: hash(seed),
    deployTxHash: hash(seed + 2000),
    blockNumber: seed,
  }
}

function paramsBlob(productId: string, symbol: string) {
  return {
    schemaVersion: 1,
    products: [{ productId, symbol, name: "Test Vault", paymentAssetSymbol: "tUSDC", category: "Prime Credit" }],
  }
}

function address(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, "0")}`
}

function hash(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(64, "0")}`
}
