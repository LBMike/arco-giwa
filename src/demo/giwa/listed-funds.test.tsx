import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import GiwaProductDetailPage from "./ProductDetailPage"
import { categoryTitle } from "./fund-categories"
import { breakdownRows, listedFundPortfolio } from "./listed-fund-portfolio"
import { DEPLOYED_FUND_METRICS, LISTED_FUNDS, formatAsOf, listedFundById, listedFundsForCatalog, metricCaption, type FundBreakdown } from "./listed-funds"
import { buildSearchProducts } from "./product-search"
import { vaultCategoryRisk } from "./RiskTag"
import snapshot from "./investor-shell/verification/deployed-giwa.snapshot.json"
import type { GiwaCatalogItem } from "./types"

// The fund lineup is eight products: auMINT, aiBENJI and bEQTY are deployed on GIWA Sepolia, and
// RRDY, CMBBOND, HOME, JX and kTW50 are listed with the same content and an invest panel that
// reads "Coming soon". aCAPIX is no longer offered.

const catalog = snapshot.catalog as unknown as GiwaCatalogItem[]
const CAPTURED = "2026-10-12"

function renderRoute(path: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["giwa", "catalog"], catalog)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/product/:id" element={<GiwaProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function views(fund: (typeof LISTED_FUNDS)[number]): FundBreakdown[] {
  return [fund.portfolio.snapshot, fund.portfolio.industry, fund.portfolio.exposure].filter((view): view is FundBreakdown => Boolean(view))
}

test("five listed funds complete the lineup, one tier per category", () => {
  assert.deepEqual(
    LISTED_FUNDS.map((fund) => [fund.symbol, categoryTitle(fund.category), vaultCategoryRisk(fund.category)]),
    [
      ["RRDY", "Cash Management", "low"],
      ["CMBBOND", "Income Strategies", "medium"],
      ["HOME", "Income Strategies", "medium"],
      ["JX", "Equity Exposure", "high"],
      ["kTW50", "Equity Exposure", "high"],
    ],
  )
  assert.equal(new Set(LISTED_FUNDS.map((fund) => fund.id)).size, LISTED_FUNDS.length)
  assert.doesNotMatch(JSON.stringify(LISTED_FUNDS), /\b(CMBMINT|ULTRA|TKStable|GOLDX|aCAPIX|Midas|mTBILL)\b/i)
})

