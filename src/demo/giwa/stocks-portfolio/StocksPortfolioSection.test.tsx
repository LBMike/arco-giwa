import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StocksPortfolioPanel } from "./StocksPortfolioSection"

test("an unconfigured Portfolio section never invents a Stocks balance or asks for a signature", () => {
  const html = renderToStaticMarkup(<StocksPortfolioPanel client={null} session={{ status: "signed-out" }} />)
  assert.match(html, /Stocks API is not configured/)
  assert.doesNotMatch(html, /No Stocks holdings|0 NVDA|Sign in to Stocks|Place.*order/)
})
