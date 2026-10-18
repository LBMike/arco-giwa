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
  }[]
  readonly strategies: readonly { readonly productId: string; readonly strategyId: number | null; readonly maxAllocation: string }[]
  readonly params: {
    readonly mintCap: string
    readonly mmfTargetBps: number
    readonly bufferFloorBps: number
    readonly queueMinDelay: number
  }
}

/** A registry the server can act on: deployed, with every address it reads. */
export type DeployedArcoUSD = ArcoUSDRegistryFile & {
  readonly arcoUSDAddress: `0x${string}`
  readonly reserveAddress: `0x${string}`
  readonly lensAddress: `0x${string}`
  readonly deploymentBlock: number
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
  for (const asset of registry.reserveAssets ?? []) {
    need(asset.address, `reserveAssets.${asset.symbol}.address`)
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) {
      errors.push(`reserveAssets.${asset.symbol}.decimals must be 0..18`)
    }
  }
  for (const strategy of registry.strategies ?? []) {
    if (strategy.strategyId === null) errors.push(`strategies.${strategy.productId} has no strategyId`)
  }
  return errors
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
    deploymentBlock: registry.deploymentBlock!,
  }
}
