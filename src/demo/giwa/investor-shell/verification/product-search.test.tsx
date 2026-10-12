import assert from "node:assert/strict"
import test from "node:test"
import snapshot from "./deployed-giwa.snapshot.json"
import type { GiwaCatalogItem } from "../../types"
import { buildSearchProducts, filterSearchProducts } from "../../product-search"
import { fixtureTop40Catalog, fixtureTop40Quotes } from "../../stocks-market/fixtures"
const catalog = snapshot.catalog as unknown as GiwaCatalogItem[]
const products = () => buildSearchProducts(catalog, snapshot.market, fixtureTop40Catalog().securities, fixtureTop40Quotes())
test("search lists the deployed 4 savings, 8 funds and catalog-owned 40 stocks with existing logos and exact destinations", () => {
  const all = products()
  assert.equal(all.length, 52)
  // 3 deployed vaults (aCAPIX is retired) and the 5 listed funds.
  assert.deepEqual(all.filter(p => p.category === "Funds").map(p => p.symbol), ["bEQTY", "auMINT", "aiBENJI", "RRDY", "CMBBOND", "HOME", "JX", "kTW50"])
  assert.deepEqual(all.filter(p => p.category === "Savings").map(p => p.symbol), ["USDC", "RLUSD", "ETH", "XRP"])
  assert.equal(all.find(p => p.symbol === "ETH")?.href, "/savings?asset=ETH&account=real%3Aaeth%3AETH")
  assert.equal(all.find(p => p.symbol === "SOXL")?.href, "/stocks?symbol=SOXL")
  assert.equal(all.find(p => p.symbol === "auMINT")?.href, "/product/umint")
  // No published rate in the snapshot, so DigiFT's 7-day yield replaces the legacy profile APY, named as what it is.
  assert.equal(all.find(p => p.symbol === "auMINT")?.value, "3.55% 7-day yield")
  assert.equal(all.find(p => p.symbol === "bEQTY")?.value, "21.13% 8-month return (est.)")
  assert.ok(all.every(p => p.image))
  assert.ok(!all.some(p => p.symbol === "BTC"))
  const hidden = catalog.map(p => ({ ...p, vaultConfig: { ...p.vaultConfig!, hidden: true } }))
  // Hidden vaults drop out; the listed funds are not registry vaults, so they stay.
  assert.deepEqual(buildSearchProducts(hidden, [], [], []).map(p => p.symbol), ["RRDY", "CMBBOND", "HOME", "JX", "kTW50"])
  assert.deepEqual(buildSearchProducts([], [], [{ symbol: "NEW", name: "New Listing" }]).filter(p => p.category === "Stocks").map(p => p.symbol), ["NEW"])
})
test("search matches names, tickers, managers and multiple words without crossing category filters", () => {
  assert.deepEqual(filterSearchProducts(products(), "  tEsLa  ", "All").map(p => p.symbol), ["TSLA"])
  assert.deepEqual(filterSearchProducts(products(), "semiconductor bull", "Stocks").map(p => p.symbol), ["SOXL"])
  assert.equal(filterSearchProducts(products(), "tesla", "Funds").length, 0)
  assert.equal(filterSearchProducts(products(), "UBS", "Funds")[0]?.symbol, "auMINT")
  assert.equal(filterSearchProducts(products(), "unknown product", "All").length, 0)
  assert.equal(filterSearchProducts(products(), "", "Stocks").length, 40)
})
test("missing or stale quotes do not invent current prices; independent savings/funds still list", () => {
  assert.equal(products().find(p => p.symbol === "SGOV")?.value, "—")
  assert.equal(products().find(p => p.symbol === "SCHD")?.change, undefined)
  assert.equal(buildSearchProducts(catalog, snapshot.market, []).length, 12)
  // The listed funds are not registry vaults, so they still list without a catalog.
  assert.equal(buildSearchProducts([], [], fixtureTop40Catalog().securities).length, 45)
})
