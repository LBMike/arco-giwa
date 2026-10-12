import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GIWA_EMPTY_FILTERS, GiwaCatalogTable, applyListedFilters, type GiwaCategory, type GiwaFilters } from "./components"
import { fundsProductsOf } from "./home"
import { LISTED_FUNDS } from "./listed-funds"
import snapshot from "./investor-shell/verification/deployed-giwa.snapshot.json"
import type { GiwaCatalogItem } from "./types"

// Every funds-list row shows a coloured risk tag and then the product's category. The tier follows
// the category, so it matches that category's Strategies card.

const catalog = snapshot.catalog as unknown as GiwaCatalogItem[]
const funds = fundsProductsOf(catalog)
const arcoSaving = catalog.find((item) => item.productId === "arcousd")!

function render(rows: GiwaCatalogItem[], withListed = true, apyByProductId?: Record<string, number | null>) {
  return renderToStaticMarkup(
    <GiwaCatalogTable
      rows={rows}
      listedRows={withListed ? LISTED_FUNDS : []}
      selectedProductId=""
      sortKey="aum"
      sortDir="desc"
      onSelect={() => undefined}
      apyByProductId={apyByProductId}
    />,
  )
}

function pair(level: string, label: string, category: string): RegExp {
  const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`data-risk="${level}"[^>]*>${label}</span><span[^>]*>${escaped}</span>`, "g")
}

test("deployed fund rows: aCAPIX is retired, the rest show tier and category", () => {
  assert.deepEqual(funds.map((item) => item.productId).sort(), ["beqty", "ibenji", "umint"])
  const html = render(funds, false)
  assert.equal((html.match(pair("low", "Low Risk", "Cash Management")) ?? []).length, 2) // auMINT, aiBENJI
  assert.equal((html.match(pair("high", "High Risk", "Equity Exposure")) ?? []).length, 1) // bEQTY
  assert.equal((html.match(/data-risk=/g) ?? []).length, 3)
  assert.doesNotMatch(html, /aCAPIX|U\.S\. Treasuries|Prime Credit/)
})

test("listed fund rows: tier and category from the catalog taxonomy", () => {
  const html = render([], true)
  assert.equal((html.match(/data-testid="listed-fund-row"/g) ?? []).length, 5)
  assert.equal((html.match(pair("low", "Low Risk", "Cash Management")) ?? []).length, 1) // RRDY
  assert.equal((html.match(pair("medium", "Medium Risk", "Income Strategies")) ?? []).length, 2) // CMBBOND, HOME
  assert.equal((html.match(pair("high", "High Risk", "Equity Exposure")) ?? []).length, 2) // JX, kTW50
  assert.equal((html.match(/data-risk=/g) ?? []).length, 5)
})

test("risk tags use the theme tokens, one tone per tier", () => {
  const html = render(funds, true)
  for (const level of ["low", "medium", "high"]) {
    assert.match(html, new RegExp(`data-risk="${level}" class="[^"]*bg-\\[var\\(--color-risk-${level}-bg\\)\\] text-\\[var\\(--color-risk-${level}-ink\\)\\]`))
  }
})

test("an Arco Saving row gets no risk tag", () => {
  assert.equal(arcoSaving.vaultConfig?.category, "Arco Saving")
  const html = render([arcoSaving], false)
  assert.doesNotMatch(html, /data-risk=/)
})

test("deployed and listed rows sort together by AUM", () => {
  const html = render(funds, true)
  const order = ["auMINT", "kTW50", "JX", "aiBENJI", "bEQTY", "CMBBOND", "RRDY", "HOME"].map((symbol) => html.indexOf(`>${symbol}<`))
  assert.ok(order.every((at) => at >= 0), "every symbol renders")
  assert.deepEqual([...order].sort((a, b) => a - b), order)
})

test("deployed rows show the fund deck's dated rate unless the operator published one", () => {
  const html = render(funds, false)
  // The date is kept on one line when a long caption wraps.
  assert.match(html, />3\.55%<\/span><span[^>]*>7-day yield · <span class="whitespace-nowrap">9 Oct 2026<\/span>/) // auMINT
  assert.match(html, />3\.73%<\/span><span[^>]*>7-day yield · <span class="whitespace-nowrap">30 Sep 2026<\/span>/) // aiBENJI
  const published = render(funds, false, { beqty: 13.41 })
  assert.match(published, />13\.41%<\/span>/)
  assert.doesNotMatch(published, /8-month return/)
})

test("listed funds follow every filter the deployed vaults use", () => {
  const symbols = (patch: Partial<GiwaFilters>) => applyListedFilters(LISTED_FUNDS, { ...GIWA_EMPTY_FILTERS, ...patch }).map((fund) => fund.symbol)
  const category = (value: GiwaCategory[]) => symbols({ category: value })
  assert.deepEqual(category([]), ["RRDY", "CMBBOND", "HOME", "JX", "kTW50"])
  assert.deepEqual(category(["U.S Treasuries"]), ["RRDY"])
  assert.deepEqual(category(["Prime Credit"]), ["CMBBOND", "HOME"])
  assert.deepEqual(category(["Equity Exposure"]), ["JX", "kTW50"])
  assert.deepEqual(category(["Arco Saving"]), [])
  assert.deepEqual(symbols({ issuer: ["nuva"] }), ["HOME"])
  assert.deepEqual(symbols({ issuer: ["arco"] }), [])
  assert.deepEqual(symbols({ denomination: ["USD"] }).length, 5)
  assert.deepEqual(symbols({ denomination: ["BTC"] }), [])
  assert.deepEqual(symbols({ network: ["Ethereum"] }).length, 5) // every listed token is issued on Ethereum
  assert.deepEqual(symbols({ network: ["Giwa"] }).length, 5)
  assert.deepEqual(symbols({ network: ["XRPL"] }), [])
})
