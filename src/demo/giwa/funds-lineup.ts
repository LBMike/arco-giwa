// The Funds page lineup: the funds Arco lists on GIWA, in the order the Featured Funds card shows them. Cash
// management funds are not listed here (their pages and search entries stay). Each entry adds what the page needs
// beyond the fund's own record: its tab, the type under its name, its risk tier and the risks named on hover, and the
// sentence on its Featured card.

import type { RiskLevel } from "./RiskTag"
import { listedFundById, type ListedFund } from "./listed-funds"
import { compareNullLast, type SortDir } from "./sort"

export type FundsTab = "all" | "credit" | "equity"

export const FUNDS_TABS: readonly Readonly<{ id: FundsTab; label: string }>[] = [
  { id: "all", label: "All Funds" },
  { id: "credit", label: "Credit" },
  { id: "equity", label: "Equity" },
]

export type LineupFund = Readonly<{
  fund: ListedFund
  tab: Exclude<FundsTab, "all">
  /** The kind of fund, under its name. */
  type: string
  risk: RiskLevel
  /** The main risks, shown when pointing at the Risk profile. */
  risks: readonly string[]
  /** One sentence on the Featured Funds card. */
  blurb: string
}>

type LineupEntry = Omit<LineupFund, "fund"> & { id: string }

const LINEUP: readonly LineupEntry[] = [
  {
    id: "nuva-home",
    tab: "credit",
    type: "HELOC Private Credit",
    risk: "medium",
    risks: [
      "Borrowers can fall behind or default; a first-loss tranche takes losses before HOME holders.",
      "Falling U.S. home prices weaken the collateral, and most loans are second-lien.",
      "Withdrawals take up to 3 U.S. business days.",
    ],
    blurb: "Private credit backed by U.S. home equity lines of credit that Figure originates and services, with a first-loss tranche ahead of holders.",
  },
  {
    id: "digift-jx",
    tab: "equity",
    type: "Japan Equity",
    risk: "high",
    risks: [
      "Japanese share prices can fall sharply.",
      "Returns in dollars move with the yen.",
      "Concentrated in high-dividend, value-tilted stocks.",
    ],
    blurb: "SBI Asset Management's high-conviction portfolio of Japanese listed equities, chosen for high dividends and value.",
  },
  {
    id: "bitwise-pplus",
    tab: "credit",
    type: "Levered Credit",
    risk: "high",
    risks: [
      "Up to 5x leverage: losses are magnified and lending markets can liquidate positions.",
      "Relies on third-party protocols, RWA issuers and their price oracles.",
      "Withdrawals settle in T+4 to T+7.",
    ],
    blurb: "A leveraged credit strategy across tokenized real-world assets, curated by Bitwise and operated by Ember Protocol.",
  },
]

export const FUNDS_LINEUP: readonly LineupFund[] = LINEUP.map(({ id, ...entry }) => {
  const fund = listedFundById(id)
  if (!fund) throw new Error(`Funds lineup: no listed fund "${id}"`)
  return { fund, ...entry }
})

export function lineupForTab(tab: FundsTab, funds: readonly LineupFund[] = FUNDS_LINEUP): readonly LineupFund[] {
  return tab === "all" ? funds : funds.filter((entry) => entry.tab === tab)
}

export type LineupSort = Readonly<{ key: "aum" | "apy"; dir: SortDir }>

/** The list's order: the lineup's own until a column is sorted; AUM by its USD value, APY by the headline rate. */
export function sortLineup(funds: readonly LineupFund[], sort: LineupSort | null): readonly LineupFund[] {
  if (!sort) return funds
  const value = (entry: LineupFund) => (sort.key === "aum" ? entry.fund.aum.usd : entry.fund.rate)
  return [...funds].sort((a, b) => compareNullLast(value(a), value(b), sort.dir))
}

/** The tab an arrow key moves to from tab `at` (wrapping), or null for any other key. */
export function nextTabIndex(at: number, key: string): number | null {
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0
  if (key === "Home") return 0
  if (key === "End") return FUNDS_TABS.length - 1
  return step ? (at + step + FUNDS_TABS.length) % FUNDS_TABS.length : null
}
