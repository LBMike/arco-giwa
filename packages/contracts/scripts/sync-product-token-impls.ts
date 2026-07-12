// One-time registry data-correctness sync: the ProductToken proxies were upgraded to the
// shared greenlist-toggle V2 implementation on-chain, but the registry file still records
// the V1 implementation/bytecodeHash. This script re-reads the EIP-1967 implementation
// slot + implementation code hash from GIWA Sepolia and rewrites ONLY
// products[*].productToken.{implementation,bytecodeHash} via the harness writeRegistry()
// (same persistence convention as upgrade-deposit-vaults-giwa.ts:243-254).
//
// NO transactions are sent — chain reads + a registry FILE write only. deploymentRecords
// are deploy-time history and stay untouched. The registry impl record is the custody
// reference the admin register-product route hard-checks against, so it must track chain.
//
// Run from the repo root: npx tsx packages/contracts/scripts/sync-product-token-impls.ts
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, http, keccak256, type Hex } from "viem"
import { writeRegistry } from "./deploy-registry"

const REGISTRY_PATH = join(process.cwd(), "deployments/91342/arco-giwa-preprod.json")
const RPC_URL = "https://sepolia-rpc.giwa.io"
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex

// Same intent as the deploy harness's ensureCleanTree: refuse to rewrite the registry on
// top of uncommitted TRACKED changes so the sync lands as an isolated, reviewable diff.
function ensureCleanTrackedTree() {
  const dirty = execSync("git status --porcelain -uno", { encoding: "utf8" }).trim()
  if (dirty) {
    throw new Error(`Refusing to write the registry with uncommitted tracked changes:\n${dirty}`)
  }
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

  const changes: string[] = []
  for (const product of registry.products) {
    const record = product.productToken
    const implWord = await client.getStorageAt({ address: record.proxy, slot: EIP1967_IMPL_SLOT })
    const chainImpl = slotAddress(implWord as Hex | undefined)
    if (!chainImpl) throw new Error(`${product.productId}: no EIP-1967 implementation at ${record.proxy}`)
    const code = await client.getBytecode({ address: chainImpl })
    if (!code || code === "0x") throw new Error(`${product.productId}: no bytecode at implementation ${chainImpl}`)
    const chainHash = keccak256(code)

    const implChanged = chainImpl.toLowerCase() !== String(record.implementation).toLowerCase()
    const hashChanged = chainHash.toLowerCase() !== String(record.bytecodeHash).toLowerCase()
    if (!implChanged && !hashChanged) {
      console.log(`${product.productId}.productToken already in sync — skipping`)
      continue
    }
    changes.push(`${product.productId}.productToken: impl ${record.implementation} -> ${chainImpl}`)
    record.implementation = chainImpl
    record.bytecodeHash = chainHash
  }

  if (!changes.length) {
    console.log("Registry already matches the chain — nothing to write.")
    return
  }
  writeRegistry(REGISTRY_PATH, registry)
  console.log(`Updated ${changes.length} ProductToken records:\n${changes.join("\n")}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
