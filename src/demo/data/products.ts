// ─────────────────────────────────────────────────────────────────────────────
// Products page data model + dummy seed.
//
// Source of truth for the new "All products" catalogue page (replaces the split
// Saving-cards / RWA-table Explorer). See Arco_Products_페이지_PRD_v0.1.md.
//
// Numbers are RAW values; display strings (`$28.53M`, `6.28%`) are derived via
// the format helpers below — never stored. Decimal rule: meaningful value, up to
// 2 places, no forced trailing zeros (5.6% stays "5.6%", not "5.60%").
// ─────────────────────────────────────────────────────────────────────────────

export type Category = 'U.S Treasuries' | 'Prime Credit' | 'Arco Saving'

export type ProductType =
  | 'Money Market Fund'
  | 'U.S Treasuries'
  | 'Private Credit'
  | 'Hedge Fund'
  | 'Arco Saving'

export type Network = 'Ethereum' | 'XRPL'
export type Denomination = 'USD' | 'BTC' | 'ETH'

export interface Product {
  /** Routing key, e.g. 'acapix' → /app/product/acapix */
  id: string
  /** Display ticker, e.g. 'aCAPIX' */
  token: string
  /** Full name (search target) */
  name: string
  /** Strategies-filter bucket (top-level asset class) */
  category: Category
  /** Row badge label (detailed type) */
  type: ProductType
  /** Asset manager (logo key) */
  assetManager: string
  /** Issuer (logo key) */
  issuer: string
  /** Display / settlement denomination */
  denomination: Denomination
  /** AUM raw value in USD (sort key) */
  aum: number
  /** APY raw percentage */
  apy: number
  /** Supported networks */
  networks: Network[]
  /** Contract address (search target, optional) */
  address?: string
  /** Carousel feature flag */
  featured?: boolean
  /** Cream row-highlight flag (Arco Saving rows in the design) */
  highlightRow?: boolean
  /** Carousel / detail blurb */
  description: string
}

// ── Brand / logo registry ────────────────────────────────────────────────────
// Logo files live in public/logos/. Until the real Figma exports are dropped in,
// these point at the expected paths; <BrandMark> falls back to an initial mark
// when the file is missing, so the table renders cleanly either way.
export const ASSET_MANAGERS: Record<string, { label: string; logo: string }> = {
  arco: { label: 'Arco', logo: '/logos/arco.png' },
  aksia: { label: 'Aksia', logo: '/logos/aksia.svg' },
  // No standalone UBS file — the uMINT token mark is the UBS snowflake.
  ubs: { label: 'UBS', logo: '/logos/umint.svg' },
  franklin: { label: 'Franklin Templeton', logo: '/logos/franklin.png' },
}

export const ISSUERS: Record<string, { label: string; logo: string }> = {
  arco: { label: 'Arco', logo: '/logos/arco.png' },
  digift: { label: 'DigiFT', logo: '/logos/DigFT.png' },
  ubs: { label: 'UBS', logo: '/logos/umint.svg' },
}

// Per-product token icon. Files that exist map here; the rest fall back to a
// coloured initial badge via <BrandMark>.
const TOKEN_ICONS: Record<string, string> = {
  abtc: '/logos/abtc.png',
  aeth: '/logos/aeth.png',
  // aCAPIX & aHedge reuse the Aksia mark as their token icon.
  acapix: '/logos/aksia.svg',
  ahedge: '/logos/aksia.svg',
  umint: '/logos/umint.svg',
  ibenji: '/logos/ibenji.svg',
}
export const tokenIcon = (id: string): string | undefined => TOKEN_ICONS[id]

