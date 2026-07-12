import { REQUIRED_PAYMENT_ASSETS } from "../registry/products.js"
import type { GiwaDeploymentRegistry } from "../registry/types.js"
import { DAY_SECONDS, impliedApyPercent } from "./apy-math.js"
import type { EvmMarketService, MarketEntry } from "./evm-market-service.js"
import type { PrismaArcoService } from "./prisma-arco-service.js"

// Read-only admin monitoring aggregates, computed on-the-fly from already-indexed
// events plus on-chain supply/balance reads — no snapshot subsystem (v1).
//
// Timestamp constraint: EvmIndexedEvent has no block timestamp, so deposit/redeem
// trends are cumulative series ordered by (blockNumber, logIndex) ("by event"),
// not calendar-bucketed. Only PriceUpdated carries a real timestamp (args.updatedAt),
// so NAV/APY trends have true time axes. Calendar-accurate flow trends and
// depositor-count-over-time need a blockTimestamp column + backfill (v2).

const SHARE_FALLBACK_DECIMALS = 18
const SPARKLINE_POINTS = 20

const FLOW_EVENT_NAMES = [
  "ProductDeposit",
  "ProductDepositRequested",
  "ProductDepositFulfilled",
  "ProductRedeemInstant",
  "ProductRedeemRequested",
] as const

const PAYMENT_DECIMALS: Record<string, number> = Object.fromEntries(
  REQUIRED_PAYMENT_ASSETS.map((asset) => [asset.symbol, asset.decimals]),
)

export type MonitoringOverview = {
  readonly chainId: number
  readonly asOf: string
  readonly vaultCount: number
  readonly tvlUsd: number | null
  readonly pendingOutstandingCount: number
  readonly pendingOutstandingUsd: number | null
  readonly pendingTodayCount: number
  readonly pendingTodayUsd: number | null
  readonly complete: { readonly tvl: boolean; readonly pending: boolean }
}

export type MonitoringVaultEntry = {
  readonly productId: string
  readonly symbol: string
  readonly paymentAssetSymbol: string
  readonly navBase: number | null
  readonly navUsd: number | null
  readonly apy: number | null
  readonly totalSupplyHuman: number | null
  readonly tvlUsd: number | null
  readonly depositorCount: number | null
  readonly pendingCount: number
  readonly pendingUsd: number | null
  readonly trends: { readonly netDeposit: number[]; readonly apy: number[] }
}

export type MonitoringTrendPoint = { readonly t: number; readonly value: number }
export type MonitoringFlowPoint = { readonly seq: number; readonly blockNumber: string; readonly value: number }

export type MonitoringDetail = {
  readonly productId: string
  readonly symbol: string
  readonly paymentAssetSymbol: string
  readonly trends: {
    readonly nav: MonitoringTrendPoint[]
    readonly apy: MonitoringTrendPoint[]
    readonly netDeposit: MonitoringFlowPoint[]
    readonly totalTokenShare: MonitoringFlowPoint[]
    readonly pendingWithdrawals: MonitoringTrendPoint[]
  }
  readonly depositors: { readonly address: string; readonly balanceHuman: number }[]
  readonly requesters: {
    readonly address: string
    readonly requestId: string
    readonly status: string
    readonly sharesInHuman: number
    readonly valueUsd: number | null
  }[]
}

type IndexedEventRow = {
  eventName?: string
  blockNumber?: bigint | number | string
  logIndex?: number
  args?: Record<string, unknown> | null
}

type RedemptionRow = {
  productId?: string
  walletAddress?: string
  requestId?: string
  status?: string
  sharesIn?: string
  lockedAssetsOut?: string
  createdAt?: Date | string
  settledAt?: Date | string | null
  fulfilledAt?: Date | string | null
  claimedAt?: Date | string | null
}

type RegistryProduct = GiwaDeploymentRegistry["products"][number]

function argNumber(args: Record<string, unknown> | null | undefined, key: string): number {
  const value = Number((args ?? {})[key])
  return Number.isFinite(value) ? value : 0
}

function blockOrder(a: IndexedEventRow, b: IndexedEventRow): number {
  const blockA = BigInt(a.blockNumber ?? 0)
  const blockB = BigInt(b.blockNumber ?? 0)
  if (blockA !== blockB) return blockA < blockB ? -1 : 1
  return (a.logIndex ?? 0) - (b.logIndex ?? 0)
}

