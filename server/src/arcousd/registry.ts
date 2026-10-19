import { existsSync, readFileSync } from "node:fs"
import { isAddress } from "viem"

// Server view of deployments/91342/arcousd-giwa.json — written only by
// packages/contracts/scripts/deploy-arcousd-giwa.ts (never by hand). Kept apart from the core
// registry so core-registry rewrites by other ops scripts can never drop it.

export type ArcoUSDContractRef = {
  readonly proxy: `0x${string}` | null
  readonly implementation: `0x${string}` | null
  readonly bytecodeHash: `0x${string}` | null
  readonly blockNumber?: number
}

/** A plain (non-proxy) contract record: the Lens, the savings distributor and the Zap. */
export type ArcoUSDPlainRef = {
  readonly address: `0x${string}` | null
  readonly bytecodeHash: `0x${string}` | null
  readonly blockNumber?: number
  /** Deploy sent but not yet confirmed by the deploy script: not usable yet. */
  readonly pending?: boolean
}

/** Phase 4 Savings (docs/specs/arcousd-v1.md §3.13–3.15). Absent in files written before it existed. */
export type ArcoUSDSavingsFile = {
  readonly vault: ArcoUSDContractRef & { readonly pending?: boolean }
  readonly distributor: ArcoUSDPlainRef
  readonly zap: ArcoUSDPlainRef
  readonly params?: {
    readonly vestingPeriod: number
    readonly minInterval: number
    readonly maxAprBps: number
    readonly reserveMarginBps: number
  }
  /** sArcoUSD.seed() done: deposits open, 1 sArcoUSD held by 0x…dEaD. */
  readonly seeded: boolean
}

/** The Savings contracts once all three are deployed (seeded or not: deposits open only after the seed). */
export type DeployedSavings = {
  readonly vaultAddress: `0x${string}`
  readonly distributorAddress: `0x${string}`
  readonly zapAddress: `0x${string}`
  /** distribute() needs the Reserve unpaused and ArcoUSD mint open: the reader checks both. */
  readonly reserveAddress: `0x${string}`
  readonly arcoUSDAddress: `0x${string}`
  /** Where the savings indexer starts: the earliest of their deploy blocks (else deploymentBlock). */
  readonly startBlock: number
  readonly seeded: boolean
}

export type ArcoUSDRegistryFile = {
  readonly schemaVersion: 1
  readonly chainId: number
  readonly network: string
  readonly deployed: boolean
  readonly deploymentBlock: number | null
  readonly arcoUSD: ArcoUSDContractRef
  readonly reserve: ArcoUSDContractRef
  readonly lens: { readonly address: `0x${string}` | null; readonly bytecodeHash: `0x${string}` | null }
  readonly testAssets: readonly {
    readonly symbol: string
    readonly name: string
    readonly decimals: number
    readonly contract: ArcoUSDContractRef
  }[]
  readonly reserveAssets: readonly {
    readonly symbol: string
    readonly address: `0x${string}` | null
    readonly decimals: number
    readonly minQueued: string
    readonly instantFeeBps: number
    /** Deposits and all redemptions (non-base stablecoins). Absent in files written before it existed. */
    readonly swapFeeBps?: number
  }[]
  readonly strategies: readonly { readonly productId: string; readonly strategyId: number | null; readonly maxAllocation: string }[]
  readonly params: {
    readonly mintCap: string
    readonly mmfTargetBps: number
    readonly bufferFloorBps: number
    readonly queueMinDelay: number
  }
  /** ArcoRouter (product buys with any Reserve stablecoin). Absent in files written before it existed. */
  readonly router?: ArcoUSDContractRef
  /** Products whose deposit vault the Router may buy into (`configured` once setVault confirmed). */
  readonly routerVaults?: readonly { readonly productId: string; readonly configured: boolean }[]
  readonly savings?: ArcoUSDSavingsFile
}

/** A registry the server can act on: deployed, with every address it reads. */
export type DeployedArcoUSD = Omit<ArcoUSDRegistryFile, "savings"> & {
  readonly arcoUSDAddress: `0x${string}`
  readonly reserveAddress: `0x${string}`
  readonly lensAddress: `0x${string}`
  /** null until the Router is deployed. */
  readonly routerAddress: `0x${string}` | null
  /** Products the Router can buy (setVault confirmed); empty without a Router. */
  readonly routerProducts: readonly string[]
  readonly deploymentBlock: number
  /** null until sArcoUSD, the distributor and the Zap are all deployed (no pending record). */
  readonly savings: DeployedSavings | null
}

