import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { GiwaCatalogTable } from "./components"
import { ProductDetailView } from "./ProductDetailPage"
import { GiwaWalletProvider } from "./wallet"
import { vaultConfigOf } from "./catalog"
import type { GiwaCatalogItem, GiwaVaultConfig } from "./types"

// The vault NAME must resolve identically on the products list (GiwaCatalogRow) and the
// product detail header (ProductDetailView) — both call vaultDisplayName(product) =
// config.displayName ?? symbol — so one admin displayName edit updates both surfaces.

const base: GiwaCatalogItem = {
  productId: "acapix",
  symbol: "aCAPIX",
  name: "Arco CAPIX Fund",
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
function cfg(overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return { ...vaultConfigOf({ vaultConfig: null }), ...overrides }
}
function vault(overrides: Partial<GiwaVaultConfig>): GiwaCatalogItem {
  return { ...base, vaultConfig: cfg(overrides) }
}

function renderList(product: GiwaCatalogItem): string {
  return renderToStaticMarkup(
    <GiwaCatalogTable rows={[product]} selectedProductId="" sortKey="aum" sortDir="desc" onSelect={() => undefined} />,
  )
}

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

test("displayName SET → list row and detail header render the SAME config-first name", () => {
  const product = vault({ displayName: "Prime Credit Fund" })
  assert.match(renderList(product), /Prime Credit Fund/) // list name = displayName
  assert.match(renderDetail(product), /Prime Credit Fund/) // detail <h1> = displayName (was raw symbol)
})

test("displayName NULL → both fall back to the raw symbol", () => {
  const product = vault({}) // no displayName override
  assert.match(renderList(product), /aCAPIX/)
  assert.match(renderDetail(product), /aCAPIX/)
})
