// One-off recovery (NO transactions — registry FILE write only).
//
// The bEQTY ProductPriceFeed proxy deployed successfully on GIWA Sepolia
// (proxy 0xeC24…AFBa4, impl 0xa55f43…27Ec, creation tx 0x5c3c459e…, block 30008259),
// but a transient RPC read-after-write lag made the deploy harness's post-deploy
// upgrades.erc1967.getImplementationAddress() check throw ("…doesn't look like an
// ERC 1967 proxy with a logic contract address") BEFORE recordProxyDeployment() ran.
// On-chain + the OZ manifest have the proxy; the Arco registry does not.
//
// This records the already-verified on-chain values via the harness's own
// recordProxyDeployment + writeRegistry, so `remainingSteps` skips the price feed on
// resume. Idempotent: re-running after the record exists is a no-op.
//
// Run from packages/contracts: npx tsx scripts/reconcile-beqty-price-feed.ts
import { readFileSync } from "fs"
import path from "path"
import { recordProxyDeployment, registryFilePath, writeRegistry } from "./deploy-registry"
import type { ProxyStep } from "./deploy-plan"

const repoRoot = path.resolve(__dirname, "../../..")
const regPath = registryFilePath(repoRoot)

// Verified on-chain (see header); addresses are EIP-55 checksummed as the harness stores them.
const PROXY = "0xeC241df6E4E608C4260959Dc07D4f751372AFBa4" as `0x${string}`
const IMPL = "0xa55f430172F10F4F7C669ee70C47C22B1aa927Ec" as `0x${string}`
const BYTECODE_HASH = "0xe7ebdae745336affb2de82d164ef429c9a3ac09b79c35b53f6c96a663458c841" as `0x${string}`
const DEPLOY_TX = "0x5c3c459e5ec0c2a35c05f4d90351baa4302bf6f670a02225ade4c5727d187a58" as `0x${string}`
const BLOCK_NUMBER = 30008259

// Matches buildDeploySteps(): key/label/contractName for the beqty price-feed proxy step.
const step = {
  type: "proxy",
  key: "proxy:product:beqty:priceFeed",
  slot: "priceFeed",
  label: "bEQTY-price-feed",
  contractName: "ProductPriceFeed",
} as ProxyStep

const registry = JSON.parse(readFileSync(regPath, "utf8"))
const existing = registry.deploymentRecords.find((r: { key: string }) => r.key === step.key)
if (existing) {
  console.log(`already recorded (${existing.proxy}) — no change`)
  process.exit(0)
}

recordProxyDeployment(registry, step, {
  proxy: PROXY,
  implementation: IMPL,
  bytecodeHash: BYTECODE_HASH,
  deployTxHash: DEPLOY_TX,
  blockNumber: BLOCK_NUMBER,
})
writeRegistry(regPath, registry)

const product = registry.products.find((p: { productId: string }) => p.productId === "beqty")
console.log("recorded beqty priceFeed record.")
console.log("  products[beqty].priceFeed.proxy:", product.priceFeed.proxy)
console.log("  products[beqty].priceFeed.impl :", product.priceFeed.implementation)
console.log("  deploymentRecords count        :", registry.deploymentRecords.length)