function toUnixSeconds(value: Date | string | null | undefined): number | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function isPending(status: string | undefined): boolean {
  return status === "REQUESTED" || status === "SETTLING"
}

export class EvmMonitoringService {
  constructor(
    private readonly deps: {
      arco: Pick<PrismaArcoService, "pendingRedemptions" | "indexedEventsForContracts" | "redemptionRequestsForChain">
      market: Pick<EvmMarketService, "market" | "history">
      loadRegistry: () => GiwaDeploymentRegistry
      readShareSupply?: (tokenAddress: string) => Promise<{ supply: string; decimals: number } | null>
      readTokenBalances?: (tokenAddress: string, addresses: string[]) => Promise<Record<string, string> | null>
    },
  ) {}

  private paymentDecimals(product: RegistryProduct): number {
    return PAYMENT_DECIMALS[product.paymentAssetSymbol] ?? SHARE_FALLBACK_DECIMALS
  }

  // Prefer the payment-asset quote locked at request time; fall back to shares × navUsd.
  // Rows that cannot be valued make the surrounding USD total null (counts stay exact).
  private pendingValueUsd(row: RedemptionRow, product: RegistryProduct, entry: MarketEntry | undefined): number | null {
    const locked = Number(row.lockedAssetsOut ?? "0")
    if (Number.isFinite(locked) && locked > 0) {
      const bu = entry?.baseUsd ?? null
      return bu != null ? (locked / 10 ** this.paymentDecimals(product)) * bu : null
    }
    const shares = Number(row.sharesIn ?? "0")
    if (!Number.isFinite(shares)) return null
    if (shares === 0) return 0
    return entry?.navUsd != null ? (shares / 10 ** SHARE_FALLBACK_DECIMALS) * entry.navUsd : null
  }

  private async flowEvents(chainId: number, product: RegistryProduct): Promise<IndexedEventRow[]> {
    const contracts = [product.depositVault.proxy, product.redemptionVault.proxy].filter(Boolean) as string[]
    if (!contracts.length) return []
    const rows = (await this.deps.arco.indexedEventsForContracts(chainId, contracts, [
      ...FLOW_EVENT_NAMES,
    ])) as IndexedEventRow[]
    return [...rows].sort(blockOrder)
  }

  // Cumulative net deposit (payment-asset human units) and share supply, by event order.
  // Inflow/outflow are counted at the event carrying the amount (deposits at deposit/request,
  // redemptions at instant/request — shares burn at request time).
  private flowSeries(events: IndexedEventRow[], payDecimals: number) {
    const netDeposit: MonitoringFlowPoint[] = []
    const totalTokenShare: MonitoringFlowPoint[] = []
    let net = 0
    let shares = 0
    events.forEach((event, index) => {
      const args = event.args ?? {}
      switch (event.eventName) {
        case "ProductDeposit":
          net += argNumber(args, "paymentAssets") / 10 ** payDecimals
          shares += argNumber(args, "sharesOut") / 10 ** SHARE_FALLBACK_DECIMALS
          break
        case "ProductDepositRequested":
          net += argNumber(args, "paymentAssets") / 10 ** payDecimals
          break
        case "ProductDepositFulfilled":
          shares += argNumber(args, "sharesOut") / 10 ** SHARE_FALLBACK_DECIMALS
          break
        case "ProductRedeemInstant":
        case "ProductRedeemRequested":
          net -= argNumber(args, "assetsOut") / 10 ** payDecimals
          shares -= argNumber(args, "sharesIn") / 10 ** SHARE_FALLBACK_DECIMALS
          break
        default:
          return
      }
      const blockNumber = String(event.blockNumber ?? "0")
      netDeposit.push({ seq: index, blockNumber, value: net })
      totalTokenShare.push({ seq: index, blockNumber, value: shares })
    })
    return { netDeposit, totalTokenShare }
  }

  private async apyTrend(chainId: number, productId: string): Promise<MonitoringTrendPoint[]> {
    const history = await this.deps.market.history(chainId, productId)
    const points: MonitoringTrendPoint[] = []
    for (let index = 1; index < history.points.length; index += 1) {
      const prev = history.points[index - 1]
      const point = history.points[index]
      const apy = impliedApyPercent(prev.navBase, point.navBase, (point.t - prev.t) / DAY_SECONDS)
      if (apy != null) points.push({ t: point.t, value: apy })
    }
    return points
  }

