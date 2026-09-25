/** Additional primary-source facts for the read-only DigiFT product profiles.
 * Fund and ETF snapshots below are never token balances, prices, or Arco holdings.
 */

export interface DigiFTResearchFact {
  readonly label: string
  readonly value: string
  readonly scope: string
  readonly asOf?: string
  readonly sourceLabel: string
  readonly sourceUrl: string
}

export interface DigiFTPortfolioSnapshot {
  readonly title: string
  readonly scope: string
  readonly asOf: string
  readonly sourceLabel: string
  readonly sourceUrl: string
  readonly partial?: boolean
  readonly rows: readonly { readonly label: string; readonly percent: string }[]
  /** Display-only industry groups derived from the named snapshot rows, not a source-reported sector table. */
  readonly industryGroups?: readonly { readonly label: string; readonly rowLabels: readonly string[] }[]
  readonly unclassifiedIndustryLabel?: string
}

export interface DigiFTResearchProfile {
  readonly facts: readonly DigiFTResearchFact[]
  readonly portfolio?: DigiFTPortfolioSnapshot
}

const CMBI_MMF = 'https://www.cmbi.com/front/mfunddownload/file?key=V%2FNiXSsqdcTRi9fqnfq8bg%3D%3D&lang=en&method=inline'
const ULTRA_LAUNCH = 'https://insights.digift.io/digift-advances-access-to-tokenized-treasury-sub-managed-by-wellington/'
const ULTRA_FUND = 'https://forum.arbitrum.foundation/t/delta-wellington-ultra-short-treasury-on-chain-fund-ultra-by-fundbridge-capital-step-2-application/28765'
const TKSTABLE_LAUNCH = 'https://insights.digift.io/digift-taikang-am-hk-launch-asia-led-stable-income-token/'
const CMBI_BOND = 'https://www.cmbi.com.hk/front/mfunddownload/file?key=mbnpjgZwvCEHbneIxLe8CQ%3D%3D&lang=en&method=inline'
const JX_LAUNCH = 'https://insights.digift.io/sbi-global-asset-management-and-digift-launch-jx-bringing-a-japanese-asset-managers-equity-strategy-on-chain-for-the-first-time/'
const KGI_ETF = 'https://www.kgifund.com.tw/Fund/Detail?fundID=J023'
const KGI_FACTSHEET = 'https://www.kgifund.com.tw/Upload/Files/ManageFileUploadMonths/J023.pdf?20260321000817='
const GOLD_FUND = 'https://www.lionglobalinvestors.com/en/fund-lionglobal-singapore-physical-gold-fund.html'
const GOLD_FACTSHEET = 'https://lgi.dzhintl.com/doc/uploads/documents/index.php?fid=ASPGF&lang=EN&type=FS'
const GOLD_LAUNCH = 'https://www.ocbc.com/group/media/release/2026/ocbc-lion-global-investors-and-digifit-launches-southeast-asia-first-onchain-tokenised-gold-fund.page'

