import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProductDetailView } from "./ProductDetailPage"
import { GiwaWalletProvider } from "./wallet"
import { vaultConfigOf } from "./catalog"
import type { GiwaCatalogItem, GiwaVaultConfig } from "./types"

// The detail "More Info" section renders the GIWA Smart Contracts explorer links (always) plus
// each ENABLED docs link (shown === true AND a URL). Layout is adaptive: full-width Smart
// Contracts when zero docs are visible, a 2-col split when ≥1 is.

const base: GiwaCatalogItem = {
  productId: "beqty",
  symbol: "bEQTY",
  name: "Beta Equity",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: {
    symbol: "tUSDC",
    name: "Test USDC",
    decimals: 6,
    contract: { proxy: "0x00000000000000000000000000000000000000a1" },
    faucet: "0x00000000000000000000000000000000000000f1",
  },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x1111111111111111111111111111111111111111",
  depositVaultAddress: "0x2222222222222222222222222222222222222222",
  redemptionVaultAddress: "0x3333333333333333333333333333333333333333",
  priceFeedAddress: "0x4444444444444444444444444444444444444444",
} as unknown as GiwaCatalogItem

function cfg(overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return { ...vaultConfigOf({ vaultConfig: null }), ...overrides }
}
function vault(overrides: Partial<GiwaVaultConfig>): GiwaCatalogItem {
  return { ...base, vaultConfig: cfg(overrides) }
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

// Isolate the #more-info section so grid classes / card presence assertions don't catch other
// sections (the page has several grids).
function moreInfoSection(html: string): string {
  const start = html.indexOf('id="more-info"')
  assert.ok(start > -1, "more-info section is present")
  const end = html.indexOf("</section>", start) // no nested <section> inside more-info
  return html.slice(start, end === -1 ? undefined : end)
}

test("Smart Contracts uses the GIWA explorer (not etherscan) for the 4 deployed addresses", () => {
  const html = renderDetail(vault({}))
  assert.match(html, /sepolia-explorer\.giwa\.io\/address\/0x1111111111111111111111111111111111111111/)
  assert.match(html, /sepolia-explorer\.giwa\.io\/address\/0x4444444444444444444444444444444444444444/)
  assert.doesNotMatch(html, /etherscan\.io/)
})

test("0 visible docs → Smart Contracts fills full width (no md:grid-cols-2, no Docs/Links card)", () => {
  const section = moreInfoSection(renderDetail(vault({}))) // unconfigured → all URLs null
  assert.doesNotMatch(section, /md:grid-cols-2/) // single-column grid
  assert.doesNotMatch(section, /Docs \/ Links/) // DocsLinksCard omitted, not an empty shell
  assert.match(section, /Smart Contracts/)
})

test("≥1 visible docs link → 2-col split with the Docs/Links card", () => {
  const section = moreInfoSection(renderDetail(vault({ docsUrl: "https://docs.arco.fi/beqty", docsShown: true })))
  assert.match(section, /md:grid-cols-2/) // split layout
  assert.match(section, /Docs \/ Links/)
  assert.match(section, /Documentation/)
  assert.match(section, /https:\/\/docs\.arco\.fi\/beqty/)
})

test("a docs link is gated by BOTH the show toggle AND a non-empty URL", () => {
  // shown but no URL → hidden.
  const shownNoUrl = moreInfoSection(renderDetail(vault({ legalUrl: "", legalShown: true })))
  assert.doesNotMatch(shownNoUrl, /Docs \/ Links/)

  // URL set but toggled off → hidden.
  const urlHidden = moreInfoSection(renderDetail(vault({ risksUrl: "https://arco.fi/risks", risksShown: false })))
  assert.doesNotMatch(urlHidden, /Docs \/ Links/)
  assert.doesNotMatch(urlHidden, /arco\.fi\/risks/)

  // Only the enabled+valid slot renders; a sibling that's shown-but-empty does not.
  const mixed = moreInfoSection(
    renderDetail(vault({ docsUrl: "https://docs.arco.fi/x", docsShown: true, risksUrl: "", risksShown: true })),
  )
  assert.match(mixed, /Documentation/)
  assert.match(mixed, /https:\/\/docs\.arco\.fi\/x/)
  assert.doesNotMatch(mixed, /Risks/)
})

test("labels are verbatim Documentation / Legal Terms / Risks", () => {
  const section = moreInfoSection(
    renderDetail(
      vault({
        docsUrl: "https://a.io",
        docsShown: true,
        legalUrl: "https://b.io",
        legalShown: true,
        risksUrl: "https://c.io",
        risksShown: true,
      }),
    ),
  )
  for (const label of ["Documentation", "Legal Terms", "Risks"]) assert.match(section, new RegExp(label), label)
})