  // Distinct deposit recipients confirmed by a current on-chain balance > 0. Wallets that
  // only received tokens via plain ERC20 transfers are not seen here (Transfer events are
  // not indexed) — v2 alongside block timestamps.
  private async depositors(chainId: number, product: RegistryProduct) {
    if (!this.deps.readTokenBalances || !product.productToken.proxy) return null
    const events = await this.flowEvents(chainId, product)
    const candidates = new Set<string>()
    for (const event of events) {
      if (event.eventName !== "ProductDeposit" && event.eventName !== "ProductDepositFulfilled") continue
      const recipient = (event.args ?? {}).recipient
      if (typeof recipient === "string" && recipient) candidates.add(recipient.toLowerCase())
    }
    if (!candidates.size) return []
    const balances = await this.deps.readTokenBalances(product.productToken.proxy, [...candidates])
    if (!balances) return null
    return Object.entries(balances)
      .map(([address, balance]) => ({ address, balanceHuman: Number(balance) / 10 ** SHARE_FALLBACK_DECIMALS }))
      .filter((row) => Number.isFinite(row.balanceHuman) && row.balanceHuman > 0)
      .sort((a, b) => b.balanceHuman - a.balanceHuman)
  }

  async overview(chainId: number): Promise<MonitoringOverview> {
    const registry = this.deps.loadRegistry()
    const entries = await this.deps.market.market(chainId)
    const byProduct = new Map(entries.map((entry) => [entry.productId, entry]))

    // Aggregate TVL sums per-vault values treating unpriceable vaults as 0-contribution
    // (a vault with no deposits or no posted price must not null the whole sum). The
    // total is null ONLY when every vault is unpriceable; `complete.tvl` still flags
    // partial data so the UI can qualify the number.
    const perVaultTvl: (number | null)[] = []
    for (const product of registry.products) {
      if (!this.deps.readShareSupply || !product.productToken.proxy) {
        perVaultTvl.push(null)
        continue
      }
      const supply = await this.deps.readShareSupply(product.productToken.proxy)
      const supplyHuman = supply ? Number(supply.supply) / 10 ** supply.decimals : null
      if (supplyHuman == null || !Number.isFinite(supplyHuman)) {
        perVaultTvl.push(null)
        continue
      }
      if (supplyHuman === 0) {
        // Zero supply is exactly zero TVL regardless of whether a price exists.
        perVaultTvl.push(0)
        continue
      }
      const navUsd = byProduct.get(product.productId)?.navUsd ?? null
      perVaultTvl.push(navUsd == null ? null : supplyHuman * navUsd)
    }
    const tvlComplete = perVaultTvl.every((value) => value != null)
    const tvlUsd = perVaultTvl.every((value) => value == null)
      ? null
      : perVaultTvl.reduce<number>((sum, value) => sum + (value ?? 0), 0)

    const pending = (await this.deps.arco.pendingRedemptions(chainId)) as RedemptionRow[]
    const productById = new Map(registry.products.map((product) => [product.productId, product]))
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    let pendingComplete = true
    let outstandingUsd = 0
    let todayUsd = 0
    let todayCount = 0
    for (const row of pending) {
      const product = row.productId ? productById.get(row.productId) : undefined
      const value = product ? this.pendingValueUsd(row, product, byProduct.get(product.productId)) : null
      if (value == null) {
        pendingComplete = false
      } else {
        outstandingUsd += value
      }
      const createdAt = row.createdAt instanceof Date ? row.createdAt : row.createdAt ? new Date(row.createdAt) : null
      if (createdAt && createdAt >= todayStart) {
        todayCount += 1
        if (value != null) todayUsd += value
      }
    }

    return {
      chainId,
      asOf: new Date().toISOString(),
      vaultCount: registry.products.length,
      tvlUsd,
      pendingOutstandingCount: pending.length,
      pendingOutstandingUsd: pendingComplete ? outstandingUsd : null,
      pendingTodayCount: todayCount,
      pendingTodayUsd: pendingComplete ? todayUsd : null,
      complete: { tvl: tvlComplete, pending: pendingComplete },
    }
  }

