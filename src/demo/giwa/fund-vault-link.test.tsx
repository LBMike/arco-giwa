import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import GiwaProductDetailPage from "./ProductDetailPage"
import { ListedFundDetail } from "./ListedFundDetail"
import { vaultImageFor } from "./catalog"
import { fundsProductsOf } from "./home"
import { LISTED_FUND_VAULTS, listedFundById, listedFundForVault, vaultProductIdForFund } from "./listed-funds"
import { GiwaWalletProvider } from "./wallet"
import type { GiwaCatalogItem } from "./types"

// HOME, JX and PPLUS are listed funds with a vault on GIWA Sepolia. Each has ONE page: the listed
// fund's page (/product/nuva-home …) carrying the vault's live Invest / Redeem panel. The vault's
// own id (/product/home …) opens that page, and catalog views list the fund once.

const vault = (productId: string, symbol: string, hidden = true): GiwaCatalogItem =>
  ({
    productId,
    symbol,
    name: `${symbol} vault`,
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
    vaultConfig: { hidden },
  }) as unknown as GiwaCatalogItem

function renderRoute(path: string, catalog: GiwaCatalogItem[] | undefined): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (catalog) client.setQueryData(["giwa", "catalog"], catalog)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GiwaWalletProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/product/:id" element={<GiwaProductDetailPage />} />
          </Routes>
        </MemoryRouter>
      </GiwaWalletProvider>
    </QueryClientProvider>,
  )
}

test("the three lineup funds map to their registry product ids, both ways", () => {
  assert.deepEqual(LISTED_FUND_VAULTS, { "nuva-home": "home", "digift-jx": "jxfund", "bitwise-pplus": "pplus" })
  for (const [fundId, productId] of Object.entries(LISTED_FUND_VAULTS)) {
    assert.ok(listedFundById(fundId), `listed fund ${fundId} exists`)
    assert.equal(vaultProductIdForFund(fundId), productId)
    assert.equal(listedFundForVault(productId)?.id, fundId)
    assert.equal(listedFundForVault(productId.toUpperCase())?.id, fundId)
  }
  assert.equal(vaultProductIdForFund("digift-rrdy"), undefined)
  assert.equal(listedFundForVault("umint"), undefined)
})

test("a fund's vault is not listed beside the fund once the vault is un-hidden", () => {
  const catalog = [vault("umint", "uMINT", false), vault("home", "HOME", false), vault("jxfund", "JX", false), vault("pplus", "PPLUS", false)]
  assert.deepEqual(fundsProductsOf(catalog).map((product) => product.productId), ["umint"])
})

test("a listed fund with a vault shows the vault's live panel, not Coming soon, even while the vault is hidden", () => {
  const html = renderRoute("/product/bitwise-pplus", [vault("pplus", "PPLUS", true)])
  assert.match(html, /data-testid="listed-fund-detail"/)
  assert.doesNotMatch(html, /Coming soon/)
  assert.doesNotMatch(html, /data-testid="listed-fund-panel"/)
  assert.match(html, /Live on GIWA Sepolia/)
  assert.match(html, /Smart Contracts/)
  // The vault's Price / APY chart card sits in Performance, above the fund's published rate.
  assert.match(html, /No performance data yet/)
  // The fund's own content is still the page.
  assert.match(html, /Bitwise Premium\+ RWA Vault/)
  assert.match(html, /Fund facts|Product terms/)
})

test("without the vault in the catalog the fund page falls back to Coming soon; while the catalog loads it waits", () => {
  const missing = renderRoute("/product/nuva-home", [vault("umint", "uMINT", false)])
  assert.match(missing, /data-testid="listed-fund-panel"/)
  assert.match(missing, /Coming soon/)
  assert.doesNotMatch(missing, /No performance data yet/)
  const loading = renderRoute("/product/nuva-home", undefined)
  assert.match(loading, /Loading product/)
  assert.doesNotMatch(loading, /Coming soon/)
})

test("a listed fund without a vault keeps the Coming soon panel", () => {
  const fund = listedFundById("digift-rrdy")
  assert.ok(fund)
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ListedFundDetail fund={fund} />
    </MemoryRouter>,
  )
  assert.match(html, /Coming soon/)
  assert.doesNotMatch(html, /Live on GIWA Sepolia/)
})

test("the vault's own product id opens the fund's page", () => {
  // Navigate renders nothing on the server; the fund page must not be built under the vault id.
  const html = renderRoute("/product/home", [vault("home", "HOME", true)])
  assert.doesNotMatch(html, /Product not found/)
  assert.doesNotMatch(html, /data-testid="listed-fund-detail"/)
})

test("a fund's vault shows the fund's mark as its token image; an admin-set image still wins", () => {
  assert.equal(vaultImageFor(vault("home", "HOME")), "/logos/nuva-home.svg")
  assert.equal(vaultImageFor(vault("jxfund", "JX")), "/logos/jx.png")
  assert.equal(vaultImageFor(vault("pplus", "PPLUS")), "/logos/bitwise.png")
  const custom = { ...vault("home", "HOME"), vaultConfig: { hidden: true, vaultImageUrl: "/logos/custom.png" } } as unknown as GiwaCatalogItem
  assert.equal(vaultImageFor(custom), "/logos/custom.png")
  // The invest panel on the fund page uses it: no letter badge for the token.
  const html = renderRoute("/product/nuva-home", [vault("home", "HOME", true)])
  assert.match(html, /\/logos\/nuva-home\.svg/)
})
