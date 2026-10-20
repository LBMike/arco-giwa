import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { buildActivityFeed } from "./activity-feed"
import { GiwaCatalogTable, GiwaHoldingsTable } from "./components"
import { ProductDetailView } from "./ProductDetailPage"
import { GiwaWalletProvider } from "./wallet"
import { tokenSymbolFor, vaultConfigOf, vaultDisplayName, vaultImageFor } from "./catalog"
import type { GiwaActivity, GiwaCatalogItem, GiwaPortfolio, GiwaVaultConfig } from "./types"

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

test("the arcoUSD Savings vault's share is shown as sArcoUSD with its own mark, wherever customers see it", () => {
  // Its contract keeps the symbol arcoUSD; the app presents the savings token, ahead of an image set in Vault Config.
  const arcoUsd: GiwaCatalogItem = {
    ...base,
    productId: "arcousd",
    symbol: "arcoUSD",
    name: "Arco USD",
    vaultConfig: cfg({ kind: "saving", vaultImageUrl: "https://pbs.twimg.com/profile_images/1/arco_400x400.png" }),
  }
  assert.equal(tokenSymbolFor(arcoUsd), "sArcoUSD")
  assert.equal(vaultDisplayName(arcoUsd), "sArcoUSD")
  assert.equal(vaultImageFor(arcoUsd), "/logos/sarcousd.png")
  // A display name set in Vault Config still names the vault.
  assert.equal(vaultDisplayName({ ...arcoUsd, vaultConfig: cfg({ displayName: "Arco Savings" }) }), "Arco Savings")

  // Product page header: the mark and the name.
  const detail = renderDetail(arcoUsd)
  assert.match(detail, /<img src="\/logos\/sarcousd\.png" alt="sArcoUSD"/)
  assert.match(detail, /<h1[^>]*>sArcoUSD<\/h1>/)

  // Portfolio holdings: the row's mark, name and balance.
  const holdings = renderToStaticMarkup(
    <GiwaHoldingsTable
      portfolio={{ walletAddress: "0xabc", chainId: 91342, positions: [{ productId: "arcousd", balance: "999.8", status: "Held" }], redemptions: [] } as unknown as GiwaPortfolio}
      products={[arcoUsd]}
    />,
  )
  assert.match(holdings, /src="\/logos\/sarcousd\.png"/)
  assert.match(holdings, />sArcoUSD</)
  assert.match(holdings, /999\.8 sArcoUSD/)
  assert.doesNotMatch(holdings, /arcoUSD|twimg/)

  // Activity: a deposit names and counts sArcoUSD.
  const [row] = buildActivityFeed(
    [{ txHash: "0x1", blockNumber: 1, eventName: "ProductDeposit", contractAddress: base.depositVaultAddress, blockTimestamp: "2026-10-18T00:00:00Z", args: { sharesOut: "2000000000000000000" } } as unknown as GiwaActivity],
    [],
    [arcoUsd],
  )
  assert.equal(row!.product.symbol, "sArcoUSD")
  assert.equal(row!.product.imageUrl, "/logos/sarcousd.png")
  assert.match(row!.amount, / sArcoUSD$/)

  // Every other token keeps its own symbol and the config-first image.
  const other = vault({ vaultImageUrl: "/logos/other.png" })
  assert.equal(tokenSymbolFor(other), "aCAPIX")
  assert.equal(vaultImageFor(other), "/logos/other.png")
})
