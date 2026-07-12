import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Abi, AbiEvent } from "viem"
import {
  PLAN_TARGET_INDEXED_EVENTS,
  RESOLVED_INDEXED_EVENTS,
} from "../registry/products.js"
import type { RegistryEvent, RegistryEventMismatch } from "../registry/types.js"

export const CONTRACT_ARTIFACT_PATHS = {
  ProductToken: "packages/contracts/artifacts/contracts/ProductToken.sol/ProductToken.json",
  TestAssetToken: "packages/contracts/artifacts/contracts/TestAssetToken.sol/TestAssetToken.json",
  TestAssetFaucet: "packages/contracts/artifacts/contracts/TestAssetFaucet.sol/TestAssetFaucet.json",
  ProductPriceFeed: "packages/contracts/artifacts/contracts/ProductPriceFeed.sol/ProductPriceFeed.json",
  ArcoDepositVault:
    "packages/contracts/artifacts/contracts/vaults/ArcoDepositVault.sol/ArcoDepositVault.json",
  ArcoRedemptionVault:
    "packages/contracts/artifacts/contracts/vaults/ArcoRedemptionVault.sol/ArcoRedemptionVault.json",
} as const

export type ContractArtifactName = keyof typeof CONTRACT_ARTIFACT_PATHS

export type ContractArtifact = {
  readonly abi: Abi
  readonly bytecode?: `0x${string}`
  readonly deployedBytecode?: `0x${string}`
}

export function readContractArtifact(name: ContractArtifactName): ContractArtifact {
  const artifactPath = join(process.cwd(), CONTRACT_ARTIFACT_PATHS[name])
  return JSON.parse(readFileSync(artifactPath, "utf8")) as ContractArtifact
}

export function readContractAbi(name: ContractArtifactName): Abi {
  return readContractArtifact(name).abi
}

export function getAbiEvents(name: ContractArtifactName): AbiEvent[] {
  return readContractAbi(name).filter((item): item is AbiEvent => item.type === "event")
}

export function formatEventSignature(event: AbiEvent): string {
  return `${event.name}(${event.inputs.map((input) => input.type).join(",")})`
}

function eventSourceContracts(eventName: string): ContractArtifactName[] {
  switch (eventName) {
    case "FaucetDrip":
      return ["TestAssetFaucet"]
    case "ProductDeposit":
    case "ProductDepositRequested":
    case "ProductDepositFulfilled":
      return ["ArcoDepositVault"]
    case "ProductRedeemInstant":
    case "ProductRedeemRequested":
    case "ProductRedeemFulfilled":
    case "ProductRedeemClaimed":
      return ["ArcoRedemptionVault"]
    case "PriceUpdated":
      return ["ProductPriceFeed"]
    case "Paused":
    case "Unpaused":
      return ["ProductToken", "TestAssetFaucet", "ProductPriceFeed", "ArcoDepositVault", "ArcoRedemptionVault"]
    default:
      return []
  }
}

export function resolveIndexedEventDefinitions(): RegistryEvent[] {
  return RESOLVED_INDEXED_EVENTS.map((eventName) => {
    const sourceContracts = eventSourceContracts(eventName)
    const abiEvent = sourceContracts
      .flatMap((contract) => getAbiEvents(contract))
      .find((event) => event.name === eventName)
    if (!abiEvent) {
      throw new Error(`Compiled ABI is missing indexed event ${eventName}`)
    }

    return {
      name: eventName,
      signature: formatEventSignature(abiEvent),
      sourceContracts,
      inputs: abiEvent.inputs.map((input) => ({
        name: input.name ?? "",
        type: input.type,
        indexed: Boolean(input.indexed),
      })),
    }
  })
}

export function resolveEventMismatches(): RegistryEventMismatch[] {
  const target = new Set<string>(PLAN_TARGET_INDEXED_EVENTS)
  const indexed = new Set<string>(RESOLVED_INDEXED_EVENTS)
  const mismatches: RegistryEventMismatch[] = []

  for (const eventName of indexed) {
    if (!target.has(eventName)) {
      mismatches.push({
        eventName,
        status: "extra-indexed-event",
        action:
          "Included in the registry and indexer because the split deposit vault ABI emits this request-flow event.",
      })
    }
  }

  for (const eventName of target) {
    if (!indexed.has(eventName)) {
      mismatches.push({
        eventName,
        status: "missing-target-event",
        action: "Registry validation fails until the compiled ABI and indexer are reconciled.",
      })
    }
  }

  return mismatches
}

export function resolvedIndexedEventNames(): string[] {
  return resolveIndexedEventDefinitions().map((event) => event.name)
}
