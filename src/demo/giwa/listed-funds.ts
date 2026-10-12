/**
 * Funds Arco distributes that are not deployed on GIWA Sepolia. The catalog shows them the same way
 * as the deployed vaults: risk tag, category, AUM, headline rate, portfolio, fees, terms and docs.
 * They have no GIWA contract, balance or price feed, so their invest panel reads "Coming soon".
 *
 * Figures come from DigiFT's product pages and its product deck dated 30 Sep 2026, whichever is newer
 * (every metric carries its own date), the NUVA app and docs for HOME, and each manager's monthly
 * report for the portfolio breakdowns. Money and rates stay display strings so they are never
 * mistaken for ledger values.
 */

import type { VaultCategory } from "../../../shared/vault-taxonomy"
import { categoryTitle } from "./fund-categories"

export type FundMetric = {
  /** What the rate is, e.g. "7-day yield" or "12-month return". */
  readonly label: string
  readonly value: string
  /** ISO date the metric refers to. */
  readonly asOf: string
}

export type FundFact = {
  readonly label: string
  readonly value: string
  readonly asOf?: string
  readonly sourceLabel: string
  readonly sourceUrl: string
}

export type FundBreakdown = {
  readonly title: string
  readonly scope: string
  readonly asOf: string
  readonly sourceLabel: string
  readonly sourceUrl: string
  /** Only the largest positions are listed; the rest is shown as a calculated remainder. */
  readonly partial?: boolean
  readonly rows: readonly { readonly label: string; readonly percent: number }[]
}

export type FundParty = { readonly name: string; readonly logo?: string }

export type FundToken = {
  /** Where the token is issued (DigiFT, NUVA). */
  readonly platform: string
  /** The chains the issuer lists for the token, primary first. */
  readonly networks: readonly string[]
  readonly contract: string | null
  readonly explorerUrl?: string
}

export interface ListedFund {
  /** Route id: /product/<id>. */
  readonly id: string
  readonly symbol: string
  readonly name: string
  /** Taxonomy key. The investor label is the category title (Cash Management, Income Strategies, Equity Exposure). */
  readonly category: VaultCategory
  /** Issuer filter key (ISSUERS registry). */
  readonly issuerKey: string
  readonly issuer: FundParty
  readonly manager: FundParty
  readonly about: readonly string[]
  readonly underlying: string
  readonly exposure: string
  readonly aum: { readonly value: string; readonly usd: number; readonly asOf: string; readonly label?: string }
  readonly metric: FundMetric
  /** One line under the headline rate on the detail page. */
  readonly metricNote: string
  /** The headline rate as a number, for sorting the APY column. */
  readonly rate: number
  /** NAV per share for constant-NAV funds; null when the token price is not published. */
  readonly price: string | null
  readonly liquidity: string
  readonly minInvestment: string
  readonly fees: { readonly management: number | null; readonly performance: number | null; readonly note: string }
  readonly settlement: string
  readonly redemptionDays: number
  readonly portfolio: {
    readonly snapshot?: FundBreakdown
    readonly industry?: FundBreakdown
    readonly exposure?: FundBreakdown
  }
  readonly facts: readonly FundFact[]
  readonly docs: readonly { readonly label: string; readonly href: string }[]
  readonly token: FundToken
}

const DIGIFT: FundParty = { name: "DigiFT", logo: "/logos/DigFT.png" }

