import { getAddress, isAddress } from "viem"
import { assertRequiredPaymentAsset } from "./catalog"
import { ARCO_API_BASE, GIWA_CHAIN_ID } from "./config"
import type {
  FaucetStatus,
  GiwaActivity,
  GiwaAsset,
  GiwaCatalogItem,
  GiwaFeaturedCard,
  GiwaPauseState,
  GiwaPortfolio,
  GiwaProduct,
  GiwaRedemption,
  GiwaRegistry,
  GiwaVaultConfig,
  HexAddress,
  UnsignedAdminTransaction,
} from "./types"

type GiwaVaultFeedSide = {
  productPriceFeed: string
  paymentPriceFeed: string
  paymentEqualsProduct: boolean
  productMatchesRegistry: boolean
}

export type GiwaVaultFeeds = {
  registryPriceFeed: string | null
  depositVault: GiwaVaultFeedSide
  redemptionVault: GiwaVaultFeedSide
  warnings: string[]
}

export type GiwaMarketEntry = {
  productId: string
  navBase: number | null
  baseUsd: number | null
  navUsd: number | null
  apy: number | null
  impliedApy: number | null
}

// Current per-vault limits, already de-scaled to HUMAN units by the server (whole tokens/shares).
export type GiwaVaultLimits = {
  limits: {
    deposit: { minimumDeposit: string; maxSupplyCap: string; vaultMintAllowance: string }
    redemption: { minimumRedeem: string; vaultRedeemAllowance: string }
  }
  paymentDecimals: number
  shareDecimals: number
}
export type GiwaPriceHistoryPoint = { t: number; navBase: number; navUsd: number | null }
export type GiwaPriceHistory = { productId: string; apy: number | null; points: GiwaPriceHistoryPoint[] }

export type GiwaMonitoringOverview = {
  chainId: number
  asOf: string
  vaultCount: number
  tvlUsd: number | null
  pendingOutstandingCount: number
  pendingOutstandingUsd: number | null
  pendingTodayCount: number
  pendingTodayUsd: number | null
  complete: { tvl: boolean; pending: boolean }
}
export type GiwaMonitoringVault = {
  productId: string
  symbol: string
  paymentAssetSymbol: string
  navBase: number | null
  navUsd: number | null
  apy: number | null
  totalSupplyHuman: number | null
  tvlUsd: number | null
  depositorCount: number | null
  pendingCount: number
  pendingUsd: number | null
  trends: { netDeposit: number[]; apy: number[] }
}
export type GiwaMonitoringTrendPoint = { t: number; value: number }
export type GiwaMonitoringFlowPoint = { seq: number; blockNumber: string; value: number }
export type GiwaMonitoringDetail = {
  productId: string
  symbol: string
  paymentAssetSymbol: string
  trends: {
    nav: GiwaMonitoringTrendPoint[]
    apy: GiwaMonitoringTrendPoint[]
    netDeposit: GiwaMonitoringFlowPoint[]
    totalTokenShare: GiwaMonitoringFlowPoint[]
    pendingWithdrawals: GiwaMonitoringTrendPoint[]
  }
  depositors: { address: string; balanceHuman: number }[]
  requesters: { address: string; requestId: string; status: string; sharesInHuman: number; valueUsd: number | null }[]
}

