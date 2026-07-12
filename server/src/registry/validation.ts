import { isAddress, type Address, type PublicClient } from "viem"
import {
  GIWA_CHAIN_ID,
  GIWA_NETWORK,
  REQUIRED_PAYMENT_ASSETS,
  REQUIRED_PRODUCTS,
  REQUIRED_PRODUCT_PAYMENT_MAPPINGS,
  RESOLVED_INDEXED_EVENTS,
} from "./products.js"
import type { GiwaDeploymentRegistry, RegistryValidationResult } from "./types.js"
import type { RegistrySyncInput } from "../services/types.js"

const ZERO_BYTECODE = "0x"

function addressPresent(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value)
}

function validateAddress(value: unknown, label: string, errors: string[], warnings: string[], deployed: boolean) {
  if (deployed) {
    if (!addressPresent(value)) errors.push(`${label} must be a valid address when deployed=true`)
    return
  }
  if (value !== null) warnings.push(`${label} is set while registry is marked not-yet-deployed`)
}

function validateContract(
  value: { proxy?: unknown; implementation?: unknown; bytecodeHash?: unknown } | undefined,
  label: string,
  errors: string[],
  warnings: string[],
  deployed: boolean,
) {
  if (!value) {
    errors.push(`${label} is missing`)
    return
  }
  validateAddress(value.proxy, `${label}.proxy`, errors, warnings, deployed)
  validateAddress(value.implementation, `${label}.implementation`, errors, warnings, deployed)
  if (deployed && typeof value.bytecodeHash !== "string") {
    errors.push(`${label}.bytecodeHash is required when deployed=true`)
  }
}

