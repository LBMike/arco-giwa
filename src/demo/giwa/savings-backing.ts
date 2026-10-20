// What backs Arco Savings, shown on every Savings account (USD, ETH, XRP): the managers whose funds hold the
// reserves, the loan book and the instant-liquidity reserve. The figures are the published allocation, kept here
// (not in Vault Config) so every Savings account reads the same breakdown.

import { savingsAssetCategory } from "./savings-category"

export type AllocationSlice = Readonly<{
  id: string
  label: string
  /** Share of the backing, in percent. The slices of one breakdown add up to 100. */
  percent: number
  /** Logo URL, or null for a plain dot. */
  logo: string | null
  /** What the slice is held in, shown in a card when its tile is pointed at or focused (the Backing tiles). */
  detail?: BackingDetail | null
}>

/** One backing slice in detail: who manages it, what is held and on which chain. */
export type BackingDetail = Readonly<{
  /** Who manages it ("Asset manager"), or for the loans the protocol they are made through ("Protocol"). */
  manager: Readonly<{ role: "Asset manager" | "Protocol"; name: string; logo: string | null }>
  /** What is held: its name (the card's title; a fund as DigiFT lists it), its token's ticker and mark (the Asset row). */
  asset: Readonly<{ name: string; symbol: string | null; logo: string | null }>
  /** The chain the asset is issued on. */
  chain: Readonly<{ name: string; logo: string }>
}>

export type PoweredByMark = Readonly<{ id: string; name: string; logo: string }>

const FIDELITY_LOGO = "/logos/fidelity.png"
// The uMINT mark is the UBS keys logo (see ISSUERS in data/products.ts).
const UBS_LOGO = "/logos/umint.svg"
const FRANKLIN_TEMPLETON_LOGO = "/logos/franklin-templeton.png"

/**
 * "POWERED BY" on the Savings card: the partners' own logo files (public/logos/powered-by), marks only, in this
 * order, stacked as overlapping round badges. UBS keeps its keys mark above until its own file is added.
 */
export const SAVINGS_POWERED_BY: readonly PoweredByMark[] = [
  { id: "fidelity", name: "Fidelity", logo: "/logos/powered-by/fidelity.png" },
  { id: "franklin-templeton", name: "Franklin Templeton", logo: "/logos/powered-by/franklin.png" },
  { id: "ubs", name: "UBS", logo: UBS_LOGO },
  { id: "morpho", name: "Morpho", logo: "/logos/powered-by/morpho.png" },
]

/** The Backing breakdown. */
export const SAVINGS_BACKING: readonly AllocationSlice[] = [
  { id: "fidelity", label: "Fidelity", percent: 40, logo: FIDELITY_LOGO },
  { id: "ubs", label: "UBS", percent: 20, logo: UBS_LOGO },
  { id: "franklin-templeton", label: "Franklin Templeton", percent: 10, logo: FRANKLIN_TEMPLETON_LOGO },
  { id: "loans", label: "Crypto & RWA-backed loans", percent: 20, logo: null },
  { id: "reserve", label: "Instant liquidity reserve", percent: 10, logo: null },
]

const ETHEREUM = { name: "Ethereum", logo: "/logos/ethereum.svg" } as const

/**
 * The Backing tiles in detail. Managers carry the partners' own marks (as in "Powered by"); each fund is named as
 * DigiFT lists it, with its token's mark: RRDY for Fidelity's, uMINT (the UBS keys) for UBS's and iBENJI for Franklin
 * Templeton's, which DigiFT does not list (its fund name is Franklin Templeton's). The loans are made through Morpho.
 * Everything is issued on Ethereum.
 */
const BACKING_DETAILS: Readonly<Record<string, BackingDetail>> = {
  fidelity: {
    manager: { role: "Asset manager", name: "Fidelity", logo: "/logos/powered-by/fidelity.png" },
    asset: { name: "Reserve-Grade US Treasury Strategy Token", symbol: "RRDY", logo: "/logos/rrdy.png" },
    chain: ETHEREUM,
  },
  ubs: {
    manager: { role: "Asset manager", name: "UBS", logo: UBS_LOGO },
    asset: { name: "UBS (SG) Global Opportunities VCC - UBS Money Market (USD)", symbol: "uMINT", logo: UBS_LOGO },
    chain: ETHEREUM,
  },
  "franklin-templeton": {
    manager: { role: "Asset manager", name: "Franklin Templeton", logo: "/logos/powered-by/franklin.png" },
    asset: { name: "Franklin OnChain Institutional Liquidity Fund", symbol: "iBENJI", logo: "/logos/ibenji.svg" },
    chain: ETHEREUM,
  },
  loans: {
    manager: { role: "Protocol", name: "Morpho", logo: "/logos/powered-by/morpho.png" },
    asset: { name: "Crypto & RWA-backed loans", symbol: null, logo: null },
    chain: ETHEREUM,
  },
}

/**
 * The Backing breakdown of one Savings account, each tile with its detail. The instant liquidity reserve is held by
 * the vault itself (Arco) in the account's own coin, so that coin is its asset.
 */
export function savingsBacking(reserve: Readonly<{ symbol: string; icon: string | null }>): AllocationSlice[] {
  return SAVINGS_BACKING.map((slice) => ({
    ...slice,
    detail:
      slice.id === "reserve"
        ? {
            manager: { role: "Asset manager", name: "Arco", logo: "/logos/arco.png" },
            asset: { name: slice.label, symbol: reserve.symbol, logo: reserve.icon },
            chain: ETHEREUM,
          }
        : (BACKING_DETAILS[slice.id] ?? null),
  }))
}

const FUND_MANAGER_IDS = new Set(["fidelity", "ubs", "franklin-templeton"])

/** The token a vault's instant reserve is held in, as customers know it: tUSDC → USDC, tWETH → ETH. */
export function reserveAssetLabel(paymentAssetSymbol: string): string {
  const base = paymentAssetSymbol.replace(/^t(?=[A-Z])/, "")
  return base === "WETH" ? "ETH" : base
}

/** What the Savings card invites a deposit of: "Stablecoins" for the stablecoin account, else its coin ("ETH"). */
export function savingsDepositLabel(paymentAssetSymbol: string): string {
  const coin = reserveAssetLabel(paymentAssetSymbol)
  return savingsAssetCategory(coin) === "stablecoins" ? "Stablecoins" : coin
}

/**
 * The Exposure breakdown: the same backing grouped by asset type. The three managers' funds are U.S. Treasury and
 * money market funds; the reserve is held in the vault's payment asset.
 */
export function savingsExposure(paymentAssetSymbol: string): AllocationSlice[] {
  const percentOf = (ids: (id: string) => boolean) =>
    SAVINGS_BACKING.filter((slice) => ids(slice.id)).reduce((sum, slice) => sum + slice.percent, 0)
  return [
    { id: "treasury-mmf", label: "U.S. Treasury & money market funds", percent: percentOf((id) => FUND_MANAGER_IDS.has(id)), logo: null },
    { id: "loans", label: "Crypto & RWA-backed loans", percent: percentOf((id) => id === "loans"), logo: null },
    { id: "reserve", label: `${reserveAssetLabel(paymentAssetSymbol)} instant reserve`, percent: percentOf((id) => id === "reserve"), logo: null },
  ]
}
