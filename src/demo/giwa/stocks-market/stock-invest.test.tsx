import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StockMarketInvestPanel, stockDisplayEstimate, stockEstimateLabel } from "./StockMarketInvestPanel"
import { fixtureTop40Quote } from "./fixtures"

test("display estimates use exact decimal arithmetic, floor output precision and reject invalid or excessive amounts", () => {
  assert.equal(stockEstimateLabel("5.82648721"), "5.83")
  assert.equal(stockEstimateLabel("0.000000001"), "<0.01")
  assert.equal(stockEstimateLabel(null), "—")
  assert.equal(stockDisplayEstimate("1000", "171.63", false), "5.82648721")
  assert.equal(stockDisplayEstimate("2", "171.63", true), "343.26")
  for (const amount of ["", "-1", "1e9", "NaN", "1.0000001", "9".repeat(80)]) assert.equal(stockDisplayEstimate(amount, "171.63", false), null)
  assert.equal(stockDisplayEstimate("1", null, false), null)
  assert.equal(stockDisplayEstimate("1", "0", false), null)
  assert.equal(stockDisplayEstimate("999999999999999999999999", "0.000000000000000001", false), null)
})

test("selected stock uses the GIWA amount block with no NVDA fallback, fake balance, fee or executable order", () => {
  const html = renderToStaticMarkup(<StockMarketInvestPanel symbol="SOXL" quote={fixtureTop40Quote("SOXL")} access={{ wallet: "ready", host: "authenticated", hostError: null, canSignIn: false }} />)
  assert.match(html, /SOXL invest panel/)
  assert.match(html, /USDC amount to buy SOXL/)
  assert.match(html, /171\.63/)
  assert.match(html, /disabled=""[^>]*>Trading coming soon/)
  assert.doesNotMatch(html, /NVDA|조회 전용|모의|Place.*order/)
  const wrong = renderToStaticMarkup(<StockMarketInvestPanel symbol="SOXL" quote={fixtureTop40Quote("NVDA")} access={{ wallet: "disconnected", host: "signed-out", hostError: null, canSignIn: false }} />)
  assert.doesNotMatch(wrong, /231\.02/)
})