const DIGIFT_PRODUCT = "https://www.digift.io/solutions/investDetail?tokenCode="
const RRDY_PAGE = `${DIGIFT_PRODUCT}RRDY`
const RRDY_LAUNCH = "https://insights.digift.io/digift-unlocks-on-chain-access-to-leading-u-s-treasury-money-market-fund/"
const CMBBOND_PAGE = `${DIGIFT_PRODUCT}CMBBOND`
const CMBI_BOND = "https://www.cmbi.com.hk/front/mfunddownload/file?key=mbnpjgZwvCEHbneIxLe8CQ%3D%3D&lang=en&method=inline"
const CMBI_HKEX = "https://ifp.hkex.com.hk/fund-repository/fund/BVJ946"
const NUVA_VAULT = "https://app.nuva.finance/en/vaults?asset=usdc&vault=nuva.home"
const NUVA_DEEP_DIVE = "https://nuva.finance/docs/home-deep-dive"
const NUVA_TECH = "https://nuva.finance/docs/technical-deep-dive"
const NUVA_COINDESK = "https://www.coindesk.com/business/2026/10/08/nuva-brings-u-s-residential-mortgage-credit-to-offshore-investors"
const HOME_CONTRACT = "0xdC1C0534109e2dB74fE800c84096547541607859"
const JX_PAGE = `${DIGIFT_PRODUCT}JX`
const JX_LAUNCH = "https://insights.digift.io/sbi-global-asset-management-and-digift-launch-jx-bringing-a-japanese-asset-managers-equity-strategy-on-chain-for-the-first-time/"
const SBI_MONTHLY = "https://www.sbiam.co.jp/fund/pdf/89313259_japanhighdiveq_dis1_mr_2609.pdf"
const SBI_PROSPECTUS = "https://sbiam.co.jp/fund/pdf/89313259_japanequity_annual_koufu_20260625.pdf"
const KTW50_PAGE = `${DIGIFT_PRODUCT}kTW50`
const KTW50_LAUNCH = "https://insights.digift.io/digift-and-kgi-bring-taiwans-ai-hardware-story-on-chain-with-ktw50/"
const KGI_ETF = "https://www.kgifund.com.tw/Fund/Detail?fundID=J023"
const KGI_FACTSHEET = "https://www.kgifund.com.tw/Upload/Files/ManageFileUploadMonths/J023.pdf"

