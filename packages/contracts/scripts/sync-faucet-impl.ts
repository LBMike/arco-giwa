// Registry data-correctness sync (mirror of sync-product-token-impls.ts): the TestAssetFaucet
// proxy was upgraded on-chain to the dripAll-V2 implementation, but the registry still records
// the pre-upgrade impl/bytecodeHash. A normalizeRegistry that predates the products[]-is-source-
// of-truth fix reverted faucet.implementation to the deploy-time deploymentRecord and it was
// committed that way, so it drifted from chain. This re-reads the EIP-1967 implementation slot +
// impl code hash from GIWA Sepolia and rewrites ONLY registry.faucet.{implementation,bytecodeHash}
// via the harness writeRegistry().
//
// NO transactions are sent — chain reads + a registry FILE write only. deploymentRecords are
// deploy-time history and stay untouched. Verified before running: the on-chain impl bytecodeHash
// matches the TestAssetFaucet artifact (dripAll() selector 0x3e0b5174 present).
//
// Run from the repo root: npx tsx packages/contracts/scripts/sync-faucet-impl.ts
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, http, keccak256, type Hex } from "viem"
import { writeRegistry } from "./deploy-registry"

const REGISTRY_PATH = join(process.cwd(), "deployments/91342/arco-giwa-preprod.json")
const RPC_URL = "https://sepolia-rpc.giwa.io"
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex

function ensureCleanTrackedTree() {
  const dirty = execSync("git status --porcelain -uno", { encoding: "utf8" }).trim()
  if (dirty) throw new Error(`Refusing to write the registry with uncommitted tracked changes:\n${dirty}`)
}

function slotAddress(word: Hex | undefined): Hex | null {
  if (!word || word === "0x") return null
  const address = `0x${word.slice(-40)}` as Hex
  return /^0x0{40}$/.test(address) ? null : address
}

async function main() {
  ensureCleanTrackedTree()
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
  const client = createPublicClient({ transport: http(RPC_URL) })

  const proxy = registry.faucet.proxy as Hex
  if (!proxy) throw new Error("registry.faucet.proxy is not set")
  const chainImpl = slotAddress((await client.getStorageAt({ address: proxy, slot: EIP1967_IMPL_SLOT })) as Hex | undefined)
  if (!chainImpl) throw new Error(`no EIP-1967 implementation at faucet proxy ${proxy}`)
  const code = await client.getBytecode({ address: chainImpl })
  if (!code || code === "0x") throw new Error(`no bytecode at faucet implementation ${chainImpl}`)
  const chainHash = keccak256(code)

  const implChanged = chainImpl.toLowerCase() !== String(registry.faucet.implementation).toLowerCase()
  const hashChanged = chainHash.toLowerCase() !== String(registry.faucet.bytecodeHash).toLowerCase()
  if (!implChanged && !hashChanged) {
    console.log("registry.faucet already in sync with chain — nothing to write.")
    return
  }

  console.log(`faucet.implementation ${registry.faucet.implementation} -> ${chainImpl}`)
  console.log(`faucet.bytecodeHash   ${registry.faucet.bytecodeHash} -> ${chainHash}`)
  registry.faucet.implementation = chainImpl
  registry.faucet.bytecodeHash = chainHash
  writeRegistry(REGISTRY_PATH, registry)
  console.log("registry.faucet synced to chain.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