export function validateGiwaRegistry(registry: GiwaDeploymentRegistry): RegistryValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const deployed = Boolean(registry.activationFlags?.deployed)

  if (registry.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (registry.chainId !== GIWA_CHAIN_ID) errors.push("chainId must be 91342")
  if (registry.network !== GIWA_NETWORK) errors.push("network must be giwa-sepolia")
  if (registry.publicRpcUrl !== "https://sepolia-rpc.giwa.io") errors.push("publicRpcUrl must be GIWA public RPC")
  if (registry.evmVersion === "prague") errors.push("evmVersion prague is forbidden on the GIWA path")
  if (!registry.releaseId) errors.push("releaseId is required")
  if (!registry.gitCommit) errors.push("gitCommit is required")
  if (deployed && registry.deploymentBlock === null) errors.push("deploymentBlock is required when deployed=true")
  if (!deployed && !registry.activationFlags.dryRun) {
    errors.push("not-yet-deployed registry must set activationFlags.dryRun=true")
  }

  validateAddress(registry.deployer, "deployer", errors, warnings, deployed)
  validateContract(registry.proxyAdmin, "proxyAdmin", errors, warnings, deployed)
  validateContract(registry.faucet, "faucet", errors, warnings, deployed)

  const requiredAssets = new Map<string, (typeof REQUIRED_PAYMENT_ASSETS)[number]>(
    REQUIRED_PAYMENT_ASSETS.map((asset) => [asset.symbol, asset]),
  )
  if (registry.assets.length !== requiredAssets.size) errors.push("registry must contain exactly four payment assets")
  for (const asset of registry.assets) {
    const expected = requiredAssets.get(asset.symbol)
    if (!expected) {
      errors.push(`unexpected payment asset ${asset.symbol}`)
      continue
    }
    if (asset.decimals !== expected.decimals) errors.push(`${asset.symbol} decimals must be ${expected.decimals}`)
    validateContract(asset.contract, `assets.${asset.symbol}.contract`, errors, warnings, deployed)
    validateAddress(asset.faucet, `assets.${asset.symbol}.faucet`, errors, warnings, deployed)
  }

  const assetSymbols = new Set(registry.assets.map((asset) => asset.symbol))
  const requiredProducts = new Map<string, (typeof REQUIRED_PRODUCTS)[number]>(
    REQUIRED_PRODUCTS.map((product) => [product.symbol, product]),
  )
  // The six launch products must always be present and correctly mapped. ADDITIONAL
  // products (2c "add a new vault") are allowed when they have a productId, valid
  // contract shapes, and map to a known payment asset.
  for (const required of requiredProducts.values()) {
    if (!registry.products.some((product) => product.symbol === required.symbol)) {
      errors.push(`registry is missing required product ${required.symbol}`)
    }
  }
  const seenProductIds = new Set<string>()
  for (const product of registry.products) {
    if (seenProductIds.has(product.productId)) errors.push(`duplicate productId ${product.productId}`)
    seenProductIds.add(product.productId)
    const expected = requiredProducts.get(product.symbol)
    if (expected) {
      if (product.productId !== expected.productId) errors.push(`${product.symbol} has the wrong productId`)
      if (product.paymentAssetSymbol !== expected.paymentAssetSymbol) {
        errors.push(`${product.symbol} must map to ${expected.paymentAssetSymbol}`)
      }
    } else {
      if (!product.productId) errors.push(`product ${product.symbol} is missing a productId`)
      const mapped = registry.productPaymentMappings?.[product.symbol]
      if (mapped && mapped !== product.paymentAssetSymbol) {
        errors.push(`productPaymentMappings.${product.symbol} must be ${product.paymentAssetSymbol}`)
      }
    }
    if (!assetSymbols.has(product.paymentAssetSymbol)) {
      errors.push(`${product.symbol} maps to missing asset ${product.paymentAssetSymbol}`)
    }
    validateContract(product.productToken, `products.${product.symbol}.productToken`, errors, warnings, deployed)
    validateContract(product.depositVault, `products.${product.symbol}.depositVault`, errors, warnings, deployed)
    validateContract(product.redemptionVault, `products.${product.symbol}.redemptionVault`, errors, warnings, deployed)
    validateContract(product.priceFeed, `products.${product.symbol}.priceFeed`, errors, warnings, deployed)
  }

  for (const [productSymbol, assetSymbol] of Object.entries(REQUIRED_PRODUCT_PAYMENT_MAPPINGS)) {
    if (registry.productPaymentMappings[productSymbol] !== assetSymbol) {
      errors.push(`productPaymentMappings.${productSymbol} must be ${assetSymbol}`)
    }
  }

  const indexedEventNames = new Set(registry.events.indexedEvents.map((event) => event.name))
  for (const eventName of RESOLVED_INDEXED_EVENTS) {
    if (!indexedEventNames.has(eventName)) errors.push(`events.indexedEvents is missing ${eventName}`)
  }
  for (const event of registry.events.indexedEvents) {
    if (!event.signature.startsWith(`${event.name}(`)) {
      errors.push(`event ${event.name} signature is malformed`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    eventMismatches: registry.events.mismatches,
  }
}

export function registryToSyncInput(registry: GiwaDeploymentRegistry, allowSample = false): RegistrySyncInput {
  if (!registry.activationFlags.deployed && !allowSample) {
    throw new Error("Refusing to sync a not-yet-deployed registry without ALLOW_SAMPLE_REGISTRY_SYNC=true")
  }

  return {
    chainId: registry.chainId,
    network: registry.network,
    name: registry.name,
    publicRpcUrl: registry.publicRpcUrl,
    explorerUrl: registry.explorerBaseUrl,
    blockscoutApiUrl: registry.blockscoutApiUrl,
    nativeCurrency: registry.nativeCurrency,
    releaseId: registry.releaseId,
    assets: registry.assets.map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      tokenAddress: asset.contract.proxy ?? "0x0000000000000000000000000000000000000000",
      faucetAddress: asset.faucet,
      deploymentBlock: asset.deploymentBlock,
      metadata: {
        implementation: asset.contract.implementation,
        bytecodeHash: asset.contract.bytecodeHash,
      },
    })),
    products: registry.products.map((product) => {
      const paymentAsset = registry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)
      return {
        productId: product.productId,
        symbol: product.symbol,
        name: product.name,
        productTokenAddress: product.productToken.proxy ?? "0x0000000000000000000000000000000000000000",
        paymentAssetSymbol: product.paymentAssetSymbol,
        paymentAssetAddress: paymentAsset?.contract.proxy ?? "0x0000000000000000000000000000000000000000",
        depositVaultAddress: product.depositVault.proxy ?? "0x0000000000000000000000000000000000000000",
        redemptionVaultAddress: product.redemptionVault.proxy ?? "0x0000000000000000000000000000000000000000",
        priceFeedAddress: product.priceFeed.proxy ?? "0x0000000000000000000000000000000000000000",
        deploymentBlock: product.deploymentBlock,
        activationFlags: product.activationFlags,
        metadata: {
          productTokenImplementation: product.productToken.implementation,
          depositVaultImplementation: product.depositVault.implementation,
          redemptionVaultImplementation: product.redemptionVault.implementation,
          priceFeedImplementation: product.priceFeed.implementation,
          evmVersion: registry.evmVersion,
        },
      }
    }),
  }
}

export async function attestRegistryOnchain(
  registry: GiwaDeploymentRegistry,
  client: PublicClient,
): Promise<RegistryValidationResult> {
  const local = validateGiwaRegistry(registry)
  const errors = [...local.errors]
  const warnings = [...local.warnings]

  if (!registry.activationFlags.deployed) {
    warnings.push("Onchain attestation skipped because registry is marked not-yet-deployed")
    return { ok: errors.length === 0, errors, warnings, eventMismatches: local.eventMismatches }
  }

  const chainId = await client.getChainId()
  if (chainId !== GIWA_CHAIN_ID) errors.push(`RPC chainId ${chainId} does not match GIWA chainId ${GIWA_CHAIN_ID}`)

  const addresses = [
    registry.proxyAdmin.proxy,
    registry.faucet.proxy,
    ...registry.assets.map((asset) => asset.contract.proxy),
    ...registry.products.flatMap((product) => [
      product.productToken.proxy,
      product.depositVault.proxy,
      product.redemptionVault.proxy,
      product.priceFeed.proxy,
    ]),
  ].filter(addressPresent)

  for (const address of addresses) {
    const bytecode = await client.getBytecode({ address })
    if (!bytecode || bytecode === ZERO_BYTECODE) errors.push(`No bytecode at ${address}`)
  }

  return { ok: errors.length === 0, errors, warnings, eventMismatches: local.eventMismatches }
}