function endpoint(path: string) {
  return `${ARCO_API_BASE.replace(/\/$/, "")}${path}`
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...init?.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed: ${response.status}`)
  }
  return body as T
}

/**
 * Credentials for one admin request. The customer app's legacy /admin pages send the shared operator
 * token; the admin console sends the signed SIWE operator session. api.ts never stores either.
 */
export type AdminAuth = {
  /** False until a credential exists (no token typed, no session): admin queries stay idle. */
  readonly ready: boolean
  /** Credential headers for one request. */
  headers(): Record<string, string>
  /** Told when the server rejects the credential (401) or the permission (403). */
  onAuthFailure?(status: 401 | 403): void
}

/** An admin API refusal; `status` lets a caller tell an expired session (401) from a missing permission (403). */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = "AdminApiError"
  }
}

/** Legacy: the shared operator token typed into the customer app's /admin pages. */
export function operatorTokenAuth(token: string): AdminAuth {
  return { ready: token.length > 0, headers: () => ({ "x-operator-token": token }) }
}

/** The admin console: the SIWE operator session issued by /api/v1/auth/verify (kept in memory only). */
export function bearerSessionAuth(accessToken: string | null, onAuthFailure?: (status: 401 | 403) => void): AdminAuth {
  return {
    ready: Boolean(accessToken),
    headers: (): Record<string, string> => (accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    onAuthFailure,
  }
}

async function adminJson<T>(auth: AdminAuth, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    credentials: "omit",
    headers: {
      accept: "application/json",
      // Only a request with a body declares one (a bodiless JSON DELETE is rejected by the server).
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...auth.headers(),
    },
  })
  const text = await response.text()
  let body: { error?: unknown; code?: unknown } | null = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) auth.onAuthFailure?.(response.status)
    const message = typeof body?.error === "string" ? body.error : `Request failed: ${response.status}`
    throw new AdminApiError(message, response.status, typeof body?.code === "string" ? body.code : null)
  }
  return body as T
}

export function asAddress(value: unknown): HexAddress | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null
}

function assetAddress(asset: GiwaAsset | null | undefined) {
  return asAddress(asset?.tokenAddress ?? asset?.contract?.proxy)
}

function productAddress(product: GiwaProduct, key: "productToken" | "depositVault" | "redemptionVault" | "priceFeed") {
  const fallbackKey = `${key}Address` as keyof GiwaProduct
  return asAddress(product[fallbackKey] ?? product[key]?.proxy)
}

export function normalizeCatalog(raw: unknown): GiwaCatalogItem[] {
  const products = Array.isArray(raw) ? raw : []
  return products.map((item) => {
    const product = item as GiwaProduct
    const paymentAsset = product.paymentAsset ?? null
    const normalized = {
      ...product,
      paymentAsset,
      paymentAssetAddress: asAddress(product.paymentAssetAddress) ?? assetAddress(paymentAsset),
      productTokenAddress: productAddress(product, "productToken"),
      depositVaultAddress: productAddress(product, "depositVault"),
      redemptionVaultAddress: productAddress(product, "redemptionVault"),
      priceFeedAddress: productAddress(product, "priceFeed"),
    }
    assertRequiredPaymentAsset(normalized)
    return normalized
  })
}

export function hasDeploymentAddresses(product: GiwaCatalogItem) {
  return Boolean(
    product.productTokenAddress &&
      product.paymentAssetAddress &&
      product.depositVaultAddress &&
      product.redemptionVaultAddress &&
      product.priceFeedAddress,
  )
}

function redemptionPath(productId: string, requestId: string, action: "payout" | "settle" | "release" | "fulfill") {
  return `/api/v1/admin/products/${encodeURIComponent(productId)}/redemptions/${encodeURIComponent(requestId)}/${action}`
}

export const giwaApi = {
  registry: () => fetchJson<GiwaRegistry>(`/api/v1/evm/registry/${GIWA_CHAIN_ID}`),
  catalog: async () => normalizeCatalog(await fetchJson<unknown>(`/api/v1/evm/catalog/${GIWA_CHAIN_ID}`)),
  // Public hero-carousel read: SHOWN-only, ordered (the server filters hidden cards out).
  featured: () =>
    fetchJson<{ cards: GiwaFeaturedCard[] }>(`/api/v1/evm/featured/${GIWA_CHAIN_ID}`).then((response) => response.cards),
  portfolio: (wallet: string) => fetchJson<GiwaPortfolio>(`/api/v1/portfolio/${wallet}`),
  activity: (wallet: string) => fetchJson<GiwaActivity[]>(`/api/v1/activity/${wallet}`),
  redemptions: (wallet: string) => fetchJson<GiwaRedemption[]>(`/api/v1/redemptions/${wallet}`),
  faucetStatus: (wallet: string) => fetchJson<FaucetStatus>(`/api/v1/faucet/${wallet}/status`),
  market: (chainId: number) => fetchJson<GiwaMarketEntry[]>(`/api/v1/evm/market/${chainId}`),
  priceHistory: (chainId: number, productId: string) =>
    fetchJson<GiwaPriceHistory>(`/api/v1/evm/market/${chainId}/${productId}/history`),
  monitoring: {
    overview: (auth: AdminAuth, chainId: number) =>
      adminJson<GiwaMonitoringOverview>(auth, `/api/v1/admin/monitoring/${chainId}/overview`),
    vaults: (auth: AdminAuth, chainId: number) =>
      adminJson<{ vaults: GiwaMonitoringVault[] }>(auth, `/api/v1/admin/monitoring/${chainId}/vaults`),
    detail: (auth: AdminAuth, chainId: number, productId: string) =>
      adminJson<GiwaMonitoringDetail>(auth, `/api/v1/admin/monitoring/${chainId}/products/${productId}`),
  },
  admin: {
    greenlist: (auth: AdminAuth, wallet: string) =>
      adminJson<{ transactions: UnsignedAdminTransaction[] }>(auth, `/api/v1/admin/wallets/${wallet}/greenlist`, {
        method: "POST",
        body: "{}",
      }),
    price: (auth: AdminAuth, productId: string, answer: string) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, `/api/v1/admin/products/${productId}/price`, {
        method: "POST",
        body: JSON.stringify({ answer }),
      }),
    setHealthyDiff: (auth: AdminAuth, productId: string, seconds: string) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, `/api/v1/admin/products/${productId}/healthy-diff`, {
        method: "POST",
        body: JSON.stringify({ seconds }),
      }),
    pause: (auth: AdminAuth, productId: string, target: "depositVault" | "redemptionVault" | "allVaults") =>
      adminJson<{ transactions: UnsignedAdminTransaction[] }>(auth, `/api/v1/admin/products/${productId}/pause`, {
        method: "POST",
        body: JSON.stringify({ target }),
      }),
    unpause: (auth: AdminAuth, productId: string, target: "depositVault" | "redemptionVault" | "allVaults") =>
      adminJson<{ transactions: UnsignedAdminTransaction[] }>(auth, `/api/v1/admin/products/${productId}/unpause`, {
        method: "POST",
        body: JSON.stringify({ target }),
      }),
    liquidity: (auth: AdminAuth, productId: string, amount: string) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, `/api/v1/admin/products/${productId}/liquidity`, {
        method: "POST",
        body: JSON.stringify({ amount }),
      }),
    // Per-vault limits. The two setters send HUMAN units and return an unsigned setLimits tx (the
    // server scales per decimals); `limits` reads the current values already de-scaled to human.
    setDepositLimits: (
      auth: AdminAuth,
      productId: string,
      limits: { minimumDeposit: string; maxSupplyCap: string; vaultMintAllowance: string },
    ) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, `/api/v1/admin/products/${productId}/deposit-limits`, {
        method: "POST",
        body: JSON.stringify(limits),
      }),
    setRedemptionLimits: (
      auth: AdminAuth,
      productId: string,
      limits: { minimumRedeem: string; vaultRedeemAllowance: string },
    ) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, `/api/v1/admin/products/${productId}/redemption-limits`, {
        method: "POST",
        body: JSON.stringify(limits),
      }),
    limits: (auth: AdminAuth, productId: string) =>
      adminJson<GiwaVaultLimits>(auth, `/api/v1/admin/products/${productId}/limits`),
    // Both vaults' price-feed wiring + warnings (payment feed == product feed → quotes are 1:1).
    feeds: (auth: AdminAuth, productId: string) =>
      adminJson<GiwaVaultFeeds>(auth, `/api/v1/admin/products/${encodeURIComponent(productId)}/feeds`),
    // Redemption actions are product-scoped: every redemption vault numbers requests from 1.
    fulfill: (auth: AdminAuth, productId: string, requestId: string) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, redemptionPath(productId, requestId, "fulfill"), {
        method: "POST",
        body: "{}",
      }),
    withdraw: (auth: AdminAuth, productId: string, to: string, amount: string) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, `/api/v1/admin/products/${productId}/withdraw`, {
        method: "POST",
        body: JSON.stringify({ to, amount }),
      }),
    // Live (uncached) pause reads for every registry product; 503 when the RPC sweep fails.
    pauseState: (auth: AdminAuth) =>
      adminJson<{ readAt: string; pauseState: Record<string, GiwaPauseState> }>(auth, `/api/v1/admin/pause-state`),
    pendingRedemptions: (auth: AdminAuth) =>
      adminJson<{ redemptions: GiwaRedemption[] }>(auth, `/api/v1/admin/redemptions/pending`),
    payout: (auth: AdminAuth, productId: string, requestId: string, amount: string) =>
      adminJson<{ transaction: UnsignedAdminTransaction }>(auth, redemptionPath(productId, requestId, "payout"), {
        method: "POST",
        body: JSON.stringify({ amount }),
      }),
    settle: (auth: AdminAuth, productId: string, requestId: string, txHash: string) =>
      adminJson<{ ok: boolean }>(auth, redemptionPath(productId, requestId, "settle"), {
        method: "POST",
        body: JSON.stringify({ txHash }),
      }),
    release: (auth: AdminAuth, productId: string, requestId: string) =>
      adminJson<{ ok: boolean }>(auth, redemptionPath(productId, requestId, "release"), {
        method: "POST",
        body: "{}",
      }),
    functionPause: (auth: AdminAuth, productId: string, kind: "deposit" | "withdraw", paused: boolean) =>
      adminJson<{ transactions: UnsignedAdminTransaction[] }>(auth, `/api/v1/admin/products/${productId}/function-pause`, {
        method: "POST",
        body: JSON.stringify({ kind, paused }),
      }),
    registerProduct: (
      auth: AdminAuth,
      productId: string,
      addresses: { productToken: string; depositVault: string; redemptionVault: string; priceFeed: string },
    ) =>
      adminJson<{
        ok: boolean
        productId: string
        symbol: string
        hidden: boolean
        unverified: string[]
        warnings?: string[]
        proxyAdminOwner: string | null
      }>(auth, `/api/v1/admin/registry/register-product`, {
        method: "POST",
        body: JSON.stringify({ productId, addresses }),
      }),
    vaultConfigs: (auth: AdminAuth) =>
      adminJson<{ configs: ({ productId: string; symbol: string } & GiwaVaultConfig)[] }>(auth, `/api/v1/admin/vault-config/${GIWA_CHAIN_ID}`),
    saveVaultConfig: (auth: AdminAuth, productId: string, patch: Partial<GiwaVaultConfig>) =>
      adminJson<{ productId: string } & GiwaVaultConfig>(auth, `/api/v1/admin/vault-config/${GIWA_CHAIN_ID}/${productId}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    // Global cross-vault Savings selector order: the flat ordered list of { productId, symbol }; the
    // server assigns sortOrder = index and rewrites only that field (atomic across vaults).
    saveSavingsOrder: (auth: AdminAuth, order: Array<{ productId: string; symbol: string }>) =>
      adminJson<{ ok: boolean; updated: string[] }>(auth, `/api/v1/admin/savings-order/${GIWA_CHAIN_ID}`, {
        method: "PUT",
        body: JSON.stringify({ order }),
      }),
    // Featured cards (products-page hero carousel). `featured` lists every row (hidden +
    // shown); `addFeatured` creates one hidden by default; save/remove mutate by row id.
    featured: (auth: AdminAuth) =>
      adminJson<{ cards: GiwaFeaturedCard[] }>(auth, `/api/v1/admin/featured/${GIWA_CHAIN_ID}`).then((response) => response.cards),
    addFeatured: (auth: AdminAuth, input: { productId: string; about?: string | null; shown?: boolean }) =>
      adminJson<GiwaFeaturedCard>(auth, `/api/v1/admin/featured/${GIWA_CHAIN_ID}`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    saveFeatured: (
      auth: AdminAuth,
      id: string,
      patch: Partial<Pick<GiwaFeaturedCard, "about" | "shown" | "position">>,
    ) =>
      adminJson<GiwaFeaturedCard>(auth, `/api/v1/admin/featured/${GIWA_CHAIN_ID}/${id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    removeFeatured: (auth: AdminAuth, id: string) =>
      adminJson<{ ok: boolean; id: string }>(auth, `/api/v1/admin/featured/${GIWA_CHAIN_ID}/${id}`, {
        method: "DELETE",
      }),
  },
}
