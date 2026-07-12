import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaHoldingsTable, type HoldingPriceCell } from "./components"
import type { GiwaCatalogItem, GiwaPortfolio } from "./types"

// Personal-portfolio holdings table: the Price/24hΔ column sits between Balance and Your Deposit,
// renders "<sharePrice> (<±Δ%>)", and colours the delta with the dedicated CSS-var tokens
// (--color-arco-delta-up / --color-arco-delta-down) — never a raw hex.

const vault = (productId: string, symbol: string): GiwaCatalogItem =>
  ({ productId, symbol, vaultConfig: null }) as unknown as GiwaCatalogItem

const portfolio = {
  walletAddress: "0xabc",
  chainId: 91342,
  positions: [
    { productId: "up", balance: "10", status: "Held" },
    { productId: "down", balance: "5", status: "Held" },
    { productId: "none", balance: "1", status: "Held" },
  ],
  redemptions: [],
} as unknown as GiwaPortfolio

const products = [vault("up", "aUP"), vault("down", "aDOWN"), vault("none", "aNONE")]

// Index-aligned with positions: an up row, a down row, and a vault with no price history.
const priceCells: HoldingPriceCell[] = [
  { price: "1.0013", deltaText: "+0.04%", up: true },
  { price: "0.9821", deltaText: "-0.5%", up: false },
  null,
]

function render(): string {
  return renderToStaticMarkup(
    <GiwaHoldingsTable
      portfolio={portfolio}
      products={products}
      depositUsd={["$100.00", "$50.00", null]}
      apyValues={["5%", "2%", null]}
      priceCells={priceCells}
      sortKey="deposit"
      sortDir="desc"
      onSort={() => undefined}
    />,
  )
}

test("column order is Product · Balance · Price/24hΔ · Your Deposit · APY · Network", () => {
  const html = render()
  const at = (s: string) => html.indexOf(s)
  assert.ok(at("Product") < at("Balance"), "Product before Balance")
  assert.ok(at("Balance") < at("Price/24h"), "Balance stays left of Price/24hΔ")
  assert.ok(at("Price/24h") < at("Your Deposit"), "Price/24hΔ sits before Your Deposit")
  assert.ok(at("Your Deposit") < at("APY"), "Your Deposit before APY")
  assert.ok(at("APY") < at("Network"), "APY before Network")
})

test("renders '<sharePrice> (<±Δ%>)' with the up/down delta tokens; no history → em dash", () => {
  const html = render()
  assert.match(html, /1\.0013/) // share price (2–4 dp)
  assert.match(html, /\(\+0\.04%\)/) // signed up delta
  assert.match(html, /0\.9821/)
  assert.match(html, /\(-0\.5%\)/) // signed down delta
  // Up row uses the up token, down row the down token.
  assert.match(html, /text-\[var\(--color-arco-delta-up\)\][\s\S]*\+0\.04%/)
  assert.match(html, /text-\[var\(--color-arco-delta-down\)\][\s\S]*-0\.5%/)
  // The third holding has no price history → the cell is an em dash.
  assert.match(html, /—/)
})

test("delta colours are CSS-var tokens only — no raw hex reaches the rendered component", () => {
  const html = render()
  assert.doesNotMatch(html, /#3ce3ab/i) // design-tokens:allow — asserting the hex is ABSENT
  assert.doesNotMatch(html, /#f23674/i) // design-tokens:allow — hex lives only in theme.css
})

test("the Price/24hΔ header is a sortable button on the 'delta' key", () => {
  const html = renderToStaticMarkup(
    <GiwaHoldingsTable
      portfolio={portfolio}
      products={products}
      priceCells={priceCells}
      sortKey="delta"
      sortDir="desc"
      onSort={() => undefined}
    />,
  )
  assert.match(html, /<button[^>]*>[\s\S]*Price\/24h/) // rendered as a sort button, not a plain span
})
