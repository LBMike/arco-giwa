// The Funds page lineup: the funds Arco lists on GIWA, in the order the Featured Funds card shows them. Cash
// management funds are not listed here (their pages and search entries stay). Each entry adds what the page needs
// beyond the fund's own record: its tab, the type under its name, its Risk profile, and the sentence and glass-orb mark on
// its Featured card.

import type { FundOrbMark } from "./FundOrb"
import type { RiskLevel } from "./RiskTag"
import { listedFundById, type ListedFund } from "./listed-funds"
import { compareNullLast, type SortDir } from "./sort"

export type FundsTab = "all" | "credit" | "equity"

export const FUNDS_TABS: readonly Readonly<{ id: FundsTab; label: string }>[] = [
  { id: "all", label: "All Funds" },
  { id: "credit", label: "Credit" },
  { id: "equity", label: "Equity" },
]

/** Where every Risk profile's "Learn more about risk" leads: Arco's page on the risks users take. */
export const FUNDS_RISK_DOC = "https://docs.arco.financial/security/user-risks"

/** What the Risk profile shows when it opens (after app.sky.money/earn): the tier, a short account of the risk and three
 * facts. */
export type FundRiskProfile = Readonly<{
  level: RiskLevel
  summary: string
  /** What the fund is exposed to. */
  exposure: string
  liquidation: string
  withdrawals: string
}>

export type LineupFund = Readonly<{
  fund: ListedFund
  tab: Exclude<FundsTab, "all">
  /** The kind of fund, under its name. */
  type: string
  risk: FundRiskProfile
  /** One sentence on the Featured Funds card. */
  blurb: string
  /** The fund's mark in the Featured card's glass orb: a white, single-colour file and its width in the orb. */
  orb: FundOrbMark
}>

type LineupEntry = Omit<LineupFund, "fund"> & { id: string }

// Credit funds are Medium; equity funds are High.
const LINEUP: readonly LineupEntry[] = [
  {
    id: "nuva-home",
    tab: "credit",
    type: "HELOC Private Credit",
    risk: {
      level: "medium",
      summary:
        "Private credit backed by U.S. home equity lines of credit. Borrowers can fall behind or default and falling home prices weaken the collateral; a first-loss tranche takes losses before HOME holders.",
      exposure: "U.S. HELOCs",
      liquidation: "None",
      withdrawals: "Up to 3 business days",
    },
    blurb: "Private credit backed by U.S. home equity lines of credit that Figure originates and services, with a first-loss tranche ahead of holders.",
    orb: { src: "/logos/orb/nuva-home.svg", width: "46%" },
  },
  {
    id: "digift-jx",
    tab: "equity",
    type: "Japan Equity",
    risk: {
      level: "high",
      summary:
        "Japanese listed equities chosen for high dividends and value. Share prices can fall sharply, and returns in dollars move with the yen.",
      exposure: "Japanese equities",
      liquidation: "None",
      withdrawals: "T+4",
    },
    blurb: "SBI Asset Management's high-conviction portfolio of Japanese listed equities, chosen for high dividends and value.",
    orb: { src: "/logos/orb/sbi-jx.png", width: "62%" },
  },
  {
    id: "bitwise-pplus",
    tab: "credit",
    type: "Levered Credit",
    risk: {
      level: "medium",
      summary:
        "Tokenized private credit, borrowed against at up to 5x on DeFi lending markets. Leverage magnifies losses and positions can be liquidated; the vault relies on third-party protocols and price oracles.",
      exposure: "Tokenized private credit",
      liquidation: "Yes, up to 5x leverage",
      withdrawals: "T+4 to T+7",
    },
    blurb: "A leveraged credit strategy across tokenized real-world assets, curated by Bitwise and operated by Ember Protocol.",
    orb: { src: "/logos/orb/bitwise-b.png", width: "34%" },
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
