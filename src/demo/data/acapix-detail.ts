// ─────────────────────────────────────────────────────────────────────────────
// aCAPIX product-detail data model + mock seed.
//
// The Products list seed (products.ts) stays the source of truth for AUM / APY /
// networks / address; this file carries ONLY the detail-page extras (price,
// about copy, performance series, portfolio breakdown, fees, contracts, docs).
//
// Numbers are RAW values; display strings are derived via the format helpers in
// lib/format.ts and products.ts (aumLabel / apyLabel / money / pct / token).
// Copy is verbatim from Figma (file ozY78i8PueSMEHABSuo4iZ, node 40:3310).
// Smart-contract + docs entries are MOCK per resolved PM decisions.
// ─────────────────────────────────────────────────────────────────────────────

import type { Network } from './products'

export type Period = '7D' | '30D' | '90D' | '1Y' | 'All'
export type PerfMetric = 'price' | 'apy'

export interface SeriesPoint {
  /** x-axis label (date) */
  t: string
  /** raw numeric value */
  value: number
}

/** A row in the Industry / Exposure breakdown table. */
export interface BreakdownRow {
  label: string
  /** raw USD value; null when unset (the card derives it from % × AUM) */
  value: number | null
  /** raw percent of NAV */
  pct: number
}

export interface ContractRow {
  label: string
  /** full (mock) address — display is truncated via shortAddr */
  address: string
  network: Network
}

export interface DocLink {
  label: string
  href: string
}

export interface ProductDetailData {
  overview: {
    /** latest unit price in USD */
    price: number
    /** today change in percent (positive = up) */
    priceChange: number
    /** integrations label (e.g. "Arco Native") */
    integrations: string
  }
  about: string[]
  performance: Record<PerfMetric, Record<Period, SeriesPoint[]>>
  portfolio: {
    updatedAt: string
    note: string
    /** raw total NAV in USD */
    total: number
    industry: BreakdownRow[]
    exposure: BreakdownRow[]
  }
  fee: {
    /** management fee percent, annual on AUM */
    management: number
    /** performance fee percent */
    performance: number
    /** verbatim Figma note under the heading */
    note: string
  }
  contracts: ContractRow[]
  docs: DocLink[]
}

// ── helpers to fabricate plausible, monotonic-ish mock series ─────────────────
const ramp = (
  labels: string[],
  start: number,
  end: number,
  jitter: number,
): SeriesPoint[] =>
  labels.map((t, i) => {
    const base = start + ((end - start) * i) / (labels.length - 1)
    // deterministic pseudo-jitter so the line wiggles but trends up
    const wiggle = Math.sin(i * 1.7) * jitter
    return { t, value: Number((base + wiggle).toFixed(4)) }
  })

const D7 = ['May 26', 'May 27', 'May 28', 'May 29', 'May 30', 'May 31', 'Jun 1']
const D30 = ['Apr 30', 'May 7', 'May 15', 'May 22', 'May 27', 'Jun 1']
const D90 = ['Mar 4', 'Mar 25', 'Apr 15', 'May 6', 'May 20', 'Jun 1']
const D1Y = ['Jun', 'Aug', 'Oct', 'Dec', 'Feb', 'Apr', 'Jun']
const DALL = ['2024', 'Q3 24', 'Q4 24', 'Q1 25', 'Q2 25', '2026']