// ── Seed (dummy, realistic) ──────────────────────────────────────────────────
export const PRODUCTS: Product[] = [
  {
    id: 'ibenji',
    token: 'iBENJI',
    name: 'Franklin OnChain US Gov Money Fund',
    category: 'U.S Treasuries',
    type: 'U.S Treasuries',
    assetManager: 'franklin',
    issuer: 'digift',
    denomination: 'USD',
    aum: 1_420_000_000,
    apy: 3.17,
    networks: ['Ethereum', 'XRPL'],
    address: '0x4b2c5a9f1e8d3c7a6b0f9e2d1c8a7b6e5d4c3b2a',
    description:
      'Tokenized exposure to Franklin Templeton’s onchain U.S. government money market fund — short-dated Treasuries with daily NAV.',
  },
  {
    id: 'acapix',
    token: 'aCAPIX',
    name: 'Arco CAPIX Alternative Credit',
    category: 'Prime Credit',
    type: 'Private Credit',
    assetManager: 'aksia',
    issuer: 'arco',
    denomination: 'USD',
    aum: 1_150_000_000,
    apy: 10.53,
    networks: ['Ethereum', 'XRPL'],
    address: '0x9f1e8d3c7a6b0f9e2d1c8a7b6e5d4c3b2a1b2c5a',
    featured: true,
    description:
      "Allocates to Aksia's Global Diversified Alternative Debt Fund strategy while providing onchain liquidity.",
  },
  {
    id: 'umint',
    token: 'uMINT',
    name: 'UBS USD Money Market Investment',
    category: 'U.S Treasuries',
    type: 'Money Market Fund',
    assetManager: 'ubs',
    issuer: 'digift',
    denomination: 'USD',
    aum: 385_600_000,
    apy: 4.21,
    networks: ['Ethereum'],
    address: '0x7a6b0f9e2d1c8a7b6e5d4c3b2a1b2c5a9f1e8d3c',
    description:
      'UBS-managed tokenized USD money market fund — institutional-grade short-term liquidity with onchain settlement.',
  },
  {
    id: 'aeth',
    token: 'aETH',
    name: 'Arco Saving ETH',
    category: 'Arco Saving',
    type: 'Arco Saving',
    assetManager: 'arco',
    issuer: 'arco',
    denomination: 'ETH',
    aum: 88_400_000,
    apy: 5.64,
    networks: ['Ethereum'],
    address: '0x2d1c8a7b6e5d4c3b2a1b2c5a9f1e8d3c7a6b0f9e',
    highlightRow: true,
    description:
      'RWA-linked yield for ETH holders — credit-strategy backed saving with instant onchain liquidity.',
  },
  {
    id: 'ahedge',
    token: 'aHedge',
    name: 'Arco Hedge',
    category: 'Prime Credit',
    type: 'Hedge Fund',
    assetManager: 'aksia',
    issuer: 'arco',
    denomination: 'USD',
    aum: 59_100_000,
    apy: 9.87,
    networks: ['Ethereum', 'XRPL'],
    address: '0x8a7b6e5d4c3b2a1b2c5a9f1e8d3c7a6b0f9e2d1c',
    description:
      'Tokenized exposure to a market-neutral hedge fund strategy managed by Aksia.',
  },
  {
    id: 'abtc',
    token: 'aBTC',
    name: 'Arco Saving BTC',
    category: 'Arco Saving',
    type: 'Arco Saving',
    assetManager: 'arco',
    issuer: 'arco',
    denomination: 'BTC',
    aum: 42_180_000,
    apy: 5.12,
    networks: ['Ethereum'],
    address: '0x6e5d4c3b2a1b2c5a9f1e8d3c7a6b0f9e2d1c8a7b',
    highlightRow: true,
    description:
      'RWA-linked yield for BTC holders — credit-strategy backed saving with instant onchain liquidity.',
  },
]

// ── Format helpers (decimal rule: up to 2 places, no forced trailing zeros) ──
const trim = (n: number, max = 2) =>
  Number(n.toFixed(max)).toLocaleString('en-US', { maximumFractionDigits: max })

