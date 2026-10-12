/**
 * DigiFT product reference data for catalogue previews only.
 *
 * These entries are not deployed Arco products. They have no contract, balance,
 * price feed, subscription, or redemption route. DigiFT figures are source snapshots;
 * separately sourced AUM approximations and the illustrative peer proxy are marked
 * as such. None are live quotes or promises of future return. Keep money and return
 * values as display strings so they are never mistaken for ledger quantities.
 *
 * Source: DigiFT product overview, dated 1 September 2026.
 * https://digift.docsend.com/view/7trp6frneivpjg4c
 */

export interface DigiFTAumEstimate {
  /** Rounded USD display value for the preview; never a token or Arco balance. */
  readonly value: string
  /** Date of the underlying observation; null for a purely illustrative peer proxy. */
  readonly asOf: string | null
  readonly basis: string
  readonly sourceLabel: string
  readonly sourceUrl: string
  readonly secondarySourceLabel?: string
  readonly secondarySourceUrl?: string
  readonly illustrative: boolean
}

export interface DigiFTReferenceAsset {
  readonly id: string
  readonly symbol: string
  readonly name: string
  readonly category: 'Cash Management' | 'Income Strategies' | 'Equity Exposure' | 'Alternative Assets'
  /** Displayed managing firm; some products name an investment sub-manager. */
  readonly manager: string
  /** Official logo of the displayed managing firm. */
  readonly managerLogoPath: string
  readonly underlying: string
  /** Source-backed economic exposure; not a payment token. */
  readonly baseAsset: string
  readonly description: string
  readonly liquidity: string
  readonly minInvestment: string
  readonly fee: string
  readonly settlement: string
  readonly metricLabel: string
  readonly metricValue: string
  readonly metricAsOf: string | null
  /** AUM reported in the DigiFT overview, if present. */
  readonly aum: string | null
  /** Separately sourced or explicitly illustrative amount for a missing AUM. */
  readonly aumEstimate?: DigiFTAumEstimate
  readonly sourcePage: number
  readonly sourceAsOf: '2026-09-01'
  readonly sourceUrl: string
  readonly referenceOnly: true
}

const SOURCE_URL = 'https://digift.docsend.com/view/7trp6frneivpjg4c'
const SOURCE_AS_OF = '2026-09-01' as const

