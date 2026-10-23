import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import GiwaHomePage from "./HomePage"
import { countLabel, fundsProductsOf, homeSavingsSummary } from "./home"
import { vaultConfigOf } from "./catalog"
import { GIWA_CHAIN_ID } from "./config"
import { StocksPageEnvironment } from "./stocks-market/environment"
import { GiwaFeaturesContext, type GiwaFeatures } from "./features"
import type { GiwaMarketEntry } from "./api"
import type { GiwaAcceptAsset, GiwaCatalogItem, GiwaVaultConfig } from "./types"

function cfg(overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return { ...vaultConfigOf({ vaultConfig: null }), ...overrides }
}
function vault(productId: string, symbol: string, overrides: Partial<GiwaVaultConfig> | null): GiwaCatalogItem {
  return {
    productId,
    symbol,
    name: symbol,
    paymentAssetSymbol: "tUSDC",
    paymentAsset: null,
    paymentAssetAddress: null,
    productTokenAddress: null,
    depositVaultAddress: null,
    redemptionVaultAddress: null,
    priceFeedAddress: null,
    vaultConfig: overrides ? cfg(overrides) : null,
  } as GiwaCatalogItem
}
function accept(symbol: string, savingVaultId: string | null, isDummy: boolean): GiwaAcceptAsset {
  return { symbol, icon: `/logos/${symbol.toLowerCase()}.png`, apy: isDummy ? 3.8 : null, savingVaultId, isDummy, sortOrder: null }
}

const catalog: GiwaCatalogItem[] = [
  vault("acapix", "aCAPIX", { kind: "product" }), // retired: contracts stay, no longer offered
  vault("hiddenfund", "HIDDEN", { kind: "product", hidden: true }),
  vault("arcousd", "arcoUSD", {
    kind: "saving",
    acceptAssets: [accept("USDC", "arcousd", false), accept("RLUSD", null, true)],
  }),
  vault("arcoeth", "arcoETH", { kind: "saving", acceptAssets: [accept("ETH", "arcoeth", false)] }),
  vault("legacy", "LEGACY", null), // no config → defaults (visible product)
]
const market: GiwaMarketEntry[] = [
  { productId: "arcousd", navBase: null, baseUsd: null, navUsd: null, apy: 4.2, impliedApy: null },
]

test("fundsProductsOf keeps the Funds page predicate: no hidden, saving or retired vaults", () => {
  assert.deepEqual(
    fundsProductsOf(catalog).map((product) => product.productId),
    ["legacy"],
  )
  assert.deepEqual(fundsProductsOf([]), [])
})

test("homeSavingsSummary counts selectable accounts and coming-soon entries from buildSavingsAccounts", () => {
  const summary = homeSavingsSummary(catalog, market)
  // Savings selector order (no pin/AUM here → productId: arcoeth before arcousd).
  assert.deepEqual(summary.accounts.map((account) => account.symbol), ["ETH", "USDC"])
  assert.equal(summary.comingSoon, 1)
  assert.deepEqual(homeSavingsSummary([], []), { accounts: [], comingSoon: 0 })
  assert.equal(countLabel(1, "product", "products"), "1 product")
  assert.equal(countLabel(0, "product", "products"), "0 products")
})

// Home and Stocks shown unless a case says otherwise (the app hides both now: features.ts).
function renderHome(seed: (client: QueryClient) => void, features: GiwaFeatures = { home: true, stocks: true }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  seed(client)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GiwaFeaturesContext.Provider value={features}>
        <StocksPageEnvironment.Provider value={{ apiBase: null }}>
          <MemoryRouter initialEntries={["/"]}>
            <GiwaHomePage />
          </MemoryRouter>
        </StocksPageEnvironment.Provider>
      </GiwaFeaturesContext.Provider>
    </QueryClientProvider>,
  )
}

test("Home hidden (as the app ships): the route renders no page, it opens Savings; Stocks hidden: no Stocks section", () => {
  const seed = (client: QueryClient) => {
    client.setQueryData(["giwa", "catalog"], [])
    client.setQueryData(["giwa", "market", GIWA_CHAIN_ID], [])
  }
  assert.equal(renderHome(seed, { home: false, stocks: false }), "")
  const withoutStocks = renderHome(seed, { home: true, stocks: false })
  assert.match(withoutStocks, /<h1/)
  assert.doesNotMatch(withoutStocks, /Stocks/)
})