/** Compact USD with K/M/B suffix, up to 2 decimals. e.g. 28_530_000 → "$28.53M" */
export function aumLabel(n: number): string {
  if (n >= 1_000_000_000) return `$${trim(n / 1_000_000_000)}B`
  if (n >= 1_000_000) return `$${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `$${trim(n / 1_000)}K`
  return `$${trim(n)}`
}

/** Percent, up to 2 decimals, no forced trailing zeros. e.g. 6.28 → "6.28%", 5.6 → "5.6%" */
export function apyLabel(n: number): string {
  return `${trim(n)}%`
}

// ── Derived lookups (no hardcoded filter options) ────────────────────────────
const uniq = <T,>(xs: T[]) => Array.from(new Set(xs))

export const CATEGORIES: Category[] = uniq(PRODUCTS.map((p) => p.category))
export const DENOMINATIONS: Denomination[] = uniq(PRODUCTS.map((p) => p.denomination))
export const ISSUER_KEYS: string[] = uniq(PRODUCTS.map((p) => p.issuer))
export const NETWORKS: Network[] = uniq(PRODUCTS.flatMap((p) => p.networks))

/** Issuer dropdown options as {key,label} (label resolved via ISSUERS registry). */
export const ISSUER_OPTIONS = ISSUER_KEYS.map((key) => ({
  key,
  label: ISSUERS[key]?.label ?? key,
}))

export const productById = (id: string) => PRODUCTS.find((p) => p.id === id)
export const featuredProducts = () => PRODUCTS.filter((p) => p.featured)

/** Factsheet rows ([label, value]) for the product detail page. */
export function factsheet(p: Product): [string, string][] {
  const am = ASSET_MANAGERS[p.assetManager]?.label ?? p.assetManager
  const iss = ISSUERS[p.issuer]?.label ?? p.issuer
  return [
    ['Strategy', p.category],
    ['Product type', p.type],
    ['Asset manager', am],
    ['Issuer', iss],
    ['Denomination', p.denomination],
    ['Networks', p.networks.join(' · ')],
    ['AUM', aumLabel(p.aum)],
    ['APY', apyLabel(p.apy)],
  ]
}

// ── Filter state + predicate ─────────────────────────────────────────────────
export type Filters = {
  category: Category | 'all'
  denomination: Denomination | 'all'
  issuer: string | 'all'
  network: Network | 'all'
  search: string
}

export const EMPTY_FILTERS: Filters = {
  category: 'all',
  denomination: 'all',
  issuer: 'all',
  network: 'all',
  search: '',
}

/** AND-combined filter. Search matches name + token + address (case-insensitive). */
export function applyFilters(products: Product[], f: Filters): Product[] {
  const q = f.search.trim().toLowerCase()
  return products.filter((p) => {
    if (f.category !== 'all' && p.category !== f.category) return false
    if (f.denomination !== 'all' && p.denomination !== f.denomination) return false
    if (f.issuer !== 'all' && p.issuer !== f.issuer) return false
    if (f.network !== 'all' && !p.networks.includes(f.network)) return false
    if (q) {
      const hay = `${p.name} ${p.token} ${p.address ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Strategies card → category mapping (and colours) used by the Strategies row. */
export const STRATEGIES: {
  category: Category
  title: string
  blurb: string
  tag: string
  bg: string
}[] = [
  {
    category: 'U.S Treasuries',
    title: 'U.S. Treasuries',
    blurb: 'Explore U.S. government debt including T-bills and money market funds.',
    tag: 'Low Risk Strategies',
    bg: 'var(--color-strategy-treasuries)',
  },
  {
    category: 'Prime Credit',
    title: 'Prime Credit',
    blurb: 'Wall Street-led private credit fund',
    tag: 'High Yield Strategies',
    bg: 'var(--color-strategy-credit)',
  },
  {
    category: 'Arco Saving',
    title: 'Arco Saving',
    blurb: 'Saving strategies for BTC, ETH, and XRP holders seeking RWA-linked yield access.',
    tag: 'Crypto Native Asset',
    bg: 'var(--color-strategy-saving)',
  },
]