export const DIGIFT_REFERENCE_ASSETS: readonly DigiFTReferenceAsset[] = [
  {
    id: 'digift-cmbmint',
    symbol: 'CMBMINT',
    name: 'CMB International USD Money Market Fund',
    category: 'Cash Management',
    manager: 'China Merchant Bank International AM',
    managerLogoPath: "/logos/digift-manager-cmbi.jpg",
    underlying: 'CMB International USD Money Market Fund',
    baseAsset: 'Money market',
    description:
      'A USD money market fund investing in short-term deposits and high-quality money market instruments issued by governments, financial institutions, and corporations.',
    liquidity: 'Daily NAV; OTC available',
    minInvestment: 'USD 1,000',
    fee: '0.6% per year; no subscription or redemption fee',
    settlement: 'T+1',
    metricLabel: '7-day yield',
    metricValue: '3.40%',
    metricAsOf: SOURCE_AS_OF,
    aum: 'USD 4.5 billion',
    sourcePage: 4,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
  {
    id: 'digift-ultra',
    symbol: 'ULTRA',
    name: 'Delta Wellington Ultra Short Treasury On-Chain Fund',
    category: 'Cash Management',
    manager: 'Wellington Management',
    managerLogoPath: "/logos/digift-manager-wellington.jpg",
    underlying: 'Delta Wellington Ultra Short Treasury On-Chain Fund',
    baseAsset: 'U.S. Treasuries',
    description:
      'Invests in U.S. government-issued securities across varying maturities, targeting an effective portfolio duration below one year.',
    liquidity: 'Daily NAV',
    minInvestment: 'USD 50,000',
    fee: '0.32% per year; no subscription or redemption fee',
    settlement: 'Subscription T+1; redemption T+5',
    metricLabel: '7-day yield',
    metricValue: '3.17%',
    metricAsOf: SOURCE_AS_OF,
    aum: 'USD 146.6 million',
    sourcePage: 5,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
  {
    id: 'digift-tkstable',
    symbol: 'TKStable',
    name: 'Taikang Capital Stable Fund',
    category: 'Cash Management',
    manager: 'Taikang AM',
    managerLogoPath: "/logos/digift-manager-taikang.png",
    underlying: 'Taikang Capital Stable Fund',
    baseAsset: 'Bank deposits',
    description:
      'Invests in fixed and savings deposits with maturities under 370 days, issued by investment-grade banks and financial institutions.',
    liquidity: 'Weekly subscriptions; monthly redemptions; weekly NAV',
    minInvestment: 'USD 50,000',
    fee: '0.6% per year; no subscription fee; USD 80 redemption fee',
    settlement: 'Subscription T+1; redemption T+3',
    metricLabel: 'Yield to maturity',
    metricValue: '3.95%',
    metricAsOf: '2026-07-28',
    aum: null,
    aumEstimate: {
      value: 'USD 150 million',
      asOf: null,
      basis: 'Illustrative cash-management peer proxy: ULTRA has USD 146.6 million of underlying fund AUM in the DigiFT overview, rounded here to USD 150 million. This is not a measured AUM for Taikang Capital Stable Fund.',
      sourceLabel: 'DigiFT overview (ULTRA peer)',
      sourceUrl: SOURCE_URL,
      illustrative: true,
    },
    sourcePage: 5,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
  {
    id: 'digift-cmbbond',
    symbol: 'CMBBOND',
    name: 'CMBI Investment Grade Bond Fund Token',
    category: 'Income Strategies',
    manager: 'China Merchant Bank International AM',
    managerLogoPath: "/logos/digift-manager-cmbi.jpg",
    underlying: 'CMBI Investment Grade Bond Fund',
    baseAsset: 'IG bonds',
    description:
      'Provides exposure to global investment-grade debt securities, including fixed- and floating-rate bonds; the strategy may allocate up to 100% of NAV to these instruments.',
    liquidity: 'Daily NAV',
    minInvestment: 'USD 1,000',
    fee: '1% per year; no subscription or redemption fee',
    settlement: 'Subscription T+3; redemption T+4',
    metricLabel: 'Yield to maturity',
    metricValue: '6.11%',
    metricAsOf: '2026-07-31',
    aum: null,
    aumEstimate: {
      value: 'USD 689 million',
      asOf: '2026-07-31',
      basis: 'Rounded from HKEX-reported USD 689.23 million AUM for the underlying CMBI Investment Grade Bond Fund.',
      sourceLabel: 'HKEX fund repository',
      sourceUrl: 'https://ifp.hkex.com.hk/fund-repository/fund/BVJ946',
      illustrative: false,
    },
    sourcePage: 6,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
  {
    id: 'digift-jx',
    symbol: 'JX',
    name: 'SBI Japan High Dividend Equity Strategy',
    category: 'Equity Exposure',
    manager: 'SBI AM',
    managerLogoPath: "/logos/digift-manager-sbi.jpg",
    underlying: 'SBI Japan High Dividend Equity Strategy',
    baseAsset: 'Japan equities',
    description:
      'A Japanese high-dividend equity strategy seeking capital growth. DigiFT states that the underlying fund and JX token do not make distributions.',
    liquidity: 'Daily NAV',
    minInvestment: 'USD 10,000',
    fee: '1.7% per year; no subscription fee; USD 80 redemption fee',
    settlement: 'T+5',
    metricLabel: '12-month return',
    metricValue: '45.62%',
    metricAsOf: '2026-05-29',
    aum: 'USD 2.05 billion',
    sourcePage: 7,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
  {
    id: 'digift-ktw50',
    symbol: 'kTW50',
    name: 'KGI Taiwan Top 50 Fund Token',
    category: 'Equity Exposure',
    manager: 'KGI AM',
    managerLogoPath: "/logos/digift-manager-kgi.svg",
    underlying: 'KGI Taiwan TOP 50 ETF (009816)',
    baseAsset: 'Taiwan equities',
    description:
      'Tracks a portfolio of Taiwan’s top 50 blue-chip companies, screened by net profit and weighted by market capitalization.',
    liquidity: 'Daily NAV',
    minInvestment: 'USD 10,000',
    fee: '0.9% per year; no subscription fee; USD 80 redemption fee',
    settlement: 'Subscription T+1; redemption T+7',
    metricLabel: '3-month return',
    metricValue: '48.99%',
    metricAsOf: '2026-06-30',
    aum: null,
    aumEstimate: {
      value: 'USD 6.3 billion',
      asOf: '2026-09-23',
      basis: 'TWSE reported TWD 199,836,704,013 AUM for underlying ETF 009816. Dividing by the same-day TAIFEX USD/TWD reference rate of 31.716 gives about USD 6.30 billion.',
      sourceLabel: 'TWSE ETF AUM',
      sourceUrl: 'https://www.twse.com.tw/zh/ETFortune/',
      secondarySourceLabel: 'TAIFEX daily FX rate',
      secondarySourceUrl: 'https://www.taifex.com.tw/cht/3/dailyFXRate',
      illustrative: false,
    },
    sourcePage: 7,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
  {
    id: 'digift-goldx',
    symbol: 'GOLDX',
    name: 'OCBC-LionGlobal Physical Gold Fund Token',
    category: 'Alternative Assets',
    manager: 'Lion Global Investors',
    managerLogoPath: "/logos/digift-manager-lionglobal.png",
    underlying: 'LionGlobal Singapore Physical Gold Fund',
    baseAsset: 'Physical gold',
    description:
      'GOLDX provides tokenized access to a Lion Global Investors fund backed by physical gold bars of at least 99.5% fineness. The underlying fund seeks to track the LBMA Gold Price AM before fees.',
    liquidity: 'Daily NAV; OTC available',
    minInvestment: 'USD 1,000',
    fee: '0.4% per year; no subscription fee; USD 80 redemption fee',
    settlement: 'T+2',
    metricLabel: 'Benchmark',
    metricValue: 'Tracks LBMA Gold Price',
    metricAsOf: null,
    aum: null,
    aumEstimate: {
      value: 'USD 526 million',
      asOf: '2026-04-16',
      basis: 'Rounded from OCBC-reported USD 525.9 million AUM for the underlying LionGlobal Singapore Physical Gold Fund.',
      sourceLabel: 'OCBC launch release',
      sourceUrl: 'https://www.ocbc.com/group/media/release/2026/ocbc-lion-global-investors-and-digifit-launches-southeast-asia-first-onchain-tokenised-gold-fund.page',
      illustrative: false,
    },
    sourcePage: 9,
    sourceAsOf: SOURCE_AS_OF,
    sourceUrl: SOURCE_URL,
    referenceOnly: true,
  },
]

/** The category Arco shows for a reference product: DigiFT's own, unless Arco relabels it. */
export type DigiFTDisplayCategory = DigiFTReferenceAsset['category'] | 'Commodity'

// Arco display labels, not DigiFT source data. DigiFT files GOLDX, a physical gold fund, under
// Alternative Assets; Arco shows it as a Commodity. The `category` field above stays as sourced.
const DISPLAY_CATEGORY: Readonly<Partial<Record<string, DigiFTDisplayCategory>>> = {
  'digift-goldx': 'Commodity',
}

export function digiftDisplayCategory(asset: Pick<DigiFTReferenceAsset, 'id' | 'category'>): DigiFTDisplayCategory {
  return DISPLAY_CATEGORY[asset.id] ?? asset.category
}

export function digiftReferenceAssetById(id: string): DigiFTReferenceAsset | undefined {
  return DIGIFT_REFERENCE_ASSETS.find((asset) => asset.id === id)
}

export function referenceAssetsForList(deployedSymbols: readonly string[], search = ''): DigiFTReferenceAsset[] {
  const deployed = new Set(deployedSymbols.map((symbol) => symbol.toLowerCase()))
  const query = search.trim().toLowerCase()

  return DIGIFT_REFERENCE_ASSETS.filter((asset) => {
    if (deployed.has(asset.symbol.toLowerCase())) return false
    if (!query) return true
    return [asset.symbol, asset.name, asset.category, digiftDisplayCategory(asset), asset.manager, asset.underlying, asset.description]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
}
