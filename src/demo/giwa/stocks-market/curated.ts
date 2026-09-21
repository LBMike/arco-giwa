// Hand-written display metadata for the curated 40 (logo, kind, English name). The server catalog still owns the list,
// its order and every value; this module only decorates rows the server returns and records how the 40 were chosen.
// No settlement figure is kept: the source ranked buy-settlement amounts, which are not prices, volume or market cap.
export type CuratedKind = "STOCK" | "ETF"
export type CuratedDetail = null | "ADS" | "LEVERAGED_OR_INVERSE"
export type CuratedStock = { readonly rank: number; readonly symbol: string; readonly name: string; readonly kind: CuratedKind; readonly detail: CuratedDetail; readonly isin: string; readonly logoFile: string; readonly logoOwner: string }

export const CURATED_SELECTION = Object.freeze({
  source: "한국예탁결제원 SEIBro 해외주식 종목별내역(주식TOP50)",
  metric: "매수결제금액 상위 40",
  period: "2026-08-16~2026-09-15",
  retrievedDate: "2026-09-16",
  note: "이전에 조회한 자료를 선정 참고로만 사용했으며 다시 조회하지 않았습니다. 투자 추천이나 시가총액 순위가 아닙니다.",
})

const row = (rank: number, symbol: string, name: string, kind: CuratedKind, detail: CuratedDetail, isin: string, logoFile: string, logoOwner: string): CuratedStock => Object.freeze({ rank, symbol, name, kind, detail, isin, logoFile, logoOwner })