export const ACAPIX_DETAIL: ProductDetailData = {
  overview: {
    price: 11.03,
    priceChange: 0.01,
    integrations: 'Arco Native',
  },
  about: [
    'aCAPIX is Arco’s tokenized feeder access layer for CAPIX, an income-focused private credit interval fund managed by Calamos and Aksia. CAPIX provides diversified exposure to the full spectrum of private credit in a single portfolio.',
    'Calamos brings a $50B+ investment management platform, while Aksia brings $370B+ in alternatives assets under supervision. Through Arco, eligible onchain investors can access CAPIX with ownership records and redemption workflows managed according to the underlying fund terms.',
  ],
  performance: {
    price: {
      '7D': ramp(D7, 1.0612, 1.062, 0.0004),
      '30D': ramp(D30, 1.059, 1.062, 0.0006),
      '90D': ramp(D90, 1.0548, 1.062, 0.0009),
      '1Y': ramp(D1Y, 1.041, 1.062, 0.002),
      All: ramp(DALL, 1.0, 1.062, 0.004),
    },
    apy: {
      '7D': ramp(D7, 10.41, 10.53, 0.05),
      '30D': ramp(D30, 10.2, 10.53, 0.08),
      '90D': ramp(D90, 9.85, 10.53, 0.12),
      '1Y': ramp(D1Y, 9.1, 10.53, 0.25),
      All: ramp(DALL, 8.4, 10.53, 0.4),
    },
  },
  portfolio: {
    updatedAt: 'Jun 3, 2026 · 09:06 UTC',
    note: 'Values shown are based on onchain estimates and may differ from the verified NAV reported in the Midas Attestation Engine.',
    total: 29_620_000,
    industry: [
      { label: 'Financial Services', value: 13_550_000, pct: 45.8 },
      { label: 'Software', value: 3_830_000, pct: 12.9 },
      { label: 'Professional Services', value: 3_280_000, pct: 11.1 },
      { label: 'Real Estate', value: 2_690_000, pct: 9.1 },
      { label: 'Commercial Services', value: 2_020_000, pct: 6.8 },
    ],
    // Exposure-by-protocol breakdown (Figma node 7:229). value is raw USD →
    // displayed in millions ("13.55"); pct is verbatim 2-decimal % of NAV.
    exposure: [
      { label: 'Direct Lending – Lower/Core', value: 13_550_000, pct: 45.76 },
      { label: 'Direct Lending – Mega/Upper', value: 6_620_000, pct: 22.36 },
      { label: 'Direct Lending – Opportunistic', value: 3_280_000, pct: 11.08 },
      { label: 'Specialty Finance', value: 2_690_000, pct: 9.08 },
      { label: 'Real Asset Credit', value: 2_020_000, pct: 6.81 },
      { label: 'Real Estate Credit', value: 790_000, pct: 2.65 },
      { label: 'Distressed / Special Sits', value: 640_000, pct: 2.17 },
      { label: 'Junior Capital', value: 20_000, pct: 0.07 },
      { label: 'Cash Enhancement', value: 10_000, pct: 0.02 },
      { label: 'Gt Exch', value: 0, pct: 0 },
    ],
  },
  fee: {
    management: 1.25,
    performance: 0,
    note: 'Full breakdown of fee structure for mTBILL',
  },
  contracts: [
    {
      label: 'aCAPIX',
      address: '0xDD62a1B2C5A9F1E8D3C7A6B0F9E2D1C8A7B6e438',
      network: 'Ethereum',
    },
    {
      label: 'aCAPIX/USD Oracle',
      address: '0x05634C3B2A1B2C5A9F1E8D3C7A6B0F9E2D1c2E5b',
      network: 'Ethereum',
    },
    {
      label: 'Issuance vault',
      address: '0x99368D3C7A6B0F9E2D1C8A7B6E5D4C3B2A1b6683',
      network: 'Ethereum',
    },
    {
      label: 'Redemption vault',
      address: '0x569D7A6B0F9E2D1C8A7B6E5D4C3B2A1B2C5Af0Ec',
      network: 'Ethereum',
    },
  ],
  docs: [
    { label: 'Documentation', href: '#' },
    { label: 'Legal Terms', href: '#' },
    { label: 'Risks', href: '#' },
  ],
}

// ── pending-redemption mock rows for the Invest panel "Pending" tab ──────────
export interface PendingRedemption {
  requestId: string
  /** raw aCAPIX amount */
  amount: number
  /** raw expected USDC */
  expectedUsdc: number
  status: 'Pending' | 'Settling' | 'Ready'
  requestedAt: string
  estSettlement: string
}

export const ACAPIX_PENDING: PendingRedemption[] = [
  {
    requestId: 'RDM-10428',
    amount: 12.5,
    expectedUsdc: 137.84,
    status: 'Pending',
    requestedAt: 'Jun 2, 2026',
    estSettlement: 'Jun 9, 2026',
  },
  {
    requestId: 'RDM-10391',
    amount: 48.2,
    expectedUsdc: 531.46,
    status: 'Settling',
    requestedAt: 'May 30, 2026',
    estSettlement: 'Jun 6, 2026',
  },
  {
    requestId: 'RDM-10355',
    amount: 5,
    expectedUsdc: 55.15,
    status: 'Ready',
    requestedAt: 'May 27, 2026',
    estSettlement: 'Jun 3, 2026',
  },
]

// ── instant-fee breakdown for the Invest/Redeem "Fee Structure" dropdown ─────
export interface FeeLineItem {
  label: string
  /** raw percent (0 → "0%", 0.5 → "0.5%" via apyLabel) */
  pct: number
}

export const ACAPIX_INSTANT_FEES: FeeLineItem[] = [
  { label: 'Instant Minting', pct: 0 },
  { label: 'Instant Redemption', pct: 0.5 },
]
