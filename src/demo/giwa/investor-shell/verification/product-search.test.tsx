import assert from "node:assert/strict"
import test from "node:test"
import snapshot from "./deployed-giwa.snapshot.json"
import type { GiwaCatalogItem } from "../../types"
import { buildSearchProducts, filterSearchProducts } from "../../product-search"
import { fixtureTop40Catalog, fixtureTop40Quotes } from "../../stocks-market/fixtures"
const catalog = snapshot.catalog as unknown as GiwaCatalogItem[]
const products = () => buildSearchProducts(catalog, snapshot.market, fixtureTop40Catalog().securities, fixtureTop40Quotes())
test("search lists the deployed 4 savings, 4 funds and catalog-owned 40 stocks with existing logos and exact destinations", () => {
  const all = products()
  assert.equal(all.length, 48)
  assert.deepEqual(all.filter(p => p.category === "Savings").map(p => p.symbol), ["USDC", "RLUSD", "ETH", "XRP"])
  assert.equal(all.find(p => p.symbol === "ETH")?.href, "/savings?asset=ETH&account=real%3Aaeth%3AETH")
  assert.equal(all.find(p => p.symbol === "SOXL")?.href, "/stocks?symbol=SOXL")
  assert.equal(all.find(p => p.symbol === "auMINT")?.href, "/product/umint")
  assert.equal(all.find(p => p.symbol === "auMINT")?.value, "4.21% APY")
  assert.ok(all.every(p => p.image))
  assert.ok(!all.some(p => p.symbol === "BTC"))
  const hidden = catalog.map(p => ({ ...p, vaultConfig: { ...p.vaultConfig!, hidden: true } }))
  assert.equal(buildSearchProducts(hidden, [], [], []).length, 0)
  assert.equal(buildSearchProducts([], [], [{ symbol: "NEW", name: "New Listing" }]).length, 1)
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
  assert.equal(buildSearchProducts(catalog, snapshot.market, []).length, 8)
  assert.equal(buildSearchProducts([], [], fixtureTop40Catalog().securities).length, 40)
})
