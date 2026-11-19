import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"
import type { Address, ArcoUSDContract, ArcoUSDPlainContract } from "../arcousd/arcousd-registry"

// ArcoGOLD has its OWN registry file (deployments/91342/arcogold-giwa.json), like ArcoUSD
// (arcousd-giwa.json) and for the same reason: the core loader rebuilds arco-giwa-preprod.json
// from known fields only and would drop anything else. It is written only by
// scripts/deploy-arcogold-giwa.ts during a human-run broadcast, never by hand.
//
// The stack (docs/operations/arcogold-deploy.md): tPAXG + tXAUT test assets, the internal ounce
// unit ArcoXAU (ArcoUSDNamed), a gold ArcoUSDReserve proxy, an ArcoUSDReserveLens, a 1.0
// ConstantPriceFeed for the Reserve's depeg check, ArcoGOLD (SArcoUSDNamed, ERC-4626) and an
// ArcoSavingsZap. 1 tPAXG = 1 tXAUT = 1 ArcoXAU = 1 troy ounce (testnet). No distributor yet.

export type ArcoGoldTestAsset = {
  symbol: string
  name: string
  decimals: number
  contract: ArcoUSDContract
  faucet: { drip: string; dailyCapDrips: number; globalCapDrips: number; cooldown: number } // drip in whole tokens
  faucetConfigured: boolean
}

export type ArcoGoldReserveAsset = {
  symbol: string
  address: Address | null // resolved from testAssets
  decimals: number
  instantFeeBps: number
  swapFeeBps: number
  depositCap: string // base units; "max" = no cap
  minQueued: string // base units
  configured: boolean
}

export type ArcoGoldRegistry = {
  schemaVersion: 1
  product: "arcogold"
  chainId: number
  network: string
  gitCommit: string
  deployed: boolean
  deploymentBlock: number | null
  admin: Address | null
  /** The core test-asset faucet (from the core registry) that drips tPAXG/tXAUT. */
  faucet: Address | null
  /** Internal gold ounce unit (ArcoUSDNamed proxy). Users never see it. */
  unit: { name: string; symbol: string; contract: ArcoUSDContract }
  /** ArcoUSDReserve proxy issuing the unit 1:1 per ounce against tPAXG/tXAUT. */
  reserve: ArcoUSDContract
  lens: ArcoUSDPlainContract
  /** ConstantPriceFeed for the Reserve depeg check (answer = 1 ounce per token). */
  pegFeed: ArcoUSDPlainContract & { answerBase18: string; maxDepegBps: number }
  testAssets: ArcoGoldTestAsset[]
  reserveAssets: ArcoGoldReserveAsset[]
  params: { mintCap: string; mmfTargetBps: number; bufferFloorBps: number; queueMinDelay: number }
  roleGrants: {
    key: string
    txHash: `0x${string}` | null
    status: "confirmed" | "already-present"
  }[]
  savings: {
    name: string
    symbol: string
    /** ArcoGOLD (SArcoUSDNamed proxy, ERC-4626 over the unit). */
    vault: ArcoUSDContract
    /** ArcoSavingsZap bound to the gold Reserve and ArcoGOLD. */
    zap: ArcoUSDPlainContract
    /** No savings distributor in v1 (the app shows a set display APY). Kept null so one can be added later. */
    distributor: null
    params: { vestingPeriod: number }
    /** Reserve asset that pays the 1-unit seed (fee-free, minted to the deployer when short). */
    seedAsset: string
    seeded: boolean
  }
}

/** The deploy-params JSON (deploy-params/arcogold.json). */
export type ArcoGoldParamsFile = {
  schemaVersion: 1
  unit: { name: string; symbol: string }
  savings: { name: string; symbol: string; vestingPeriod: number }
  reserve: ArcoGoldRegistry["params"]
  pegFeed: { answerBase18: string; maxDepegBps: number }
  testAssets: {
    symbol: string
    name: string
    decimals: number
    faucet: ArcoGoldTestAsset["faucet"]
  }[]
  reserveAssets: Omit<ArcoGoldReserveAsset, "address" | "configured">[]
  seedAsset: string
}

export function arcoGoldRegistryPath(repoRoot: string) {
  return path.join(repoRoot, "deployments/91342/arcogold-giwa.json")
}

