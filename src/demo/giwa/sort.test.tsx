import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { compareNullLast, nextSort, sortByNumericKey } from "./sort"
import { parseAumToNumber } from "./display-profile"
import { GiwaCatalogTable } from "./components"
import type { GiwaCatalogItem } from "./types"

// ── Shared helpers (pure) ──────────────────────────────────────────────────

test("compareNullLast: numeric compare respects direction", () => {
  assert.ok(compareNullLast(1, 2, "asc") < 0)
  assert.ok(compareNullLast(1, 2, "desc") > 0)
  assert.equal(compareNullLast(5, 5, "asc"), 0)
})

test("compareNullLast: null/undefined ALWAYS ranks last, in both directions", () => {
  for (const dir of ["asc", "desc"] as const) {
    assert.ok(compareNullLast(null, 5, dir) > 0, `null after value (${dir})`)
    assert.ok(compareNullLast(5, null, dir) < 0, `value before null (${dir})`)
    assert.ok(compareNullLast(undefined, 5, dir) > 0, `undefined after value (${dir})`)
  }
  assert.equal(compareNullLast(null, null, "desc"), 0)
})

test("sortByNumericKey keeps nulls last in BOTH directions (not floated by a sentinel)", () => {
  const data = [{ v: 3 }, { v: null }, { v: 1 }, { v: 2 }]
  assert.deepEqual(sortByNumericKey(data, (d) => d.v, "desc").map((d) => d.v), [3, 2, 1, null])
  assert.deepEqual(sortByNumericKey(data, (d) => d.v, "asc").map((d) => d.v), [1, 2, 3, null])
})

test("nextSort: toggles the active column; a new column starts at its default (desc)", () => {
  assert.deepEqual(nextSort({ key: "aum", dir: "desc" }, "aum"), { key: "aum", dir: "asc" })
  assert.deepEqual(nextSort({ key: "aum", dir: "asc" }, "aum"), { key: "aum", dir: "desc" })
  assert.deepEqual(nextSort({ key: "aum", dir: "asc" }, "apy"), { key: "apy", dir: "desc" })
  // Portfolio holdings default is set by the caller (Your Deposit desc); a new column honours it.
  assert.deepEqual(nextSort({ key: "deposit", dir: "asc" }, "balance", "asc"), { key: "balance", dir: "asc" })
})

// ── Vault-list AUM key: PARSED numeric value, not lexical string order ──────

test("AUM sorts by the PARSED numeric value ($1.2B > $903M > $50M), not lexically", () => {
  const rows = [
    { s: "a", aum: "$50M" },
    { s: "b", aum: "$1.2B" },
    { s: "c", aum: null },
    { s: "d", aum: "$903M" },
  ]
  const sorted = sortByNumericKey(rows, (r) => parseAumToNumber(r.aum), "desc", (r) => r.s)
  // parsed: 1.2e9 > 903e6 > 50e6 > null-last
  assert.deepEqual(sorted.map((r) => r.s), ["b", "d", "a", "c"])
  // A lexical desc sort of the strings would be ["$903M","$50M","$1.2B", …] — assert we are NOT that.
  assert.notDeepEqual(sorted.map((r) => r.aum), ["$903M", "$50M", "$1.2B", null])
})

// ── Portfolio holdings: Balance / Your Deposit / APY all numeric, nulls last ─

test("holdings sort: Balance/Your Deposit/APY compare numerically with nulls last", () => {
  const holdings = [
    { symbol: "aA", shares: 10, usd: 100, apy: 5 },
    { symbol: "bB", shares: 3, usd: null, apy: null },
    { symbol: "cC", shares: 7, usd: 900, apy: 2 },
  ]
  const bySymbol = (h: (typeof holdings)[number]) => h.symbol
  assert.deepEqual(
    sortByNumericKey(holdings, (h) => h.shares, "desc", bySymbol).map(bySymbol),
    ["aA", "cC", "bB"], // 10 > 7 > 3
  )
  assert.deepEqual(
    sortByNumericKey(holdings, (h) => h.usd, "desc", bySymbol).map(bySymbol),
    ["cC", "aA", "bB"], // 900 > 100 > null-last
  )
  assert.deepEqual(
    sortByNumericKey(holdings, (h) => h.apy, "asc", bySymbol).map(bySymbol),
    ["cC", "aA", "bB"], // 2 < 5, null STILL last under asc
  )
})

