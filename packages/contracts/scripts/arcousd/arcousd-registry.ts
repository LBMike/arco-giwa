import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"

// ArcoUSD has its OWN registry file (deployments/91342/arcousd-giwa.json), separate from the
// core registry (arco-giwa-preprod.json). The core loader (deploy-registry.ts normalizeRegistry)
// rebuilds that file from known fields only — exactly four payment assets, known products — so
// ArcoUSD contracts and the new test assets would be silently dropped by the next upgrade
// script that rewrites it. A separate file is written only by the ArcoUSD deploy script.

export type Address = `0x${string}`

export type ArcoUSDContract = {
  proxy: Address | null
  implementation: Address | null
  bytecodeHash: `0x${string}` | null
  deployTxHash?: `0x${string}`
  blockNumber?: number
  /** Deploy tx sent but not yet confirmed/read back: a re-run settles it by receipt, never redeploys blindly. */
  pending?: boolean
}

export type ArcoUSDTestAsset = {
  symbol: "tUSDT" | "tRLUSD"
  name: string
  decimals: number
  contract: ArcoUSDContract
  faucetConfigured: boolean
}

export type ArcoUSDReserveAsset = {
  symbol: string
  address: Address | null // resolved from the core registry (tUSDC) or testAssets
  decimals: number
  instantFeeBps: number
  depositCap: string // base units; "max" = no cap
  minQueued: string // base units
  configured: boolean
}

export type ArcoUSDStrategy = {
  productId: string
  maxAllocation: string // base18
  strategyId: number | null
}

export type ArcoUSDRegistry = {
  schemaVersion: 1
  chainId: number
  network: string
  gitCommit: string
  deployed: boolean
  deploymentBlock: number | null
  admin: Address | null
  arcoUSD: ArcoUSDContract
  reserve: ArcoUSDContract
  lens: { address: Address | null; bytecodeHash: `0x${string}` | null; deployTxHash?: `0x${string}`; blockNumber?: number; pending?: boolean }
  testAssets: ArcoUSDTestAsset[]
  reserveAssets: ArcoUSDReserveAsset[]
  strategies: ArcoUSDStrategy[]
  params: { mintCap: string; mmfTargetBps: number; bufferFloorBps: number; queueMinDelay: number }
  roleGrants: { key: string; txHash: `0x${string}` | null; status: "confirmed" | "already-present" }[]
  greenlisted: string[] // productIds whose product token greenlists the Reserve (when enforced)
}

export function arcoUSDRegistryPath(repoRoot: string) {
  return path.join(repoRoot, "deployments/91342/arcousd-giwa.json")
}

const emptyContract = (): ArcoUSDContract => ({ proxy: null, implementation: null, bytecodeHash: null })

/** Testnet defaults (docs/specs/arcousd-v1.md §3.9). */
export function defaultArcoUSDRegistry(chainId: number, network: string, gitCommit: string): ArcoUSDRegistry {
  return {
    schemaVersion: 1,
    chainId,
    network,
    gitCommit,
    deployed: false,
    deploymentBlock: null,
    admin: null,
    arcoUSD: emptyContract(),
    reserve: emptyContract(),
    lens: { address: null, bytecodeHash: null },
    testAssets: [
      { symbol: "tUSDT", name: "Test USDT", decimals: 6, contract: emptyContract(), faucetConfigured: false },
      { symbol: "tRLUSD", name: "Test RLUSD", decimals: 18, contract: emptyContract(), faucetConfigured: false },
    ],
    reserveAssets: [
      { symbol: "tUSDC", address: null, decimals: 6, instantFeeBps: 0, depositCap: "max", minQueued: "1000000", configured: false },
      { symbol: "tUSDT", address: null, decimals: 6, instantFeeBps: 0, depositCap: "max", minQueued: "1000000", configured: false },
      {
        symbol: "tRLUSD",
        address: null,
        decimals: 18,
        instantFeeBps: 0,
        depositCap: "max",
        minQueued: "1000000000000000000",
        configured: false,
      },
    ],
    strategies: [
      { productId: "umint", maxAllocation: "1000000000000000000000000", strategyId: null },
      { productId: "ibenji", maxAllocation: "1000000000000000000000000", strategyId: null },
    ],
    params: { mintCap: "10000000000000000000000000", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
    roleGrants: [],
    greenlisted: [],
  }
}

export function loadArcoUSDRegistry(
  filePath: string,
  fallback: () => ArcoUSDRegistry,
): ArcoUSDRegistry {
  if (!existsSync(filePath)) return fallback()
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as ArcoUSDRegistry
  if (raw.schemaVersion !== 1) throw new Error(`Unsupported ArcoUSD registry schemaVersion ${raw.schemaVersion}`)
  return raw
}

export function writeArcoUSDRegistry(filePath: string, registry: ArcoUSDRegistry) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  renameSync(tmp, filePath)
}

export function earliestBlock(registry: ArcoUSDRegistry): number | null {
  const blocks = [
    registry.arcoUSD.blockNumber,
    registry.reserve.blockNumber,
    registry.lens.blockNumber,
    ...registry.testAssets.map((asset) => asset.contract.blockNumber),
  ].filter((block): block is number => typeof block === "number")
  return blocks.length ? Math.min(...blocks) : null
}
