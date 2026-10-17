import { isAddress } from "viem"
import { registryToSyncInput } from "../registry/validation.js"
import type { GiwaDeploymentRegistry } from "../registry/types.js"
import type { PrismaArcoService } from "./prisma-arco-service.js"

// 2c-1 "Register deployed vault": brings a product that the deploy HARNESS already
// deployed (and wrote into the registry FILE) into the served DB registry + creates its
// hidden VaultConfig row. The registry file is the source of truth; the pasted addresses
// are a cross-check against it, and the chain is probed before anything is written.
//
// SECURITY NOTE: ProxyAdmin OWNERSHIP and implementation-BYTECODE EQUIVALENCE are only
// partially verified here (hard checks run where the registry records a reference; the
// rest is surfaced in `unverified`). Both MUST be fully verified before any mainnet use.

export type ProxySlot = "productToken" | "depositVault" | "redemptionVault" | "priceFeed"
export const PROXY_SLOTS: readonly ProxySlot[] = ["productToken", "depositVault", "redemptionVault", "priceFeed"]

export type RegisterProbe = {
  code: Record<ProxySlot, boolean>
  token: { symbol: string | null; name: string | null; decimals: number | null }
  depositPaymentToken: string | null
  redemptionPaymentToken: string | null
  roles: {
    feedAdmin: boolean
    depositVaultAdmin: boolean
    depositPauser: boolean
    redemptionVaultAdmin: boolean
    redemptionPauser: boolean
    minterIsDepositVault: boolean
    burnerIsRedemptionVault: boolean
  }
  proxyAdmins: Record<ProxySlot, string | null>
  implementations: Record<ProxySlot, string | null>
  implCodeHashes: Record<ProxySlot, string | null>
  proxyAdminOwner: string | null
  /** productPriceFeed()/paymentPriceFeed() of both vaults. Optional: absent → "priceFeeds" unverified. */
  feeds?: {
    depositProduct: string | null
    depositPayment: string | null
    redemptionProduct: string | null
    redemptionPayment: string | null
  }
}

export type RegisterInput = {
  productId: string
  addresses: Record<ProxySlot, string>
}

export type RegisterResult = {
  ok: true
  productId: string
  symbol: string
  hidden: true
  // What was NOT verified on-chain against a recorded reference — surfaced so the
  // operator sees exactly what is being trusted. Must be empty before mainnet use.
  unverified: string[]
  // Registered anyway, but the operator must act (e.g. payment feed == product feed means every
  // quote is 1:1 regardless of NAV until the payment-feed repair runs).
  warnings: string[]
  proxyAdminOwner: string | null
}

export class RegisterError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message)
  }
}

function lower(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null
}

export class EvmRegisterService {
  constructor(
    private readonly deps: {
      arco: Pick<PrismaArcoService, "upsertProductDeployment" | "upsertVaultConfig">
      loadRegistry: () => GiwaDeploymentRegistry
      probeProduct?: (
        product: GiwaDeploymentRegistry["products"][number],
        registry: GiwaDeploymentRegistry,
      ) => Promise<RegisterProbe | null>
    },
  ) {}

  async register(chainId: number, input: RegisterInput): Promise<RegisterResult> {
    const registry = this.deps.loadRegistry()
    if (registry.chainId !== chainId) throw new RegisterError(409, `Registry file is for chainId ${registry.chainId}`)

    const product = registry.products.find((candidate) => candidate.productId === input.productId)
    if (!product) {
      throw new RegisterError(
        409,
        `Product ${input.productId} is not in the registry file the server reads — run the deploy harness first and make sure the server sees the harness-updated registry file (same machine/commit).`,
      )
    }

    for (const slot of PROXY_SLOTS) {
      const pasted = input.addresses[slot]
      if (typeof pasted !== "string" || !isAddress(pasted)) {
        throw new RegisterError(400, `${slot} must be a valid address`)
      }
      if (lower(pasted) !== lower(product[slot].proxy)) {
        throw new RegisterError(400, `${slot} address does not match the registry file for ${product.symbol}`)
      }
    }

    if (!this.deps.probeProduct) throw new RegisterError(503, "On-chain register probe unavailable")
    const probe = await this.deps.probeProduct(product, registry)
    if (!probe) throw new RegisterError(503, "On-chain register probe failed — check the RPC and retry")

    for (const slot of PROXY_SLOTS) {
      if (!probe.code[slot]) throw new RegisterError(400, `No bytecode at ${slot} ${product[slot].proxy}`)
    }
    if (probe.token.symbol !== product.symbol) {
      throw new RegisterError(400, `ProductToken symbol ${probe.token.symbol} does not match ${product.symbol}`)
    }
    if (probe.token.name !== product.name) {
      throw new RegisterError(400, `ProductToken name ${probe.token.name} does not match ${product.name}`)
    }
    if (probe.token.decimals !== 18) {
      throw new RegisterError(400, `ProductToken decimals must be 18, got ${probe.token.decimals}`)
    }
    const paymentAsset = registry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)
    if (!paymentAsset?.contract.proxy) {
      throw new RegisterError(400, `Payment asset ${product.paymentAssetSymbol} is not in the registry file`)
    }
    if (lower(probe.depositPaymentToken) !== lower(paymentAsset.contract.proxy)) {
      throw new RegisterError(400, "Deposit vault paymentToken() does not match the declared payment asset")
    }
    if (lower(probe.redemptionPaymentToken) !== lower(paymentAsset.contract.proxy)) {
      throw new RegisterError(400, "Redemption vault paymentToken() does not match the declared payment asset")
    }
    const missingRoles = Object.entries(probe.roles)
      .filter(([, granted]) => !granted)
      .map(([role]) => role)
    if (missingRoles.length) {
      throw new RegisterError(400, `Missing on-chain role wiring: ${missingRoles.join(", ")}`)
    }