test("every listed fund carries the full product content with dated sources", () => {
  for (const fund of LISTED_FUNDS) {
    const name = fund.symbol
    assert.ok(fund.about.length > 0 && fund.about.every((paragraph) => paragraph.length > 60), `${name} about`)
    assert.match(fund.aum.value, /^\$\d+(\.\d{1,2})?[MB]$/, `${name} AUM`)
    assert.ok(fund.aum.usd > 0, `${name} AUM in USD`)
    // Financial values: at most two decimals, no forced trailing zeros.
    assert.match(fund.metric.value, /^\d+(\.\d?[1-9])?%$/, `${name} headline rate`)
    assert.equal(fund.rate, Number.parseFloat(fund.metric.value), `${name} sort rate`)
    assert.ok(fund.metricNote.length > 0 && fund.minInvestment.length > 0 && fund.settlement.length > 0 && fund.liquidity.length > 0, `${name} terms`)
    assert.ok(fund.fees.note.length > 0, `${name} fee note`)
    assert.ok(Number.isInteger(fund.redemptionDays) && fund.redemptionDays > 0, `${name} redemption days`)
    assert.ok(fund.facts.length >= 3, `${name} facts`)
    assert.ok(fund.docs.length > 0, `${name} docs`)
    assert.ok(views(fund).length > 0, `${name} portfolio`)

    const urls = [...fund.facts.map((fact) => fact.sourceUrl), ...fund.docs.map((doc) => doc.href), ...views(fund).map((view) => view.sourceUrl)]
    for (const url of urls) assert.match(url, /^https:\/\//, `${name} ${url}`)
    const dates = [fund.aum.asOf, fund.metric.asOf, ...fund.facts.flatMap((fact) => (fact.asOf ? [fact.asOf] : [])), ...views(fund).map((view) => view.asOf)]
    for (const date of dates) {
      assert.match(date, /^2026-\d{2}-\d{2}$/, `${name} ${date}`)
      assert.ok(date <= CAPTURED, `${name} ${date} is not after the capture date`)
    }
    for (const view of views(fund)) {
      const total = view.rows.reduce((sum, row) => sum + row.percent, 0)
      if (view.partial) assert.ok(total < 100, `${name} ${view.title} lists part of the fund`)
      else assert.ok(Math.abs(total - 100) < 0.01, `${name} ${view.title} adds up to 100%`)
    }
  }
})

test("a partial breakdown shows its calculated remainder, a full one does not", () => {
  const jx = listedFundById("digift-jx")!
  const rows = breakdownRows(jx.portfolio.snapshot)
  assert.equal(rows.length, 11)
  assert.deepEqual(rows[rows.length - 1], { label: "Remaining weight (calculated)", value: null, pct: 77.98 })
  assert.equal(breakdownRows(listedFundById("digift-ktw50")!.portfolio.industry).length, 9)

  const rrdy = listedFundPortfolio(listedFundById("digift-rrdy")!)!
  assert.deepEqual(rrdy.enabledViews, { snapshot: false, industry: false, exposure: true })
  assert.equal(rrdy.exposureHeading, "Eligible reserve assets")
  assert.equal(rrdy.card.updatedAt, "6 Oct 2026")
})

test("a listed fund leaves the catalog once its symbol is deployed, and follows the search box", () => {
  const symbols = (deployed: string[], search?: string) => listedFundsForCatalog(deployed, search).map((fund) => fund.symbol)
  assert.deepEqual(symbols([]), ["RRDY", "CMBBOND", "HOME", "JX", "kTW50"])
  assert.deepEqual(symbols(["auMINT", "home"]), ["RRDY", "CMBBOND", "JX", "kTW50"])
  assert.deepEqual(symbols([], "figure"), ["HOME"])
  assert.deepEqual(symbols([], "taiwan"), ["kTW50"])
  assert.deepEqual(symbols([], "cash management"), ["RRDY"])
  assert.deepEqual(symbols([], "income strategies"), ["CMBBOND", "HOME"])
})

test("deployed vaults take the latest dated rates from DigiFT and the fund deck", () => {
  assert.deepEqual(Object.keys(DEPLOYED_FUND_METRICS).sort(), ["beqty", "ibenji", "umint"])
  assert.equal(metricCaption(DEPLOYED_FUND_METRICS.umint.metric), "7-day yield · 9 Oct 2026")
  assert.equal(metricCaption(DEPLOYED_FUND_METRICS.ibenji.metric), "7-day yield · 30 Sep 2026")
  assert.equal(metricCaption(DEPLOYED_FUND_METRICS.beqty.metric), "8-month return (est.) · 31 Jul 2026")
  assert.equal(formatAsOf("2026-10-01"), "1 Oct 2026")
  assert.equal(formatAsOf("soon"), "soon")
})

test("search lists the eight funds and no aCAPIX", () => {
  const funds = buildSearchProducts(catalog, [], []).filter((product) => product.category === "Funds")
  assert.deepEqual(funds.map((product) => product.symbol), ["bEQTY", "auMINT", "aiBENJI", "RRDY", "CMBBOND", "HOME", "JX", "kTW50"])
  assert.equal(funds.find((product) => product.symbol === "HOME")?.href, "/product/nuva-home")
  assert.equal(funds.find((product) => product.symbol === "auMINT")?.value, "3.55% 7-day yield")
})

test("every listed fund page has the deployed page's sections and a Coming soon panel", () => {
  for (const fund of LISTED_FUNDS) {
    const html = renderRoute(`/product/${fund.id}`)
    assert.match(html, /data-testid="listed-fund-detail"/, fund.symbol)
    for (const section of ["overview", "performance", "transparency", "more-info"]) assert.match(html, new RegExp(`id="${section}"`), `${fund.symbol} ${section}`)
    assert.ok(html.includes(`>${fund.symbol}</h1>`), `${fund.symbol} title`)
    assert.ok(html.includes(fund.metric.value), `${fund.symbol} rate`)
    assert.ok(html.includes(fund.aum.value), `${fund.symbol} AUM`)
    assert.ok(html.includes(">Portfolio<"), `${fund.symbol} portfolio`)
    for (const fact of fund.facts) assert.ok(html.includes(`>${fact.label}<`), `${fund.symbol} ${fact.label}`)
    assert.match(html, /<button type="button" disabled="" class="[^"]*">Coming soon<\/button>/, `${fund.symbol} action`)
    assert.ok(html.includes(">GIWA<"), `${fund.symbol} network`)
    assert.doesNotMatch(html, /Reference profile|Preview only|read-only|aCAPIX|mTBILL|Midas/i, fund.symbol)
  }
})

test("the token card lists the original chains; HOME links its Ethereum contract", () => {
  const home = renderRoute("/product/nuva-home")
  assert.ok(home.includes("https://etherscan.io/token/0xdC1C0534109e2dB74fE800c84096547541607859"))
  assert.ok(home.includes("0xdC1C…7859"))
  assert.ok(home.includes(">Original network</dt><dd class=\"text-right text-sm text-[var(--color-arco-ink)]\">Ethereum<"))
  const jx = renderRoute("/product/digift-jx")
  assert.ok(jx.includes(">Original networks<") && jx.includes(">Ethereum, Solana, Plume<"))
  assert.doesNotMatch(jx, /etherscan/) // no contract address published
})

test("the retired aCAPIX page reads Product not found", () => {
  const html = renderRoute("/product/acapix")
  assert.ok(html.includes("Product not found."))
  assert.doesNotMatch(html, /aCAPIX/)
})