// ── Component render order (renderToStaticMarkup, phase5-style) ─────────────

const baseProduct: GiwaCatalogItem = {
  productId: "acapix",
  symbol: "aCAPIX",
  name: "Arco CAPIX",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: {
    symbol: "tUSDC",
    name: "Test USDC",
    decimals: 6,
    contract: { proxy: "0x00000000000000000000000000000000000000a1" },
    faucet: "0x00000000000000000000000000000000000000f1",
  },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
}

// Full vault-config shape (partial configs would make pinned undefined → NaN in the comparator).
function cfg(overrides: Record<string, unknown>) {
  return {
    displayName: null, category: null, description: null, adminDepositAddress: null,
    cardSnapshot: true, cardIndustry: true, cardExposure: true, pinned: false, hidden: false,
    assetManagerName: null, issuerName: null, about: null, aum: null, redemptionTimelineDays: null,
    feeInstantMintingBps: null, feeInstantRedemptionBps: null, feeManagementBps: null, feePerformanceBps: null,
    vaultImageUrl: null, assetManagerImageUrl: null, issuerImageUrl: null,
    portfolioSnapshot: null, portfolioIndustry: null, portfolioExposure: null,
    ...overrides,
  }
}

// Registered (non-built-in) product so legacy profile AUM/APY are null and config/market drive the key.
function mk(productId: string, symbol: string, config?: Record<string, unknown>): GiwaCatalogItem {
  return { ...baseProduct, productId, symbol, name: symbol, vaultConfig: config ? cfg(config) : undefined } as GiwaCatalogItem
}

test("GiwaCatalogTable orders rows by config-first numeric AUM, nulls last, in both directions", () => {
  const rows = [
    mk("va", "SORTAAA", { aum: "$50M" }),
    mk("vb", "SORTBBB", { aum: "$1.2B" }),
    mk("vc", "SORTCCC", { aum: "$903M" }),
    mk("vd", "SORTDDD", {}), // no aum, non-built-in → key null → last
  ]

  const desc = renderToStaticMarkup(
    <GiwaCatalogTable rows={rows} selectedProductId="" sortKey="aum" sortDir="desc" onSelect={() => undefined} />,
  )
  const atDesc = (s: string) => desc.indexOf(s)
  assert.ok(atDesc("SORTBBB") < atDesc("SORTCCC"), "$1.2B before $903M") // parsed, not lexical
  assert.ok(atDesc("SORTCCC") < atDesc("SORTAAA"), "$903M before $50M")
  assert.ok(atDesc("SORTAAA") < atDesc("SORTDDD"), "real AUM before null")

  const asc = renderToStaticMarkup(
    <GiwaCatalogTable rows={rows} selectedProductId="" sortKey="aum" sortDir="asc" onSelect={() => undefined} />,
  )
  const atAsc = (s: string) => asc.indexOf(s)
  assert.ok(atAsc("SORTAAA") < atAsc("SORTCCC"), "$50M before $903M")
  assert.ok(atAsc("SORTCCC") < atAsc("SORTBBB"), "$903M before $1.2B")
  assert.ok(atAsc("SORTBBB") < atAsc("SORTDDD"), "null STILL last under asc")
})

test("GiwaCatalogTable orders rows by resolved numeric APY (published → implied), nulls last", () => {
  const rows = [mk("pa", "APYAAA"), mk("pb", "APYBBB"), mk("pc", "APYCCC"), mk("pd", "APYDDD")]
  const apyByProductId = { pa: 5, pb: 12, pc: null, pd: null }
  const impliedApyByProductId = { pc: 8, pd: null } // pc falls back to implied 8; pd stays null

  const html = renderToStaticMarkup(
    <GiwaCatalogTable
      rows={rows}
      selectedProductId=""
      sortKey="apy"
      sortDir="desc"
      onSelect={() => undefined}
      apyByProductId={apyByProductId}
      impliedApyByProductId={impliedApyByProductId}
    />,
  )
  const at = (s: string) => html.indexOf(s)
  assert.ok(at("APYBBB") < at("APYCCC"), "12% before implied 8%")
  assert.ok(at("APYCCC") < at("APYAAA"), "implied 8% before 5%")
  assert.ok(at("APYAAA") < at("APYDDD"), "real APY before null")
})