export function validateArcoUSDRegistry(registry: ArcoUSDRegistryFile, chainId: number): string[] {
  const errors: string[] = []
  if (registry.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (registry.chainId !== chainId) errors.push(`chainId must be ${chainId}`)
  if (!Array.isArray(registry.reserveAssets)) errors.push("reserveAssets must be an array")
  if (!Array.isArray(registry.strategies)) errors.push("strategies must be an array")
  if (!registry.deployed) return errors
  const need = (value: unknown, label: string) => {
    if (typeof value !== "string" || !isAddress(value)) errors.push(`${label} must be an address when deployed`)
  }
  need(registry.arcoUSD?.proxy, "arcoUSD.proxy")
  need(registry.reserve?.proxy, "reserve.proxy")
  need(registry.lens?.address, "lens.address")
  if (typeof registry.deploymentBlock !== "number") errors.push("deploymentBlock is required when deployed")
  if (registry.router?.proxy != null) need(registry.router.proxy, "router.proxy")
  for (const asset of registry.reserveAssets ?? []) {
    need(asset.address, `reserveAssets.${asset.symbol}.address`)
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) {
      errors.push(`reserveAssets.${asset.symbol}.decimals must be 0..18`)
    }
    if (asset.swapFeeBps !== undefined && (!Number.isInteger(asset.swapFeeBps) || asset.swapFeeBps < 0 || asset.swapFeeBps > 100)) {
      errors.push(`reserveAssets.${asset.symbol}.swapFeeBps must be 0..100`)
    }
  }
  for (const strategy of registry.strategies ?? []) {
    if (strategy.strategyId === null) errors.push(`strategies.${strategy.productId} has no strategyId`)
  }
  const savings = registry.savings
  if (savings) {
    if (savings.vault?.proxy != null) need(savings.vault.proxy, "savings.vault.proxy")
    if (savings.distributor?.address != null) need(savings.distributor.address, "savings.distributor.address")
    if (savings.zap?.address != null) need(savings.zap.address, "savings.zap.address")
  }
  return errors
}

/** Savings once all three contracts are recorded and none is still pending; otherwise null. */
export function deployedSavings(registry: ArcoUSDRegistryFile): DeployedSavings | null {
  const savings = registry.savings
  const vault = savings?.vault?.proxy
  const distributor = savings?.distributor?.address
  const zap = savings?.zap?.address
  const reserve = registry.reserve?.proxy
  const arcoUSD = registry.arcoUSD?.proxy
  if (!savings || !vault || !distributor || !zap || !reserve || !arcoUSD) return null
  if (savings.vault.pending || savings.distributor.pending || savings.zap.pending) return null
  const blocks = [savings.vault.blockNumber, savings.distributor.blockNumber, savings.zap.blockNumber].filter(
    (block): block is number => typeof block === "number",
  )
  return {
    vaultAddress: vault,
    distributorAddress: distributor,
    zapAddress: zap,
    reserveAddress: reserve,
    arcoUSDAddress: arcoUSD,
    startBlock: blocks.length ? Math.min(...blocks) : (registry.deploymentBlock ?? 0),
    seeded: savings.seeded === true,
  }
}

/** Missing file → null (ArcoUSD not deployed yet; every ArcoUSD surface stays inert). */
export function readArcoUSDRegistry(filePath: string): ArcoUSDRegistryFile | null {
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, "utf8")) as ArcoUSDRegistryFile
}

/** Validated, deployed registry or null; throws on a present-but-invalid file. */
export function deployedArcoUSD(registry: ArcoUSDRegistryFile | null, chainId: number): DeployedArcoUSD | null {
  if (!registry) return null
  const errors = validateArcoUSDRegistry(registry, chainId)
  if (errors.length) throw new Error(`Invalid ArcoUSD registry: ${errors.join("; ")}`)
  if (!registry.deployed) return null
  return {
    ...registry,
    arcoUSDAddress: registry.arcoUSD.proxy!,
    reserveAddress: registry.reserve.proxy!,
    lensAddress: registry.lens.address!,
    routerAddress: registry.router?.proxy ?? null,
    routerProducts: registry.router?.proxy
      ? (registry.routerVaults ?? []).filter((vault) => vault.configured).map((vault) => vault.productId)
      : [],
    deploymentBlock: registry.deploymentBlock!,
    savings: deployedSavings(registry),
  }
}