export const DIGIFT_RESEARCH: Readonly<Record<string, DigiFTResearchProfile>> = {
  'digift-cmbmint': {
    facts: [
      { label: 'Investment policy', value: 'At least 70% of NAV is invested in USD-denominated short-term deposits and high-quality money-market instruments.', scope: 'Underlying fund', asOf: '2026-07-31', sourceLabel: 'CMBI monthly factsheet', sourceUrl: CMBI_MMF },
      { label: 'Weighted average maturity', value: '58.53 days', scope: 'Underlying fund', asOf: '2026-07-31', sourceLabel: 'CMBI monthly factsheet', sourceUrl: CMBI_MMF },
      { label: 'Capital and NAV', value: 'Principal is not guaranteed and the fund does not maintain a constant NAV.', scope: 'Underlying fund', asOf: '2026-07-31', sourceLabel: 'CMBI monthly factsheet', sourceUrl: CMBI_MMF },
    ],
    portfolio: {
      title: 'Underlying fund allocation', scope: 'CMB International USD Money Market Fund', asOf: '2026-07-31', sourceLabel: 'CMBI monthly factsheet', sourceUrl: CMBI_MMF,
      rows: [
        { label: 'Fixed deposits', percent: '40.28%' },
        { label: 'Commercial paper and CDs', percent: '34.95%' },
        { label: 'Cash and other assets', percent: '24.77%' },
      ],
      industryGroups: [
        { label: 'Banking (fixed deposits)', rowLabels: ['Fixed deposits'] },
      ],
    },
  },
  'digift-ultra': {
    facts: [
      { label: 'Fund management', value: 'FundBridge Capital manages the fund; Wellington Management Singapore is the investment sub-manager.', scope: 'Underlying fund', asOf: '2025-03-20', sourceLabel: 'FundBridge application', sourceUrl: ULTRA_FUND },
      { label: 'Investment universe', value: 'Primarily U.S. Treasuries with less than one year to maturity; repo, reverse repo and cash may also be held.', scope: 'Underlying fund', asOf: '2025-03-20', sourceLabel: 'FundBridge application', sourceUrl: ULTRA_FUND },
      { label: 'Tokenized access', value: 'Libeara first tokenized the strategy on Ethereum in November 2024; DigiFT later added regulated distribution.', scope: 'ULTRA token', asOf: '2025-07-16', sourceLabel: 'DigiFT launch announcement', sourceUrl: ULTRA_LAUNCH },
    ],
  },
  'digift-tkstable': {
    facts: [
      { label: 'Strategy manager', value: 'Taikang Asset Management (Hong Kong) manages the stable-income strategy represented by TKStable.', scope: 'Underlying strategy', asOf: '2025-12-10', sourceLabel: 'DigiFT launch announcement', sourceUrl: TKSTABLE_LAUNCH },
      { label: 'Tokenized access', value: 'DigiFT describes TKStable as a tokenized representation for accredited and professional investors.', scope: 'TKStable token', asOf: '2025-12-10', sourceLabel: 'DigiFT launch announcement', sourceUrl: TKSTABLE_LAUNCH },
    ],
  },
  'digift-cmbbond': {
    facts: [
      { label: 'Investment objective', value: 'The fund seeks capital appreciation and interest income from investment-grade fixed-income instruments globally.', scope: 'Underlying fund', asOf: '2026-08-31', sourceLabel: 'CMBI monthly report', sourceUrl: CMBI_BOND },
      { label: 'Average duration', value: '3.97 years', scope: 'Underlying fund', asOf: '2026-08-31', sourceLabel: 'CMBI monthly report', sourceUrl: CMBI_BOND },
      { label: 'Average credit rating', value: 'BBB+', scope: 'Underlying fund', asOf: '2026-08-31', sourceLabel: 'CMBI monthly report', sourceUrl: CMBI_BOND },
      { label: 'Custodian', value: 'CMB Wing Lung (Trustee) Limited', scope: 'Underlying fund', asOf: '2026-08-31', sourceLabel: 'CMBI monthly report', sourceUrl: CMBI_BOND },
    ],
  },
  'digift-jx': {
    facts: [
      { label: 'Investment style', value: 'A growth-type Japanese equity strategy focused on high-dividend securities and potential capital appreciation.', scope: 'Underlying strategy', asOf: '2026-07-15', sourceLabel: 'DigiFT launch announcement', sourceUrl: JX_LAUNCH },
      { label: 'Distribution policy', value: 'DigiFT states that neither the underlying fund nor JX token pays distributions.', scope: 'Fund and JX token', asOf: '2026-07-15', sourceLabel: 'DigiFT launch announcement', sourceUrl: JX_LAUNCH },
    ],
  },
  'digift-ktw50': {
    facts: [
      { label: 'Index construction', value: 'The underlying ETF tracks a 50-stock Taiwan index using liquidity and profitability screens, weighted by market capitalization.', scope: 'Underlying ETF 009816', asOf: '2026-09-24', sourceLabel: 'KGI ETF profile', sourceUrl: KGI_ETF },
      { label: 'Index review', value: 'Constituents are reviewed four times a year, in February, May, August and November.', scope: 'Underlying ETF 009816', asOf: '2026-09-24', sourceLabel: 'KGI ETF profile', sourceUrl: KGI_ETF },
      { label: 'Distribution policy', value: 'The underlying ETF is non-distributing.', scope: 'Underlying ETF 009816', asOf: '2026-09-24', sourceLabel: 'KGI ETF profile', sourceUrl: KGI_ETF },
      { label: 'Industry grouping of shown holdings', value: 'The issuer classifies TSMC, MediaTek, Delta Electronics and Hon Hai as Information Technology, and Taishin Shin Kong Financial as Financials. The displayed five holdings are only part of the ETF.', scope: 'Selected top five holdings', sourceLabel: 'KGI ETF factsheet', sourceUrl: KGI_FACTSHEET },
    ],
    portfolio: {
      title: 'Underlying ETF top holdings', scope: 'KGI Taiwan TOP 50 ETF (009816)', asOf: '2026-09-24', sourceLabel: 'KGI ETF profile', sourceUrl: KGI_ETF, partial: true,
      rows: [
        { label: 'TSMC', percent: '40.11%' },
        { label: 'MediaTek', percent: '6.96%' },
        { label: 'Delta Electronics', percent: '3.52%' },
        { label: 'Taishin Shin Kong Financial', percent: '2.97%' },
        { label: 'Hon Hai', percent: '2.70%' },
      ],
      industryGroups: [
        { label: 'Information Technology (shown holdings)', rowLabels: ['TSMC', 'MediaTek', 'Delta Electronics', 'Hon Hai'] },
        { label: 'Financials (shown holdings)', rowLabels: ['Taishin Shin Kong Financial'] },
      ],
      unclassifiedIndustryLabel: 'Remaining portfolio weight (not shown)',
    },
  },
  'digift-goldx': {
    facts: [
      { label: 'Fund and token roles', value: 'Lion Global Investors manages the underlying gold fund; OCBC led the tokenization structure with DigiFT.', scope: 'Underlying fund / GOLDX', asOf: '2026-04-20', sourceLabel: 'OCBC launch announcement', sourceUrl: GOLD_LAUNCH },
      { label: 'Gold custody', value: 'Individually identified, segregated bars of at least 99.5% fineness are vaulted at Le Freeport in Singapore.', scope: 'Underlying fund', sourceLabel: 'Lion Global fund profile', sourceUrl: GOLD_FUND },
      { label: 'Insurance', value: 'Allocated gold is insured against loss, theft and damage in custody and transit, subject to standard exclusions.', scope: 'Underlying fund', sourceLabel: 'Lion Global fund profile', sourceUrl: GOLD_FUND },
    ],
    portfolio: {
      title: 'Underlying fund gold holdings', scope: 'LionGlobal Singapore Physical Gold Fund', asOf: '2026-03-31', sourceLabel: 'Lion Global factsheet', sourceUrl: GOLD_FACTSHEET,
      rows: [
        { label: 'Allocated gold', percent: '99.31%' },
        { label: 'Unallocated gold', percent: '0.69%' },
      ],
      industryGroups: [
        { label: 'Precious metals (gold)', rowLabels: ['Allocated gold', 'Unallocated gold'] },
      ],
    },
  },
}