function linkText(html: string, href: string): string {
  const match = html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>(.*?)</a>`))
  assert.ok(match, `link to ${href}`)
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

test("Home renders one h1, Savings/Funds cards with data counts, and the Stocks section", () => {
  const html = renderHome((client) => {
    client.setQueryData(["giwa", "catalog"], catalog)
    client.setQueryData(["giwa", "market", GIWA_CHAIN_ID], market)
  })
  assert.equal(html.match(/<h1[\s>]/g)?.length, 1)
  assert.match(html, /<h1[^>]*>Home<\/h1>/)
  assert.match(html, /<h2[^>]*>Invest<\/h2>/)
  assert.match(html, /<h2[^>]*>Stocks<\/h2>/)
  assert.equal(linkText(html, "/savings"), "Savings 2 savings accounts · 1 coming soon ETH — APY USDC 4.2% APY Open Savings")
  // Brand marks are decorative next to the symbol text.
  assert.match(html, /<span aria-hidden="true"[^>]*><img src="\/logos\/usdc.png"/)
  // The deployed vaults first, then the listed funds with their own headline rate (sr-only label).
  assert.equal(
    linkText(html, "/funds"),
    "Funds 7 products L LEGACY — APY RRDY 3.66% 7-day yield CMBBOND 5.97% Yield to maturity HOME 7% Target APY JX 39.66% 12-month return kTW50 55.72% 6-month return PPLUS 12.53% 30-day avg. APY Browse funds",
  )
  assert.equal(linkText(html, "/stocks"), "View all stocks")
  const invest = html.slice(html.indexOf('aria-labelledby="home-invest"'), html.indexOf('aria-labelledby="home-stocks"'))
  assert.match(invest, /text-\[var\(--color-arco-up-text\)\]/)
  assert.doesNotMatch(invest, /HIDDEN|RLUSD|aCAPIX/)
})

test("Home shows Loading… before the catalog arrives and Registry unavailable on a catalog error", () => {
  const loading = renderHome(() => undefined)
  assert.equal(linkText(loading, "/savings"), "Savings Loading… Open Savings")
  assert.equal(linkText(loading, "/funds"), "Funds Loading… Browse funds")

  const failed = renderHome((client) => {
    client
      .getQueryCache()
      .build(client, { queryKey: ["giwa", "catalog"] })
      .setState({ status: "error", error: new Error("offline"), fetchStatus: "idle" })
  })
  assert.equal(linkText(failed, "/savings"), "Savings Registry unavailable Open Savings")
  assert.equal(linkText(failed, "/funds"), "Funds Registry unavailable Browse funds")
  assert.doesNotMatch(failed, /offline/)
})

test("Home fund chips use configured identities and published, legacy, implied rates including zero", () => {
  const products = [
    vault("credit", "cFUND", { kind: "product", displayName: "Credit Fund", vaultImageUrl: "/logos/credit.svg" }),
    vault("newfund", "New Fund", { kind: "product" }),
  ]
  const html = renderHome(client => {
    client.setQueryData(["giwa", "catalog"], products)
    client.setQueryData(["giwa", "market", GIWA_CHAIN_ID], [
      { productId: "CREDIT", apy: 0, impliedApy: 99 },
      { productId: "newfund", apy: null, impliedApy: 3.456 },
    ])
  })
  assert.equal(
    linkText(html, "/funds"),
    "Funds 8 products Credit Fund 0% APY N New Fund 3.46% APY RRDY 3.66% 7-day yield CMBBOND 5.97% Yield to maturity HOME 7% Target APY JX 39.66% 12-month return kTW50 55.72% 6-month return PPLUS 12.53% 30-day avg. APY Browse funds",
  )
  assert.match(html, /src="\/logos\/credit.svg"/)
})

test("a deployed fund chip names the fund deck's rate when no rate is published", () => {
  const html = renderHome(client => {
    client.setQueryData(["giwa", "catalog"], [vault("umint", "auMINT", { kind: "product" })])
    client.setQueryData(["giwa", "market", GIWA_CHAIN_ID], [{ productId: "umint", apy: null, impliedApy: 3.49 }])
  })
  assert.match(linkText(html, "/funds"), /^Funds 7 products (\S )?auMINT 3\.55% 7-day yield RRDY 3\.66% 7-day yield /)
})
