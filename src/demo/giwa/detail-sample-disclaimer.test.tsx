import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProductDetailView } from "./ProductDetailPage"
import { GiwaWalletProvider } from "./wallet"
import type { GiwaCatalogItem } from "./types"

// The "Representative sample content — … aCAPIX examples …" disclaimer was removed from every
// GIWA surface: the page-level note (About / Transparency / More Info) and the swap-card note.
// An UNCONFIGURED vault is the worst case: it used to borrow aCAPIX's About, fees and portfolio,
// so the note rendered three times on the page plus once in the panel. It now borrows nothing.

const unconfigured: GiwaCatalogItem = {
  productId: "abtc",
  symbol: "aBTC",
  name: "Arco BTC",
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
  vaultConfig: null,
} as unknown as GiwaCatalogItem

function renderDetail(product: GiwaCatalogItem): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GiwaWalletProvider>
        <MemoryRouter>
          <ProductDetailView product={product} />
        </MemoryRouter>
      </GiwaWalletProvider>
    </QueryClientProvider>,
  )
}

test("detail page renders NO representative-sample disclaimer, even for an unconfigured vault", () => {
  const html = renderDetail(unconfigured)
  assert.doesNotMatch(html, /Representative sample content/)
  assert.doesNotMatch(html, /aCAPIX examples/)
  assert.doesNotMatch(html, /not this product/) // catches any reworded remnant of the note
})

test("removing the disclaimer leaves the surrounding sections intact", () => {
  const html = renderDetail(unconfigured)
  for (const section of ["Performance", "Transparency", "Fee structure", "More Info", "Smart Contracts"]) {
    assert.match(html, new RegExp(section), section)
  }
})

test("an unconfigured vault shows no other fund's About, fees or portfolio", () => {
  const html = renderDetail(unconfigured)
  assert.doesNotMatch(html, />About</) // no About copy configured → no About card
  assert.doesNotMatch(html, />Portfolio</) // no breakdown configured → no Portfolio card
  assert.doesNotMatch(html, /aCAPIX|Aksia|mTBILL|Midas/)
})
