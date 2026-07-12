import { apyForProduct } from "../registry/apy.js"
import type { GiwaDeploymentRegistry } from "../registry/types.js"
import { DAY_SECONDS, impliedApyPercent } from "./apy-math.js"
import type { PrismaArcoService } from "./prisma-arco-service.js"
import { baseUsd, fetchUsdRates, type UsdRates } from "./usd-rates.js"

const FEED_SCALE = 100_000_000 // 1e8 (ProductPriceFeed feedDecimals = 8)

export type MarketEntry = {
  readonly productId: string
  readonly navBase: number | null
  readonly baseUsd: number | null
  readonly navUsd: number | null
  // Published rate (apyForProduct static map) — null for products without one.
  readonly apy: number | null
  // Implied APY from the most recent NAV change between two indexed PriceUpdated
  // posts (matches Monitoring's last sparkline point / AdminPrices' newest row).
  // null with <2 posts. Gap-filler for vaults lacking a published/legacy rate.
  readonly impliedApy: number | null
}

export type PriceHistoryPoint = { readonly t: number; readonly navBase: number; readonly navUsd: number | null }
export type PriceHistory = { readonly productId: string; readonly apy: number | null; readonly points: PriceHistoryPoint[] }

type IndexedEventRow = { args?: Record<string, unknown> | null }

// Live market reads each request, so a fresh operator price update (a new indexed
// PriceUpdated event) is reflected immediately. Falls back to an on-chain
// latestRoundData read when no event has been indexed yet.
export class EvmMarketService {
  constructor(
    private readonly deps: {
      arco: Pick<PrismaArcoService, "priceUpdatesForFeed">
      loadRegistry: () => GiwaDeploymentRegistry
      fetchRates?: () => Promise<UsdRates | null>
      readNavOnChain?: (feedAddress: string) => Promise<number | null>
    },
  ) {}

  private rates() {
    return (this.deps.fetchRates ?? fetchUsdRates)()
  }

  // navBase (latest indexed answer, else on-chain fallback) and impliedApy (most
  // recent NAV change between two posts) from a single feed read.
  private async feedSnapshot(
    chainId: number,
    feedAddress: string | null,
  ): Promise<{ navBase: number | null; impliedApy: number | null }> {
    if (!feedAddress) return { navBase: null, impliedApy: null }
    const events = (await this.deps.arco.priceUpdatesForFeed(chainId, feedAddress)) as IndexedEventRow[]

    let navBase: number | null = null
    const latest = events[events.length - 1]
    const answer = latest?.args?.answer
    if (answer != null) {
      const scaled = Number(answer)
      if (Number.isFinite(scaled) && scaled > 0) navBase = scaled / FEED_SCALE
    }
    if (navBase == null && this.deps.readNavOnChain) navBase = await this.deps.readNavOnChain(feedAddress)

    // Implied APY needs two valid (answer, updatedAt) posts; annualize the newest change.
    const points: { t: number; navBase: number }[] = []
    for (const event of events) {
      const scaled = Number(event.args?.answer)
      const t = Number(event.args?.updatedAt)
      if (!Number.isFinite(scaled) || scaled <= 0 || !Number.isFinite(t)) continue
      points.push({ t, navBase: scaled / FEED_SCALE })
    }
    let impliedApy: number | null = null
    if (points.length >= 2) {
      const prev = points[points.length - 2]
      const last = points[points.length - 1]
      impliedApy = impliedApyPercent(prev.navBase, last.navBase, (last.t - prev.t) / DAY_SECONDS)
    }
    return { navBase, impliedApy }
  }

  async market(chainId: number): Promise<MarketEntry[]> {
    const registry = this.deps.loadRegistry()
    const rates = await this.rates()
    return Promise.all(
      registry.products.map(async (product) => {
        const { navBase, impliedApy } = await this.feedSnapshot(chainId, product.priceFeed.proxy)
        const bu = baseUsd(product.paymentAssetSymbol, rates)
        const navUsd = navBase != null && bu != null ? navBase * bu : null
        return {
          productId: product.productId,
          navBase,
          baseUsd: bu,
          navUsd,
          apy: apyForProduct(product.productId),
          impliedApy,
        }
      }),
    )
  }

  async history(chainId: number, productId: string): Promise<PriceHistory> {
    const registry = this.deps.loadRegistry()
    const product = registry.products.find((candidate) => candidate.productId === productId)
    if (!product) throw new Error(`Unknown productId ${productId}`)
    const rates = await this.rates()
    const bu = baseUsd(product.paymentAssetSymbol, rates)
    const feed = product.priceFeed.proxy
    const events = feed ? ((await this.deps.arco.priceUpdatesForFeed(chainId, feed)) as IndexedEventRow[]) : []
    const points: PriceHistoryPoint[] = []
    for (const event of events) {
      const scaled = Number(event.args?.answer)
      const t = Number(event.args?.updatedAt)
      if (!Number.isFinite(scaled) || scaled <= 0 || !Number.isFinite(t)) continue
      const navBase = scaled / FEED_SCALE
      points.push({ t, navBase, navUsd: bu != null ? navBase * bu : null })
    }
    return { productId, apy: apyForProduct(productId), points }
  }
}