export const CURATED_STOCKS: readonly CuratedStock[] = Object.freeze([
  row(1, "SOXL", "Direxion Daily Semiconductor Bull 3X Shares", "ETF", "LEVERAGED_OR_INVERSE", "US25459W4583", "direxion.png", "Direxion"),
  row(2, "MU", "Micron Technology, Inc.", "STOCK", null, "US5951121038", "micron.png", "Micron Technology, Inc."),
  row(3, "TSLA", "Tesla, Inc.", "STOCK", null, "US88160R1014", "tesla.png", "Tesla, Inc."),
  row(4, "SNDK", "Sandisk Corporation", "STOCK", null, "US80004C2008", "sandisk.png", "Sandisk Corporation"),
  row(5, "GOOGL", "Alphabet Inc.", "STOCK", null, "US02079K3059", "alphabet.png", "Google (Alphabet Inc.)"),
  row(6, "SOXS", "Direxion Daily Semiconductor Bear 3X Shares", "ETF", "LEVERAGED_OR_INVERSE", "US25461H2913", "direxion.png", "Direxion"),
  row(7, "SGOV", "iShares 0-3 Month Treasury Bond ETF", "ETF", null, "US46436E7186", "ishares.png", "iShares by BlackRock"),
  row(8, "SPCX", "Space Exploration Technologies Corp.", "STOCK", null, "US84615Q1031", "spacex.png", "Space Exploration Technologies Corp."),
  row(9, "SCHD", "Schwab U.S. Dividend Equity ETF", "ETF", null, "US8085247976", "schwab.png", "Charles Schwab"),
  row(10, "NVDA", "NVIDIA Corporation", "STOCK", null, "US67066G1040", "nvidia.png", "NVIDIA Corporation"),
  row(11, "VOO", "Vanguard S&P 500 ETF", "ETF", null, "US9229083632", "vanguard.png", "Vanguard"),
  row(12, "KORU", "Direxion Daily South Korea Bull 3X Shares", "ETF", "LEVERAGED_OR_INVERSE", "US25461A3876", "direxion.png", "Direxion"),
  row(13, "AVGO", "Broadcom Inc.", "STOCK", null, "US11135F1012", "broadcom.png", "Broadcom Inc."),
  row(14, "IONQ", "IonQ, Inc.", "STOCK", null, "US46222L1089", "ionq.png", "IonQ, Inc."),
  row(15, "MSTR", "Strategy Inc", "STOCK", null, "US5949724083", "strategy.png", "Strategy Inc"),
  row(16, "META", "Meta Platforms, Inc.", "STOCK", null, "US30303M1027", "meta.png", "Meta Platforms, Inc."),
  row(17, "TQQQ", "ProShares UltraPro QQQ", "ETF", "LEVERAGED_OR_INVERSE", "US74347X8314", "proshares.png", "ProShares"),
  row(18, "QQQM", "Invesco NASDAQ 100 ETF", "ETF", null, "US46138G6492", "invesco.png", "Invesco"),
  row(19, "AMZN", "Amazon.com, Inc.", "STOCK", null, "US0231351067", "amazon.png", "Amazon.com, Inc."),
  row(20, "IREN", "IREN Limited", "STOCK", null, "AU0000185993", "iren.png", "IREN Limited"),
  row(21, "QLD", "ProShares Ultra QQQ", "ETF", "LEVERAGED_OR_INVERSE", "US74347R2067", "proshares.png", "ProShares"),
  row(22, "SKHY", "SK hynix Inc.", "STOCK", "ADS", "US78392B2060", "sk-hynix.png", "SK hynix Inc."),
  row(23, "MRK", "Merck & Co., Inc.", "STOCK", null, "US58933Y1055", "merck.png", "Merck & Co., Inc."),
  row(24, "MRVL", "Marvell Technology, Inc.", "STOCK", null, "US5738741041", "marvell.png", "Marvell Technology, Inc."),
  row(25, "QQQ", "Invesco QQQ", "ETF", null, "US46090E1038", "invesco.png", "Invesco"),
  row(26, "SMR", "NuScale Power Corporation", "STOCK", null, "US67079K1007", "nuscale.png", "NuScale Power Corporation"),
  row(27, "JEPQ", "JPMorgan Nasdaq Equity Premium Income ETF", "ETF", null, "US46654Q2030", "jpmorgan.png", "J.P. Morgan Asset Management"),
  row(28, "LITE", "Lumentum Holdings Inc.", "STOCK", null, "US55024U1097", "lumentum.png", "Lumentum Holdings Inc."),
  row(29, "BE", "Bloom Energy Corporation", "STOCK", null, "US0937121079", "bloom-energy.png", "Bloom Energy Corporation"),
  row(30, "DRAM", "Roundhill Memory ETF", "ETF", null, "US77926X3200", "roundhill.png", "Roundhill Investments"),
  row(31, "NBIS", "Nebius Group N.V.", "STOCK", null, "NL0009805522", "nebius.png", "Nebius Group N.V."),
  row(32, "PLTR", "Palantir Technologies Inc.", "STOCK", null, "US69608A1088", "palantir.png", "Palantir Technologies Inc."),
  row(33, "SOXX", "iShares Semiconductor ETF", "ETF", null, "US4642875235", "ishares.png", "iShares by BlackRock"),
  row(34, "INTC", "Intel Corporation", "STOCK", null, "US4581401001", "intel.png", "Intel Corporation"),
  row(35, "RAM", "Roundhill T-REX 2X Long DRAM Daily Target ETF", "ETF", "LEVERAGED_OR_INVERSE", "US26923V4150", "roundhill.png", "Roundhill Investments"),
  row(36, "ORCL", "Oracle Corporation", "STOCK", null, "US68389X1054", "oracle.png", "Oracle Corporation"),
  row(37, "MRNA", "Moderna, Inc.", "STOCK", null, "US60770K1079", "moderna.png", "Moderna, Inc."),
  row(38, "CRCL", "Circle Internet Group, Inc.", "STOCK", null, "US1725731079", "circle.png", "Circle Internet Group, Inc."),
  row(39, "BMNR", "Bitmine Immersion Technologies, Inc.", "STOCK", null, "US09175A2069", "bitmine.png", "Bitmine Immersion Technologies, Inc."),
  row(40, "RKLB", "Rocket Lab Corporation", "STOCK", null, "US7731211089", "rocket-lab.png", "Rocket Lab Corporation"),
])

const BY_SYMBOL: ReadonlyMap<string, CuratedStock> = new Map(CURATED_STOCKS.map(item => [item.symbol, item]))
export function curatedStock(symbol: string): CuratedStock | null { return BY_SYMBOL.get(symbol) ?? null }
/** Same-origin static path, never a remote URL. */
export function stockLogoPath(symbol: string): string | null { const item = BY_SYMBOL.get(symbol); return item ? `/logos/stocks/${item.logoFile}` : null }
/** True only when the symbols are exactly the curated 40 (same set, no duplicates, nothing extra). */
export function matchesCuratedSelection(symbols: readonly string[]): boolean { return symbols.length === BY_SYMBOL.size && new Set(symbols).size === symbols.length && symbols.every(symbol => BY_SYMBOL.has(symbol)) }