    // Custody hard checks where the registry records a reference; everything else is
    // reported (not silently trusted). MUST be fully verified before any mainnet use.
    const unverified: string[] = []
    const expectedProxyAdmin = lower(registry.proxyAdmin?.proxy)
    for (const slot of PROXY_SLOTS) {
      const onchainAdmin = lower(probe.proxyAdmins[slot])
      if (expectedProxyAdmin && onchainAdmin) {
        if (onchainAdmin !== expectedProxyAdmin) {
          throw new RegisterError(400, `${slot} proxy admin ${probe.proxyAdmins[slot]} does not match the registry ProxyAdmin`)
        }
      } else {
        unverified.push(`proxyAdmin:${slot}`)
      }

      const recordedImpl = lower(product[slot].implementation)
      const onchainImpl = lower(probe.implementations[slot])
      if (recordedImpl && onchainImpl) {
        if (onchainImpl !== recordedImpl) {
          throw new RegisterError(400, `${slot} implementation ${probe.implementations[slot]} does not match the registry record`)
        }
      } else {
        unverified.push(`implementation:${slot}`)
      }

      const recordedHash = product[slot].bytecodeHash ?? null
      const onchainHash = probe.implCodeHashes[slot]
      if (recordedHash && onchainHash) {
        if (recordedHash.toLowerCase() !== onchainHash.toLowerCase()) {
          throw new RegisterError(400, `${slot} implementation bytecode hash does not match the registry record`)
        }
      } else {
        unverified.push(`implBytecode:${slot}`)
      }
    }
    // owner() of the ProxyAdmin has no recorded reference — always surfaced for review.
    unverified.push("proxyAdminOwner")

    // Price feeds: both vaults must quote NAV from the registry's product feed; a payment feed
    // equal to the product feed (deploy-giwa.ts passes the same feed twice) prices every
    // quote 1:1 — registered, but flagged for the payment-feed repair.
    const warnings: string[] = []
    if (probe.feeds) {
      const expectedFeed = lower(product.priceFeed.proxy)
      const vaultFeeds = [
        ["depositVault", probe.feeds.depositProduct, probe.feeds.depositPayment],
        ["redemptionVault", probe.feeds.redemptionProduct, probe.feeds.redemptionPayment],
      ] as const
      for (const [vault, productFeed, paymentFeed] of vaultFeeds) {
        if (!productFeed || lower(productFeed) !== expectedFeed) {
          throw new RegisterError(400, `${vault} productPriceFeed ${productFeed} does not match the registry priceFeed`)
        }
        if (!paymentFeed) throw new RegisterError(400, `${vault} paymentPriceFeed is unset`)
        if (lower(paymentFeed) === lower(productFeed)) {
          warnings.push(
            `${vault} paymentPriceFeed equals productPriceFeed — quotes ignore NAV (1:1) until the payment-feed repair runs`,
          )
        }
      }
    } else {
      unverified.push("priceFeeds")
    }

    const syncInput = registryToSyncInput(registry)
    const syncProduct = syncInput.products.find((candidate) => candidate.productId === input.productId)
    if (!syncProduct) throw new RegisterError(409, `Product ${input.productId} could not be mapped for sync`)
    await this.deps.arco.upsertProductDeployment(chainId, syncInput.releaseId, syncProduct)
    // New vaults start hidden (§2): visible only in the admin UI until un-hidden.
    await this.deps.arco.upsertVaultConfig({ chainId, productId: input.productId, hidden: true })

    return {
      ok: true,
      productId: input.productId,
      symbol: product.symbol,
      hidden: true,
      unverified,
      warnings,
      proxyAdminOwner: probe.proxyAdminOwner,
    }
  }
}