export const LISTED_FUNDS: readonly ListedFund[] = [
  {
    id: "digift-rrdy",
    symbol: "RRDY",
    name: "Reserve-Grade US Treasury Strategy Token",
    category: "U.S Treasuries",
    issuerKey: "digift",
    issuer: DIGIFT,
    manager: { name: "Fidelity Investments", logo: "/logos/fidelity.png" },
    about: [
      "RRDY gives tokenized access to the OnChain Class of the Fidelity® Treasury Digital Fund, a U.S. Treasury money market fund managed by Fidelity Management & Research Company LLC. The fund invests in cash and U.S. Treasury bills, notes and bonds with short remaining maturities, which payment stablecoin issuers may hold as reserve assets under the GENIUS Act.",
      "The fund seeks current income consistent with the preservation of capital and liquidity, and is managed to keep a stable $1.00 share price. There is no guarantee that it will, and investors could lose money. Subscriptions settle on T+1 and redemptions on T+2.",
    ],
    underlying: "Fidelity® Treasury Digital Fund (OnChain Class)",
    exposure: "Cash and short-dated U.S. Treasuries",
    aum: { value: "$51M", usd: 51_000_000, asOf: "2026-09-30" },
    metric: { label: "7-day yield", value: "3.66%", asOf: "2026-09-30" },
    metricNote: "Seven-day yield of the underlying fund, as reported by DigiFT.",
    rate: 3.66,
    price: "$1.00",
    liquidity: "Daily at constant NAV, except Singapore and U.S. holidays",
    minInvestment: "USD 10,000",
    fees: { management: 0.2, performance: 0, note: "0.2% net expense ratio · No subscription or redemption fee" },
    settlement: "Subscription T+1 · Redemption T+2",
    redemptionDays: 2,
    portfolio: {
      exposure: {
        title: "Eligible reserve assets",
        scope: "Underlying fund holdings",
        asOf: "2026-10-06",
        sourceLabel: "DigiFT announcement",
        sourceUrl: RRDY_LAUNCH,
        rows: [{ label: "Cash and short-dated U.S. Treasuries", percent: 100 }],
      },
    },
    facts: [
      { label: "Underlying fund", value: "Fidelity® Treasury Digital Fund, OnChain Class: a mutual fund registered under the U.S. Investment Company Act of 1940.", sourceLabel: "DigiFT product page", sourceUrl: RRDY_PAGE },
      { label: "Investment adviser", value: "Fidelity Management & Research Company LLC.", sourceLabel: "DigiFT product page", sourceUrl: RRDY_PAGE },
      { label: "Inception", value: "The fund launched on 23 December 2024 and the OnChain Class on 4 August 2025.", sourceLabel: "DigiFT product page", sourceUrl: RRDY_PAGE },
      { label: "Maturity profile", value: "Weighted average maturity and weighted average life of 25 days each.", asOf: "2026-06-30", sourceLabel: "DigiFT product page", sourceUrl: RRDY_PAGE },
      { label: "Investment universe", value: "Cash and short-dated U.S. Treasuries that meet the GENIUS Act reserve-asset criteria for payment stablecoin issuers.", asOf: "2026-10-06", sourceLabel: "DigiFT announcement", sourceUrl: RRDY_LAUNCH },
      { label: "Eligible investors", value: "Accredited and institutional investors as defined under Singapore's Securities and Futures Act.", sourceLabel: "DigiFT product page", sourceUrl: RRDY_PAGE },
    ],
    docs: [
      { label: "DigiFT product page", href: RRDY_PAGE },
      { label: "DigiFT launch announcement", href: RRDY_LAUNCH },
    ],
    token: { platform: "DigiFT", networks: ["Ethereum"], contract: null },
  },
  {
    id: "digift-cmbbond",
    symbol: "CMBBOND",
    name: "CMBI Investment Grade Bond Fund Token",
    category: "Prime Credit",
    issuerKey: "digift",
    issuer: DIGIFT,
    manager: { name: "CMB International AM", logo: "/logos/digift-manager-cmbi.jpg" },
    about: [
      "CMBBOND gives tokenized access to the CMBI Investment Grade Bond Fund, managed by CMB International Asset Management. The fund can invest up to 100% of its NAV in global fixed income and debt instruments, including fixed and floating rate bonds.",
      "It seeks capital appreciation and interest income from investment-grade issuers, with an average credit rating of A and an average duration of 4.22 years as of 30 September 2026.",
    ],
    underlying: "CMBI Investment Grade Bond Fund (Class A USD)",
    exposure: "Investment-grade bonds",
    aum: { value: "$689M", usd: 689_000_000, asOf: "2026-07-31" },
    metric: { label: "Yield to maturity", value: "5.97%", asOf: "2026-10-09" },
    metricNote: "Yield to maturity of the fund's bond holdings, as shown by DigiFT. It does not represent fund performance.",
    rate: 5.97,
    price: null,
    liquidity: "Daily at NAV",
    minInvestment: "USD 1,000",
    fees: { management: 1, performance: 0, note: "No subscription or redemption fee" },
    settlement: "Subscription T+3 · Redemption T+4",
    redemptionDays: 4,
    portfolio: {
      industry: {
        title: "Sector",
        scope: "BICS level 1",
        asOf: "2026-09-30",
        sourceLabel: "CMBI monthly factsheet",
        sourceUrl: CMBI_BOND,
        partial: true,
        rows: [
          { label: "Financial", percent: 60.11 },
          { label: "Government", percent: 12.22 },
          { label: "Utilities", percent: 9.33 },
          { label: "Communications", percent: 7.55 },
          { label: "Industrial", percent: 6.26 },
          { label: "Consumer, Cyclical", percent: 0.88 },
          { label: "Consumer, Non-cyclical", percent: 0.63 },
          { label: "Basic Materials", percent: 0.15 },
        ],
      },
      exposure: {
        title: "Country / region",
        scope: "Fund portfolio",
        asOf: "2026-09-30",
        sourceLabel: "CMBI monthly factsheet",
        sourceUrl: CMBI_BOND,
        partial: true,
        rows: [
          { label: "Japan", percent: 28.4 },
          { label: "Mainland China", percent: 27.97 },
          { label: "United States", percent: 23.14 },
          { label: "Hong Kong SAR", percent: 4.95 },
          { label: "Netherlands", percent: 4.8 },
          { label: "United Kingdom", percent: 1.87 },
          { label: "Ireland", percent: 1.51 },
          { label: "Germany", percent: 1.18 },
          { label: "France", percent: 1.09 },
          { label: "Canada", percent: 0.84 },
          { label: "Macao SAR", percent: 0.74 },
          { label: "Australia", percent: 0.58 },
          { label: "Sweden", percent: 0.06 },
        ],
      },
    },
    facts: [
      { label: "Investment objective", value: "Capital appreciation and interest income from investment-grade fixed-income instruments globally.", sourceLabel: "CMBI monthly factsheet", sourceUrl: CMBI_BOND },
      { label: "Average duration", value: "4.22 years", asOf: "2026-09-30", sourceLabel: "CMBI monthly factsheet", sourceUrl: CMBI_BOND },
      { label: "Average credit rating", value: "A", asOf: "2026-09-30", sourceLabel: "CMBI monthly factsheet", sourceUrl: CMBI_BOND },
      { label: "Custodian", value: "CMB Wing Lung (Trustee) Limited", asOf: "2026-09-30", sourceLabel: "CMBI monthly factsheet", sourceUrl: CMBI_BOND },
      { label: "Fund AUM", value: "USD 689.23 million reported for the underlying fund.", asOf: "2026-07-31", sourceLabel: "HKEX fund repository", sourceUrl: CMBI_HKEX },
      { label: "Share class", value: "Class A (USD), accumulating. ISIN HK0001079653.", sourceLabel: "DigiFT product page", sourceUrl: CMBBOND_PAGE },
      { label: "Investment manager", value: "CMB International Asset Management Limited, licensed by the Hong Kong SFC and part of CMB International, a wholly owned subsidiary of China Merchants Bank.", sourceLabel: "DigiFT product page", sourceUrl: CMBBOND_PAGE },
    ],
    docs: [
      { label: "CMBI monthly factsheet", href: CMBI_BOND },
      { label: "DigiFT product page", href: CMBBOND_PAGE },
      { label: "HKEX fund page", href: CMBI_HKEX },
    ],
    token: { platform: "DigiFT", networks: ["Ethereum", "Plume"], contract: null },
  },
  {
    id: "nuva-home",
    symbol: "HOME",
    name: "NUVA HOME Vault",
    category: "Prime Credit",
    issuerKey: "nuva",
    issuer: { name: "NUVA", logo: "/logos/nuva.svg" },
    manager: { name: "Figure", logo: "/logos/figure.svg" },
    about: [
      "HOME is NUVA's private credit vault. It holds an actively managed portfolio of U.S. home equity lines of credit (HELOCs) originated and serviced by Figure Technology Solutions and its partners, and keeps about 5% in YLDS as a liquidity sleeve for withdrawals.",
      "A first-loss equity tranche absorbs losses before they reach HOME holders. The vault targets a 7% APY, a fixed rate set by NUVA and the portfolio manager and reset monthly.",
    ],
    underlying: "U.S. residential HELOCs originated by Figure",
    exposure: "Private credit, real estate-backed",
    aum: { value: "$10.01M", usd: 10_010_000, asOf: "2026-10-12", label: "TVL" },
    metric: { label: "Target APY", value: "7%", asOf: "2026-10-12" },
    metricNote: "Fixed target rate set by NUVA and the portfolio manager, reset monthly. Actual returns depend on portfolio performance and the equity tranche.",
    rate: 7,
    price: "$1.00",
    liquidity: "Withdraw any time, no lockup",
    minInvestment: "No minimum",
    fees: { management: null, performance: null, note: "NUVA shows the protocol fee as free; management fee amounts are not published" },
    settlement: "Deposit in 5–10 minutes · Withdrawal within 3 U.S. business days",
    redemptionDays: 3,
    portfolio: {
      snapshot: {
        title: "Target allocation",
        scope: "HOME vault",
        asOf: "2026-10-12",
        sourceLabel: "NUVA HOME deep dive",
        sourceUrl: NUVA_DEEP_DIVE,
        rows: [
          { label: "HELOC whole loans", percent: 95 },
          { label: "YLDS liquidity sleeve", percent: 5 },
        ],
      },
    },
    facts: [
      { label: "Portfolio manager", value: "Figure Investment Advisors LLC, an SEC-registered investment adviser, actively manages the portfolio.", sourceLabel: "NUVA HOME deep dive", sourceUrl: NUVA_DEEP_DIVE },
      { label: "Credit enhancement", value: "A first-loss equity tranche targeted at 5% of the vault, with a minimum of 3%, absorbs losses before HOME holders.", asOf: "2026-10-12", sourceLabel: "NUVA app", sourceUrl: NUVA_VAULT },
      { label: "Credit limits", value: "Weighted average FICO of at least 735, weighted average CLTV of at most 69%, mostly second-lien loans.", sourceLabel: "NUVA HOME deep dive", sourceUrl: NUVA_DEEP_DIVE },
      { label: "Originator record", value: "Figure has originated more than $28 billion in HELOCs since 2018.", sourceLabel: "NUVA HOME deep dive", sourceUrl: NUVA_DEEP_DIVE },
      { label: "Eligibility", value: "Eligible non-U.S. users only. The U.K., Hong Kong, China, the British Virgin Islands and sanctioned jurisdictions are excluded.", asOf: "2026-10-08", sourceLabel: "CoinDesk", sourceUrl: NUVA_COINDESK },
      { label: "Contract security", value: "6-of-9 multisig and a 48-hour timelock on upgrades.", sourceLabel: "NUVA technical deep dive", sourceUrl: NUVA_TECH },
    ],
    docs: [
      { label: "NUVA HOME vault", href: NUVA_VAULT },
      { label: "HOME deep dive", href: NUVA_DEEP_DIVE },
      { label: "nvHOME on Etherscan", href: `https://etherscan.io/token/${HOME_CONTRACT}` },
    ],
    token: { platform: "NUVA", networks: ["Ethereum"], contract: HOME_CONTRACT, explorerUrl: `https://etherscan.io/token/${HOME_CONTRACT}` },
  },
  {
    id: "digift-jx",
    symbol: "JX",
    name: "SBI Japan High Dividend Equity Strategy",
    category: "Equity Exposure",
    issuerKey: "digift",
    issuer: DIGIFT,
    manager: { name: "SBI Asset Management", logo: "/logos/digift-manager-sbi.jpg" },
    about: [
      "JX gives tokenized access to SBI Asset Management's Japan high-dividend equity strategy: an open-ended securities investment trust that invests in the SBI Japan High Dividend Equity Master Fund, with Mitsubishi UFJ Trust & Banking Corporation as trustee.",
      "The fund holds a high-conviction portfolio of Japanese listed equities chosen for high dividends and value, using a smart beta, value-tilted approach rather than tracking a broad index. It is growth-type: income is reinvested, and neither the fund nor the JX token pays distributions.",
    ],
    underlying: "SBI Japan High Dividend Equity Fund – Growth Type",
    exposure: "Japan equities",
    aum: { value: "$2.05B", usd: 2_050_000_000, asOf: "2026-09-30" },
    metric: { label: "12-month return", value: "39.66%", asOf: "2026-08-31" },
    metricNote: "Twelve-month return of the strategy, as reported by DigiFT.",
    rate: 39.66,
    price: null,
    liquidity: "Daily on Japan, Singapore and U.S. dealing days",
    minInvestment: "USD 10,027",
    fees: { management: 1.7, performance: 0, note: "No subscription fee · USD 80 redemption fee" },
    settlement: "Subscription T+2 · Redemption T+4",
    redemptionDays: 4,
    portfolio: {
      snapshot: {
        title: "Top 10 holdings",
        scope: "Strategy mother fund",
        asOf: "2026-09-30",
        sourceLabel: "SBI AM monthly report",
        sourceUrl: SBI_MONTHLY,
        partial: true,
        rows: [
          { label: "Mitsubishi UFJ Financial Group", percent: 3.75 },
          { label: "Sumitomo Mitsui Financial Group", percent: 3 },
          { label: "SoftBank Corp.", percent: 2.99 },
          { label: "Japan Tobacco", percent: 2.03 },
          { label: "Mitsubishi Corporation", percent: 1.95 },
          { label: "MS&AD Insurance Group", percent: 1.71 },
          { label: "Hirogin Holdings", percent: 1.66 },
          { label: "Citizen Watch", percent: 1.65 },
          { label: "Takeda Pharmaceutical", percent: 1.65 },
          { label: "Dai-ichi Life Group", percent: 1.63 },
        ],
      },
      industry: {
        title: "Top 10 sectors",
        scope: "Strategy mother fund",
        asOf: "2026-03-31",
        sourceLabel: "SBI AM prospectus",
        sourceUrl: SBI_PROSPECTUS,
        partial: true,
        rows: [
          { label: "Electric Appliances", percent: 10.6 },
          { label: "Banks", percent: 10.4 },
          { label: "Transportation Equipment", percent: 7.8 },
          { label: "Wholesale Trade", percent: 7.7 },
          { label: "Chemicals", percent: 6.7 },
          { label: "Insurance", percent: 5.9 },
          { label: "Pharmaceutical", percent: 5.5 },
          { label: "Information & Communication", percent: 5 },
          { label: "Construction", percent: 4.2 },
          { label: "Machinery", percent: 4.1 },
        ],
      },
    },
    facts: [
      { label: "Investment style", value: "A growth-type Japanese equity strategy focused on high-dividend securities and potential capital appreciation.", asOf: "2026-07-15", sourceLabel: "DigiFT launch announcement", sourceUrl: JX_LAUNCH },
      { label: "Distribution policy", value: "Neither the underlying fund nor the JX token pays distributions.", asOf: "2026-07-15", sourceLabel: "DigiFT launch announcement", sourceUrl: JX_LAUNCH },
      { label: "Holdings", value: "111 Japanese stocks in the strategy's mother fund.", asOf: "2026-09-30", sourceLabel: "SBI AM monthly report", sourceUrl: SBI_MONTHLY },
      { label: "Dividend yield", value: "3.03% weighted dividend yield of the mother fund's stocks.", asOf: "2026-09-30", sourceLabel: "SBI AM monthly report", sourceUrl: SBI_MONTHLY },
      { label: "Trustee", value: "Mitsubishi UFJ Trust & Banking Corporation, with SBI Asset Management as trustor.", sourceLabel: "DigiFT product page", sourceUrl: JX_PAGE },
    ],
    docs: [
      { label: "DigiFT product page", href: JX_PAGE },
      { label: "DigiFT launch announcement", href: JX_LAUNCH },
      { label: "SBI AM monthly report", href: SBI_MONTHLY },
    ],
    token: { platform: "DigiFT", networks: ["Ethereum", "Solana", "Plume"], contract: null },
  },
  {
    id: "digift-ktw50",
    symbol: "kTW50",
    name: "KGI Taiwan TOP 50 Fund Token",
    category: "Equity Exposure",
    issuerKey: "digift",
    issuer: DIGIFT,
    manager: { name: "KGI AM", logo: "/logos/digift-manager-kgi.svg" },
    about: [
      "kTW50 gives tokenized access to KGI Taiwan TOP 50 Feeder SP, which invests all or substantially all of its NAV in the KGI Taiwan TOP 50 ETF (TWSE: 009816). The ETF holds the top 50 Taiwan-listed companies screened by net profit and weighted by market capitalization, with significant exposure to electronics and semiconductors.",
      "KGI Asset Management manages the feeder fund and KGI Securities Investment Trust manages the ETF. Dividends are reinvested rather than paid out, and the ETF reviews its constituents four times a year.",
    ],
    underlying: "KGI Taiwan TOP 50 Feeder SP, investing in the KGI Taiwan TOP 50 ETF (TWSE: 009816)",
    exposure: "Taiwan equities",
    aum: { value: "$6.3B", usd: 6_300_000_000, asOf: "2026-09-23" },
    metric: { label: "6-month return", value: "55.72%", asOf: "2026-10-01" },
    metricNote: "Six-month return, as reported by DigiFT.",
    rate: 55.72,
    price: null,
    liquidity: "Daily, except Singapore, Taiwan and U.S. holidays",
    minInvestment: "USD 10,000",
    fees: { management: 0.9, performance: 0, note: "No subscription fee · USD 80 redemption fee" },
    settlement: "Subscription T+1 · Redemption T+7",
    redemptionDays: 7,
    portfolio: {
      snapshot: {
        title: "Top 10 holdings",
        scope: "KGI Taiwan TOP 50 ETF (009816)",
        asOf: "2026-10-08",
        sourceLabel: "KGI ETF profile",
        sourceUrl: KGI_ETF,
        partial: true,
        rows: [
          { label: "TSMC", percent: 40.55 },
          { label: "MediaTek", percent: 6.03 },
          { label: "Delta Electronics", percent: 3.55 },
          { label: "Taishin Shin Kong Financial", percent: 2.79 },
          { label: "Hon Hai", percent: 2.64 },
          { label: "Yuanta Financial", percent: 2.51 },
          { label: "ASE Technology", percent: 2.11 },
          { label: "Chunghwa Telecom", percent: 2.06 },
          { label: "E.SUN Financial", percent: 1.99 },
          { label: "SinoPac Financial", percent: 1.76 },
        ],
      },
      industry: {
        title: "Sector allocation",
        scope: "KGI Taiwan TOP 50 ETF (009816)",
        asOf: "2026-08-31",
        sourceLabel: "KGI factsheet",
        sourceUrl: KGI_FACTSHEET,
        rows: [
          { label: "Information Technology", percent: 72.75 },
          { label: "Financials", percent: 19.71 },
          { label: "Communication Services", percent: 2.6 },
          { label: "Materials", percent: 1.29 },
          { label: "Industrials", percent: 0.85 },
          { label: "Health Care", percent: 0.51 },
          { label: "Consumer Staples", percent: 0.33 },
          { label: "Energy", percent: 0.15 },
          { label: "Cash and liquid assets", percent: 1.81 },
        ],
      },
    },
    facts: [
      { label: "Index construction", value: "The underlying ETF tracks a 50-stock Taiwan index using liquidity and profitability screens, weighted by market capitalization.", asOf: "2026-09-24", sourceLabel: "KGI ETF profile", sourceUrl: KGI_ETF },
      { label: "Index review", value: "Constituents are reviewed four times a year, in February, May, August and November.", asOf: "2026-09-24", sourceLabel: "KGI ETF profile", sourceUrl: KGI_ETF },
      { label: "Distribution policy", value: "The underlying ETF is non-distributing.", asOf: "2026-09-24", sourceLabel: "KGI ETF profile", sourceUrl: KGI_ETF },
      { label: "Fund AUM", value: "TWD 199.8 billion for the underlying ETF, about USD 6.3 billion at the same-day TAIFEX rate of 31.72.", asOf: "2026-09-23", sourceLabel: "TWSE ETF AUM", sourceUrl: "https://www.twse.com.tw/zh/ETFortune/" },
      { label: "Fund structure", value: "A segregated portfolio of a Cayman Islands company, launched on 25 June 2026. kTW50 represents its Class A shares (ISIN KYG6008G1064).", sourceLabel: "DigiFT product page", sourceUrl: KTW50_PAGE },
      { label: "Managers", value: "KGI Asset Management Limited, licensed by the Hong Kong SFC, manages the feeder; KGI Securities Investment Trust, licensed by Taiwan's FSC, manages the ETF.", sourceLabel: "DigiFT product page", sourceUrl: KTW50_PAGE },
    ],
    docs: [
      { label: "DigiFT product page", href: KTW50_PAGE },
      { label: "DigiFT launch announcement", href: KTW50_LAUNCH },
      { label: "KGI ETF profile", href: KGI_ETF },
      { label: "KGI factsheet", href: KGI_FACTSHEET },
    ],
    token: { platform: "DigiFT", networks: ["Ethereum"], contract: null },
  },
]