  async vaults(chainId: number): Promise<{ vaults: MonitoringVaultEntry[] }> {
    const registry = this.deps.loadRegistry()
    const entries = await this.deps.market.market(chainId)
    const byProduct = new Map(entries.map((entry) => [entry.productId, entry]))
    const pending = (await this.deps.arco.pendingRedemptions(chainId)) as RedemptionRow[]

    const vaults = await Promise.all(
      registry.products.map(async (product): Promise<MonitoringVaultEntry> => {
        const entry = byProduct.get(product.productId)
        const supply =
          this.deps.readShareSupply && product.productToken.proxy
            ? await this.deps.readShareSupply(product.productToken.proxy)
            : null
        const supplyHuman = supply ? Number(supply.supply) / 10 ** supply.decimals : null
        const totalSupplyHuman = supplyHuman != null && Number.isFinite(supplyHuman) ? supplyHuman : null

        const productPending = pending.filter((row) => row.productId === product.productId)
        let pendingUsd: number | null = 0
        for (const row of productPending) {
          const value = this.pendingValueUsd(row, product, entry)
          if (value == null) {
            pendingUsd = null
            break
          }
          pendingUsd += value
        }

        const events = await this.flowEvents(chainId, product)
        const { netDeposit } = this.flowSeries(events, this.paymentDecimals(product))
        const apyTrend = await this.apyTrend(chainId, product.productId)
        const depositors = await this.depositors(chainId, product)

        return {
          productId: product.productId,
          symbol: product.symbol,
          paymentAssetSymbol: product.paymentAssetSymbol,
          navBase: entry?.navBase ?? null,
          navUsd: entry?.navUsd ?? null,
          apy: entry?.apy ?? null,
          totalSupplyHuman,
          tvlUsd: totalSupplyHuman != null && entry?.navUsd != null ? totalSupplyHuman * entry.navUsd : null,
          depositorCount: depositors ? depositors.length : null,
          pendingCount: productPending.length,
          pendingUsd,
          trends: {
            netDeposit: netDeposit.slice(-SPARKLINE_POINTS).map((point) => point.value),
            apy: apyTrend.slice(-SPARKLINE_POINTS).map((point) => point.value),
          },
        }
      }),
    )

    return { vaults }
  }

  async detail(chainId: number, productId: string): Promise<MonitoringDetail> {
    const registry = this.deps.loadRegistry()
    const product = registry.products.find((candidate) => candidate.productId === productId)
    if (!product) throw new Error(`Unknown productId ${productId}`)

    const entries = await this.deps.market.market(chainId)
    const entry = entries.find((candidate) => candidate.productId === productId)
    const history = await this.deps.market.history(chainId, productId)
    const events = await this.flowEvents(chainId, product)
    const { netDeposit, totalTokenShare } = this.flowSeries(events, this.paymentDecimals(product))

    // Outstanding pending count over time, daily-bucketed on DB index times
    // (createdAt ≈ request time only while the indexer runs live — approximate).
    const requests = (await this.deps.arco.redemptionRequestsForChain(chainId, productId)) as RedemptionRow[]
    const deltas: { t: number; delta: number }[] = []
    for (const row of requests) {
      const created = toUnixSeconds(row.createdAt)
      if (created != null) deltas.push({ t: created, delta: 1 })
      const closed = toUnixSeconds(row.settledAt) ?? toUnixSeconds(row.fulfilledAt) ?? toUnixSeconds(row.claimedAt)
      if (closed != null) deltas.push({ t: closed, delta: -1 })
    }
    deltas.sort((a, b) => a.t - b.t)
    const pendingWithdrawals: MonitoringTrendPoint[] = []
    let outstanding = 0
    for (const { t, delta } of deltas) {
      outstanding += delta
      const day = Math.floor(t / DAY_SECONDS) * DAY_SECONDS
      const last = pendingWithdrawals[pendingWithdrawals.length - 1]
      if (last && last.t === day) {
        pendingWithdrawals[pendingWithdrawals.length - 1] = { t: day, value: outstanding }
      } else {
        pendingWithdrawals.push({ t: day, value: outstanding })
      }
    }

    const depositors = (await this.depositors(chainId, product)) ?? []
    const requesters = requests
      .filter((row) => isPending(row.status))
      .map((row) => ({
        address: row.walletAddress ?? "",
        requestId: row.requestId ?? "",
        status: row.status ?? "",
        sharesInHuman: Number(row.sharesIn ?? "0") / 10 ** SHARE_FALLBACK_DECIMALS,
        valueUsd: this.pendingValueUsd(row, product, entry),
      }))

    return {
      productId,
      symbol: product.symbol,
      paymentAssetSymbol: product.paymentAssetSymbol,
      trends: {
        nav: history.points.map((point) => ({ t: point.t, value: point.navBase })),
        apy: await this.apyTrend(chainId, productId),
        netDeposit,
        totalTokenShare,
        pendingWithdrawals,
      },
      depositors,
      requesters,
    }
  }
}
