import { getAddress, isAddress } from "viem"
import { assertRequiredPaymentAsset } from "./catalog"
import { ARCO_API_BASE, GIWA_CHAIN_ID } from "./config"
import type {
  FaucetStatus,
  GiwaActivity,
  GiwaAsset,
  GiwaCatalogItem,
  GiwaFeaturedCard,
  GiwaPortfolio,
  GiwaProduct,
  GiwaRedemption,
  GiwaRegistry,
  GiwaVaultConfig,
  HexAddress,
  UnsignedAdminTransaction,
} from "./types"

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
    overview: (operatorToken: string, chainId: number) =>
      fetchJson<GiwaMonitoringOverview>(`/api/v1/admin/monitoring/${chainId}/overview`, {
        headers: { "x-operator-token": operatorToken },
      }),
    vaults: (operatorToken: string, chainId: number) =>
      fetchJson<{ vaults: GiwaMonitoringVault[] }>(`/api/v1/admin/monitoring/${chainId}/vaults`, {
        headers: { "x-operator-token": operatorToken },
      }),
    detail: (operatorToken: string, chainId: number, productId: string) =>
      fetchJson<GiwaMonitoringDetail>(`/api/v1/admin/monitoring/${chainId}/products/${productId}`, {
        headers: { "x-operator-token": operatorToken },
      }),
  },
  admin: {
    greenlist: (operatorToken: string, wallet: string) =>
      fetchJson<{ transactions: UnsignedAdminTransaction[] }>(`/api/v1/admin/wallets/${wallet}/greenlist`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: "{}",
      }),
    price: (operatorToken: string, productId: string, answer: string) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/products/${productId}/price`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ answer }),
      }),
    setHealthyDiff: (operatorToken: string, productId: string, seconds: string) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/products/${productId}/healthy-diff`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ seconds }),
      }),
    pause: (operatorToken: string, productId: string, target: "depositVault" | "redemptionVault" | "allVaults") =>
      fetchJson<{ transactions: UnsignedAdminTransaction[] }>(`/api/v1/admin/products/${productId}/pause`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ target }),
      }),
    unpause: (operatorToken: string, productId: string, target: "depositVault" | "redemptionVault" | "allVaults") =>
      fetchJson<{ transactions: UnsignedAdminTransaction[] }>(`/api/v1/admin/products/${productId}/unpause`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ target }),
      }),
    liquidity: (operatorToken: string, productId: string, amount: string) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/products/${productId}/liquidity`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ amount }),
      }),
    // Per-vault limits. The two setters send HUMAN units and return an unsigned setLimits tx (the
    // server scales per decimals); `limits` reads the current values already de-scaled to human.
    setDepositLimits: (
      operatorToken: string,
      productId: string,
      limits: { minimumDeposit: string; maxSupplyCap: string; vaultMintAllowance: string },
    ) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/products/${productId}/deposit-limits`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify(limits),
      }),
    setRedemptionLimits: (
      operatorToken: string,
      productId: string,
      limits: { minimumRedeem: string; vaultRedeemAllowance: string },
    ) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/products/${productId}/redemption-limits`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify(limits),
      }),
    limits: (operatorToken: string, productId: string) =>
      fetchJson<GiwaVaultLimits>(`/api/v1/admin/products/${productId}/limits`, {
        headers: { "x-operator-token": operatorToken },
      }),
    fulfill: (operatorToken: string, requestId: string) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/redemptions/${requestId}/fulfill`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: "{}",
      }),
    withdraw: (operatorToken: string, productId: string, to: string, amount: string) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/products/${productId}/withdraw`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ to, amount }),
      }),
    pendingRedemptions: (operatorToken: string) =>
      fetchJson<{ redemptions: GiwaRedemption[] }>(`/api/v1/admin/redemptions/pending`, {
        headers: { "x-operator-token": operatorToken },
      }),
    payout: (operatorToken: string, requestId: string, amount: string) =>
      fetchJson<{ transaction: UnsignedAdminTransaction }>(`/api/v1/admin/redemptions/${requestId}/payout`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ amount }),
      }),
    settle: (operatorToken: string, requestId: string, txHash: string) =>
      fetchJson<{ ok: boolean }>(`/api/v1/admin/redemptions/${requestId}/settle`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ txHash }),
      }),
    release: (operatorToken: string, requestId: string) =>
      fetchJson<{ ok: boolean }>(`/api/v1/admin/redemptions/${requestId}/release`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: "{}",
      }),
    functionPause: (operatorToken: string, productId: string, kind: "deposit" | "withdraw", paused: boolean) =>
      fetchJson<{ transactions: UnsignedAdminTransaction[] }>(`/api/v1/admin/products/${productId}/function-pause`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ kind, paused }),
      }),
    registerProduct: (
      operatorToken: string,
      productId: string,
      addresses: { productToken: string; depositVault: string; redemptionVault: string; priceFeed: string },
    ) =>
      fetchJson<{
        ok: boolean
        productId: string
        symbol: string
        hidden: boolean
        unverified: string[]
        proxyAdminOwner: string | null
      }>(`/api/v1/admin/registry/register-product`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ productId, addresses }),
      }),
    vaultConfigs: (operatorToken: string) =>
      fetchJson<{ configs: ({ productId: string; symbol: string } & GiwaVaultConfig)[] }>(
        `/api/v1/admin/vault-config/${GIWA_CHAIN_ID}`,
        { headers: { "x-operator-token": operatorToken } },
      ),
    saveVaultConfig: (operatorToken: string, productId: string, patch: Partial<GiwaVaultConfig>) =>
      fetchJson<{ productId: string } & GiwaVaultConfig>(`/api/v1/admin/vault-config/${GIWA_CHAIN_ID}/${productId}`, {
        method: "PUT",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify(patch),
      }),
    // Global cross-vault Savings selector order: the flat ordered list of { productId, symbol }; the
    // server assigns sortOrder = index and rewrites only that field (atomic across vaults).
    saveSavingsOrder: (operatorToken: string, order: Array<{ productId: string; symbol: string }>) =>
      fetchJson<{ ok: boolean; updated: string[] }>(`/api/v1/admin/savings-order/${GIWA_CHAIN_ID}`, {
        method: "PUT",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify({ order }),
      }),
    // Featured cards (products-page hero carousel). `featured` lists every row (hidden +
    // shown); `addFeatured` creates one hidden by default; save/remove mutate by row id.
    featured: (operatorToken: string) =>
      fetchJson<{ cards: GiwaFeaturedCard[] }>(`/api/v1/admin/featured/${GIWA_CHAIN_ID}`, {
        headers: { "x-operator-token": operatorToken },
      }).then((response) => response.cards),
    addFeatured: (operatorToken: string, input: { productId: string; about?: string | null; shown?: boolean }) =>
      fetchJson<GiwaFeaturedCard>(`/api/v1/admin/featured/${GIWA_CHAIN_ID}`, {
        method: "POST",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify(input),
      }),
    saveFeatured: (
      operatorToken: string,
      id: string,
      patch: Partial<Pick<GiwaFeaturedCard, "about" | "shown" | "position">>,
    ) =>
      fetchJson<GiwaFeaturedCard>(`/api/v1/admin/featured/${GIWA_CHAIN_ID}/${id}`, {
        method: "PUT",
        headers: { "x-operator-token": operatorToken },
        body: JSON.stringify(patch),
      }),
    removeFeatured: (operatorToken: string, id: string) =>
      fetchJson<{ ok: boolean; id: string }>(`/api/v1/admin/featured/${GIWA_CHAIN_ID}/${id}`, {
        method: "DELETE",
        headers: { "x-operator-token": operatorToken },
      }),
  },
}