/**
 * Headline rates for the deployed vaults from the same sources, keyed by product id. A rate the
 * operator publishes in the console still wins; these replace the legacy profile numbers.
 */
export const DEPLOYED_FUND_METRICS: Readonly<Record<string, { readonly metric: FundMetric; readonly rate: number }>> = {
  umint: { metric: { label: "7-day yield", value: "3.55%", asOf: "2026-10-09" }, rate: 3.55 },
  ibenji: { metric: { label: "7-day yield", value: "3.73%", asOf: "2026-09-30" }, rate: 3.73 },
  beqty: { metric: { label: "8-month return (est.)", value: "21.13%", asOf: "2026-07-31" }, rate: 21.13 },
}

export function listedFundById(id: string): ListedFund | undefined {
  return LISTED_FUNDS.find((fund) => fund.id === id)
}

/** Listed funds not already deployed (matched by symbol), narrowed by an optional search. */
export function listedFundsForCatalog(deployedSymbols: readonly string[], search = ""): ListedFund[] {
  const deployed = new Set(deployedSymbols.map((symbol) => symbol.toLowerCase()))
  const query = search.trim().toLowerCase()
  return LISTED_FUNDS.filter((fund) => {
    if (deployed.has(fund.symbol.toLowerCase())) return false
    if (!query) return true
    return [fund.symbol, fund.name, categoryTitle(fund.category), fund.manager.name, fund.issuer.name, fund.underlying, fund.exposure, ...fund.about]
      .join(" ")
      .toLowerCase()
      .includes(query)
  })
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "2026-09-30" → "30 Sep 2026". */
export function formatAsOf(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number)
  if (!year || !month || !day) return iso
  return `${day} ${MONTHS[month - 1]} ${year}`
}

/** "7-day yield · 30 Sep 2026" — the caption under a headline rate. */
export function metricCaption(metric: FundMetric): string {
  return `${metric.label} · ${formatAsOf(metric.asOf)}`
}
