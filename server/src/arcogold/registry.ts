import { existsSync, readFileSync } from "node:fs"
import { isAddress } from "viem"
import type { ArcoUSDContractRef, ArcoUSDPlainRef, DeployedArcoUSD } from "../arcousd/registry.js"

// Server view of deployments/91342/arcogold-giwa.json, written only by
// packages/contracts/scripts/deploy-arcogold-giwa.ts (shape: packages/contracts/scripts/arcogold/arcogold-registry.ts).
// ArcoGOLD is a second instance of the sArcoUSD stack in troy ounces: ArcoXAU (the internal ounce unit), a gold
// ArcoUSDReserve with its Lens, ArcoGOLD (ERC-4626 over ArcoXAU) and an ArcoSavingsZap. No distributor in v1.
//
// A missing file is "not deployed": every gold surface stays inert (no route answers 500, the app shows nothing gold).

export type ArcoGoldRegistryFile = {
  readonly schemaVersion: 1
  readonly product: "arcogold"
  readonly chainId: number
  readonly network: string
  readonly deployed: boolean
  readonly deploymentBlock: number | null
  readonly faucet?: `0x${string}` | null
  readonly unit: { readonly name: string; readonly symbol: string; readonly contract: ArcoUSDContractRef & { readonly pending?: boolean } }
  readonly reserve: ArcoUSDContractRef & { readonly pending?: boolean }
  readonly lens: ArcoUSDPlainRef
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
    readonly instantFeeBps: number
    readonly swapFeeBps: number
    readonly minQueued: string
  }[]
  readonly params: {
    readonly mintCap: string
    readonly mmfTargetBps: number
    readonly bufferFloorBps: number
    readonly queueMinDelay: number
  }
  readonly savings: {
    readonly name: string
    readonly symbol: string
    readonly vault: ArcoUSDContractRef & { readonly pending?: boolean }
    readonly zap: ArcoUSDPlainRef
    readonly distributor: null
    readonly seeded: boolean
  }
}

/** A gold registry the server can act on: deployed, with every address it reads. */
export type DeployedArcoGold = {
  readonly chainId: number
  readonly deploymentBlock: number
  readonly unitAddress: `0x${string}`
  readonly reserveAddress: `0x${string}`
  readonly lensAddress: `0x${string}`
  readonly vaultAddress: `0x${string}`
  readonly zapAddress: `0x${string}`
  readonly seeded: boolean
  readonly reserveAssets: ArcoGoldRegistryFile["reserveAssets"]
  readonly params: ArcoGoldRegistryFile["params"]
}

export function validateArcoGoldRegistry(registry: ArcoGoldRegistryFile, chainId: number): string[] {
  const errors: string[] = []
  if (registry.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (registry.product !== "arcogold") errors.push('product must be "arcogold"')
  if (registry.chainId !== chainId) errors.push(`chainId must be ${chainId}`)
  if (!Array.isArray(registry.reserveAssets)) errors.push("reserveAssets must be an array")
  if (!registry.deployed) return errors
  const need = (value: unknown, label: string) => {
    if (typeof value !== "string" || !isAddress(value)) errors.push(`${label} must be an address when deployed`)
  }
  need(registry.unit?.contract?.proxy, "unit.contract.proxy")
  need(registry.reserve?.proxy, "reserve.proxy")
  need(registry.lens?.address, "lens.address")
  need(registry.savings?.vault?.proxy, "savings.vault.proxy")
  need(registry.savings?.zap?.address, "savings.zap.address")
  if (typeof registry.deploymentBlock !== "number") errors.push("deploymentBlock is required when deployed")
  const pending = [
    ["unit", registry.unit?.contract?.pending],
    ["reserve", registry.reserve?.pending],
    ["lens", registry.lens?.pending],
    ["savings.vault", registry.savings?.vault?.pending],
    ["savings.zap", registry.savings?.zap?.pending],
  ] as const
  for (const [label, isPending] of pending) if (isPending) errors.push(`${label} is still pending`)
  for (const asset of registry.reserveAssets ?? []) {
    need(asset.address, `reserveAssets.${asset.symbol}.address`)
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) {
      errors.push(`reserveAssets.${asset.symbol}.decimals must be 0..18`)
    }
  }
  return errors
}

/** Missing file → null (ArcoGOLD not deployed yet). A present file that is not JSON throws (an ops error). */
export function readArcoGoldRegistry(filePath: string): ArcoGoldRegistryFile | null {
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, "utf8")) as ArcoGoldRegistryFile
}

/** Validated, deployed registry or null (absent, or the deploy script has not finished); throws on an invalid file. */
export function deployedArcoGold(registry: ArcoGoldRegistryFile | null, chainId: number): DeployedArcoGold | null {
  if (!registry) return null
  const errors = validateArcoGoldRegistry(registry, chainId)
  if (errors.length) throw new Error(`Invalid ArcoGOLD registry: ${errors.join("; ")}`)
  if (!registry.deployed) return null
  return {
    chainId: registry.chainId,
    deploymentBlock: registry.deploymentBlock!,
    unitAddress: registry.unit.contract.proxy!,
    reserveAddress: registry.reserve.proxy!,
    lensAddress: registry.lens.address!,
    vaultAddress: registry.savings.vault.proxy!,
    zapAddress: registry.savings.zap.address!,
    seeded: registry.savings.seeded === true,
    reserveAssets: registry.reserveAssets,
    params: registry.params,
  }
}

/**
 * The gold Reserve as the ArcoUSD Reserve reader takes it (server/src/arcousd/reader.ts): the same contracts (an
 * ArcoUSDReserve, its Lens, an ArcoUSD-type unit), so one reader serves both. The unit stands where ArcoUSD does; there
 * is no Router and no MMF strategy.
 */
export function goldReserveDeployment(gold: DeployedArcoGold): DeployedArcoUSD {
  const contract = (address: `0x${string}`) => ({ proxy: address, implementation: null, bytecodeHash: null })
  return {
    schemaVersion: 1,
    chainId: gold.chainId,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: gold.deploymentBlock,
    arcoUSD: contract(gold.unitAddress),
    reserve: contract(gold.reserveAddress),
    lens: { address: gold.lensAddress, bytecodeHash: null },
    testAssets: [],
    reserveAssets: gold.reserveAssets.map((asset) => ({
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals,
      minQueued: asset.minQueued,
      instantFeeBps: asset.instantFeeBps,
      swapFeeBps: asset.swapFeeBps,
    })),
    strategies: [],
    params: gold.params,
    arcoUSDAddress: gold.unitAddress,
    reserveAddress: gold.reserveAddress,
    lensAddress: gold.lensAddress,
    routerAddress: null,
    routerProducts: [],
    savings: null,
  }
}
