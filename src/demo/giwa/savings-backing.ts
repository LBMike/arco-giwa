// What backs Arco Savings, shown on every Savings account (USD, ETH, XRP): the managers whose funds hold the
// reserves, the loan book and the instant-liquidity reserve. The figures are the published allocation, kept here
// (not in Vault Config) so every Savings account reads the same breakdown.

export type AllocationSlice = Readonly<{
  id: string
  label: string
  /** Share of the backing, in percent. The slices of one breakdown add up to 100. */
  percent: number
  /** Logo URL, or null for a plain dot. */
  logo: string | null
}>

export type PoweredByMark = Readonly<{ id: string; name: string; logo: string }>

const FIDELITY_LOGO = "/logos/fidelity.png"
// The uMINT mark is the UBS keys logo (see ISSUERS in data/products.ts).
const UBS_LOGO = "/logos/umint.svg"
const FRANKLIN_TEMPLETON_LOGO = "/logos/franklin-templeton.png"

/** "POWERED BY" on the Savings card. */
export const SAVINGS_POWERED_BY: readonly PoweredByMark[] = [
  { id: "fidelity", name: "Fidelity", logo: FIDELITY_LOGO },
  { id: "ubs", name: "UBS", logo: UBS_LOGO },
  { id: "franklin-templeton", name: "Franklin Templeton", logo: FRANKLIN_TEMPLETON_LOGO },
]

/** The Backing breakdown. */
export const SAVINGS_BACKING: readonly AllocationSlice[] = [
  { id: "fidelity", label: "Fidelity", percent: 40, logo: FIDELITY_LOGO },
  { id: "ubs", label: "UBS", percent: 20, logo: UBS_LOGO },
  { id: "franklin-templeton", label: "Franklin Templeton", percent: 10, logo: FRANKLIN_TEMPLETON_LOGO },
  { id: "loans", label: "Crypto & RWA-backed loans", percent: 20, logo: null },
  { id: "reserve", label: "Instant liquidity reserve", percent: 10, logo: null },
]

const FUND_MANAGER_IDS = new Set(["fidelity", "ubs", "franklin-templeton"])

/** The token a vault's instant reserve is held in, as customers know it: tUSDC → USDC, tWETH → ETH. */
export function reserveAssetLabel(paymentAssetSymbol: string): string {
  const base = paymentAssetSymbol.replace(/^t(?=[A-Z])/, "")
  return base === "WETH" ? "ETH" : base
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
