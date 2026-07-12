import { execFileSync } from "node:child_process"
import {
  GIWA_BLOCKSCOUT_API_URL,
  GIWA_CHAIN_ID,
  GIWA_EXPLORER_BASE_URL,
  GIWA_NAME,
  GIWA_NETWORK,
  GIWA_PUBLIC_RPC_URL,
  PLAN_TARGET_INDEXED_EVENTS,
  REQUIRED_PAYMENT_ASSETS,
  REQUIRED_PRODUCTS,
  REQUIRED_PRODUCT_PAYMENT_MAPPINGS,
} from "./products.js"
import type {
  AddressValue,
  ContractDeployment,
  GiwaDeploymentRegistry,
  RegistryAsset,
  RegistryProduct,
} from "./types.js"
import { resolveEventMismatches, resolveIndexedEventDefinitions } from "../evm/abi.js"

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return "unknown"
  }
}

function emptyContract(): ContractDeployment {
  return {
    proxy: null,
    implementation: null,
    bytecodeHash: null,
  }
}

function nullRoles() {
  return {
    tier1DefaultAdmin: null as AddressValue,
    tier1ProxyAdminOwner: null as AddressValue,
    tier1Safe: null as AddressValue,
    tier1Timelock: null as AddressValue,
    tier2Operator: null as AddressValue,
    pauser: null as AddressValue,
    feedAdmin: null as AddressValue,
    faucetAdmin: null as AddressValue,
  }
}

export function buildDryRunGiwaRegistry(now: Date = new Date()): GiwaDeploymentRegistry {
  const assets: RegistryAsset[] = REQUIRED_PAYMENT_ASSETS.map((asset) => ({
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    contract: emptyContract(),
    faucet: null,
    deploymentBlock: null,
  }))

  const products: RegistryProduct[] = REQUIRED_PRODUCTS.map((product) => ({
    productId: product.productId,
    symbol: product.symbol,
    name: product.name,
    paymentAssetSymbol: product.paymentAssetSymbol,
    productToken: emptyContract(),
    depositVault: emptyContract(),
    redemptionVault: emptyContract(),
    priceFeed: emptyContract(),
    deploymentBlock: null,
    activationFlags: {
      deployed: false,
      depositsEnabled: false,
      redemptionsEnabled: false,
      adminUiEnabled: false,
    },
  }))

  return {
    schemaVersion: 1,
    releaseId: `giwa-preprod-dry-run-${now.toISOString().slice(0, 10)}`,
    gitCommit: gitCommit(),
    chainId: GIWA_CHAIN_ID,
    network: GIWA_NETWORK,
    name: GIWA_NAME,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    publicRpcUrl: GIWA_PUBLIC_RPC_URL,
    explorerBaseUrl: GIWA_EXPLORER_BASE_URL,
    blockscoutApiUrl: GIWA_BLOCKSCOUT_API_URL,
    deploymentBlock: null,
    deployer: null,
    evmVersion: "cancun",
    proxyAdmin: emptyContract(),
    roles: nullRoles(),
    activationFlags: {
      deployed: false,
      dryRun: true,
      frontendEnabled: false,
      indexerEnabled: false,
      onchainAttestationRequired: false,
    },
    assets,
    faucet: emptyContract(),
    products,
    productPaymentMappings: REQUIRED_PRODUCT_PAYMENT_MAPPINGS,
    events: {
      targetEvents: [...PLAN_TARGET_INDEXED_EVENTS],
      indexedEvents: resolveIndexedEventDefinitions(),
      mismatches: resolveEventMismatches(),
    },
  }
}