export function arcoGoldParamsPath(packageRoot: string) {
  return path.join(packageRoot, "deploy-params/arcogold.json")
}

export function loadArcoGoldParams(filePath: string): ArcoGoldParamsFile {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as ArcoGoldParamsFile
  if (raw.schemaVersion !== 1)
    throw new Error(`Unsupported ArcoGOLD params schemaVersion ${raw.schemaVersion}`)
  return raw
}

const emptyContract = (): ArcoUSDContract => ({
  proxy: null,
  implementation: null,
  bytecodeHash: null,
})
const emptyPlain = (): ArcoUSDPlainContract => ({ address: null, bytecodeHash: null })

/** A fresh (nothing deployed) registry built from the params file. */
export function registryFromParams(
  params: ArcoGoldParamsFile,
  chainId: number,
  network: string,
  gitCommit: string,
): ArcoGoldRegistry {
  return {
    schemaVersion: 1,
    product: "arcogold",
    chainId,
    network,
    gitCommit,
    deployed: false,
    deploymentBlock: null,
    admin: null,
    faucet: null,
    unit: { name: params.unit.name, symbol: params.unit.symbol, contract: emptyContract() },
    reserve: emptyContract(),
    lens: emptyPlain(),
    pegFeed: {
      ...emptyPlain(),
      answerBase18: params.pegFeed.answerBase18,
      maxDepegBps: params.pegFeed.maxDepegBps,
    },
    testAssets: params.testAssets.map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      contract: emptyContract(),
      faucet: { ...asset.faucet },
      faucetConfigured: false,
    })),
    reserveAssets: params.reserveAssets.map((asset) => ({
      ...asset,
      address: null,
      configured: false,
    })),
    params: { ...params.reserve },
    roleGrants: [],
    savings: {
      name: params.savings.name,
      symbol: params.savings.symbol,
      vault: emptyContract(),
      zap: emptyPlain(),
      distributor: null,
      params: { vestingPeriod: params.savings.vestingPeriod },
      seedAsset: params.seedAsset,
      seeded: false,
    },
  }
}

/**
 * Where the params file disagrees with an existing registry (which wins once a deploy started).
 * Shown by the dry-run so a params edit after a partial broadcast is never silently ignored.
 */
export function paramsDrift(registry: ArcoGoldRegistry, params: ArcoGoldParamsFile): string[] {
  const fresh = registryFromParams(params, registry.chainId, registry.network, registry.gitCommit)
  const pick = (r: ArcoGoldRegistry) => ({
    unit: [r.unit.name, r.unit.symbol],
    savings: [
      r.savings.name,
      r.savings.symbol,
      r.savings.params.vestingPeriod,
      r.savings.seedAsset,
    ],
    params: r.params,
    pegFeed: [r.pegFeed.answerBase18, r.pegFeed.maxDepegBps],
    testAssets: r.testAssets.map(({ symbol, name, decimals, faucet }) => ({
      symbol,
      name,
      decimals,
      faucet,
    })),
    reserveAssets: r.reserveAssets.map(({ address: _a, configured: _c, ...rest }) => rest),
  })
  const a = pick(registry) as Record<string, unknown>
  const b = pick(fresh) as Record<string, unknown>
  return Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
}

export function loadArcoGoldRegistry(
  filePath: string,
  fallback: () => ArcoGoldRegistry,
): ArcoGoldRegistry {
  if (!existsSync(filePath)) return fallback()
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as ArcoGoldRegistry
  if (raw.schemaVersion !== 1 || raw.product !== "arcogold") {
    throw new Error(
      `Not an ArcoGOLD registry (schemaVersion ${raw.schemaVersion}, product ${raw.product}): ${filePath}`,
    )
  }
  return raw
}

export function writeArcoGoldRegistry(filePath: string, registry: ArcoGoldRegistry) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  renameSync(tmp, filePath)
}

export function earliestGoldBlock(registry: ArcoGoldRegistry): number | null {
  const blocks = [
    registry.unit.contract.blockNumber,
    registry.reserve.blockNumber,
    registry.lens.blockNumber,
    registry.pegFeed.blockNumber,
    registry.savings.vault.blockNumber,
    registry.savings.zap.blockNumber,
    ...registry.testAssets.map((asset) => asset.contract.blockNumber),
  ].filter((block): block is number => typeof block === "number")
  return blocks.length ? Math.min(...blocks) : null
}
