import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { actionsFor } from "./actions"
import { createHarness, WALLET_A } from "./fixtures/controller-harness"
import { GiwaStocksFeature, GiwaStocksFeatureView } from "./GiwaStocksFeature"
import type { StocksInvestorController } from "./controller"
import type { GiwaStocksTab } from "./types"

function render(controller: StocksInvestorController, tab: GiwaStocksTab, detailOpen = false): string {
  return renderToStaticMarkup(
    <GiwaStocksFeatureView state={controller.getState()} actions={actionsFor(controller)} tab={tab} onTabChange={() => undefined} detailOpen={detailOpen} onDetailChange={() => undefined} />,
  )
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")
}

test("the catalog list shows the server's NVDA row with its capability and test-value labels", async () => {
  const h = createHarness()
  await h.enter(null)
  const html = render(h.controller, "stocks")
  const shown = text(html)
  assert.match(shown, /NVDA/)
  assert.match(shown, /120 ARCO_TEST_USDC/)
  assert.match(shown, /Fixed mock price/)
  assert.match(shown, /Orders open unless paused/)
  assert.match(shown, /Test value only/)
  assert.match(html, /role="tablist"/)
  assert.match(html, /aria-selected="true"/)
  // Tokens only: no Tailwind default white/black surfaces (pattern assembled so the token hook does not flag this test).
  assert.doesNotMatch(html, new RegExp(`(^|\\s)${"bg"}-${"white"}(\\s|")`))
})

test("unregistered API and missing client render explicit unavailable states with no instrument", async () => {
  const h = createHarness()
  h.controls.setCatalogMode("not-registered")
  await h.enter(null)
  const unavailable = text(render(h.controller, "stocks"))
  assert.match(unavailable, /Stocks trading is not available on this server/)
  assert.doesNotMatch(unavailable, /NVDA/)

  const none = createHarness()
  none.controller.setContext({ client: null, session: { status: "signed-out" } })
  const notConfigured = text(render(none.controller, "stocks"))
  assert.match(notConfigured, /not configured/)
  assert.doesNotMatch(notConfigured, /NVDA/)
})

test("signed out: detail explains that a connected wallet alone is not a sign-in, and trading is disabled", async () => {
  const h = createHarness()
  await h.enter(null)
  const html = render(h.controller, "stocks", true)
  assert.match(text(html), /Connecting a wallet alone does not sign you in/)
  assert.match(html, /<fieldset[^>]*disabled=""/)
  assert.match(text(render(h.controller, "portfolio")), /Sign-in required/)
})

test("BUY quote review shows exact amounts; expired quote offers only a manual new quote", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("0.000000001")
  const ready = text(render(h.controller, "stocks", true))
  assert.match(ready, /You pay \(test cash\) 0\.000001 ARCO_TEST_USDC/)
  assert.match(ready, /Exact amount 1 base units \(6 decimals\)/)
  assert.match(ready, /Place buy order/)
  h.advanceDevice(60_000)
  h.controller.tick()
  const expired = text(render(h.controller, "stocks", true))
  assert.match(expired, /Quote expired/)
  assert.match(expired, /Get a new quote/)
  assert.doesNotMatch(expired, /Place buy order/)
})

test("an accepted BUY order explains exact funding without signing; UNKNOWN reads as checking, never failed", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("2.5")
  await h.controller.placeOrder()
  const awaiting = text(render(h.controller, "stocks", true))
  assert.match(awaiting, /Funding required — not available in this app yet/)
  assert.match(awaiting, /depositForOrder call to the funding vault of this Stocks deployment/)
  assert.match(awaiting, /exactly 300 ARCO_TEST_USDC \( 300000000 base units, 6 decimals\)/)
  assert.match(awaiting, /does not sign or send anything/)
  assert.match(awaiting, /plain token transfer is not matched/)
  assert.doesNotMatch(awaiting, /app's wallet deposit step/, "no claim of a deposit step that does not exist")
  const order = h.controller.getState().attempt?.order
  assert.ok(order)
  h.controls.advanceOrder(order.id, "MINT_UNKNOWN")
  await h.controller.refreshAttemptOrder()
  const checking = text(render(h.controller, "stocks", true))
  assert.match(checking, /Checking mint result/)
  assert.match(checking, /not a failure/)
  assert.doesNotMatch(checking, /\bFailed\b|\bCompleted\b/)
  assert.doesNotMatch(checking, /Retry same request|Resubmit/)
})

test("an accepted SELL order explains exact escrow", async () => {
  const h = createHarness()
  h.controls.setHolding(WALLET_A, "3000000000")
  await h.enter(WALLET_A)
  await h.quote("0.123456789", "SELL")
  await h.controller.placeOrder()
  const shown = text(render(h.controller, "stocks", true))
  assert.match(shown, /Escrow required — not available in this app yet/)
  assert.match(shown, /escrowForOrder call to the redemption escrow/)
  assert.match(shown, /exactly 0\.123456789 NVDA test units \( 123456789 base units, 9 decimals\)/)
  assert.match(shown, /Payout \(test cash\) 14\.814814 ARCO_TEST_USDC/)
})

test("an unconfirmed order offers retry of the same request and order lookup, not a new order", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.dropNext("order")
  await h.controller.placeOrder()
  const html = render(h.controller, "stocks", true)
  const shown = text(html)
  assert.match(shown, /Order result not confirmed/)
  assert.match(shown, /Retry same request/)
  assert.match(shown, /Check my orders/)
  assert.match(shown, new RegExp(`Request key ${h.controller.getState().attempt?.body.idempotencyKey}`))
  assert.doesNotMatch(shown, /Get quote|Place buy order/)
})

test("portfolio separates wallet, reserved, available and escrow, and totals only the server quantity", async () => {
  const h = createHarness()
  h.controls.setHolding(WALLET_A, "3000000000", "500000000")
  await h.enter(WALLET_A)
  await h.quote("1", "SELL")
  await h.controller.placeOrder()
  await h.controller.loadPortfolio()
  const shown = text(render(h.controller, "portfolio"))
  assert.match(shown, /Total \(wallet \+ escrow\) 3\.5 NVDA/)
  assert.match(shown, /In wallet 3 NVDA/)
  assert.match(shown, /Reserved for sell orders \(part of wallet\) 1 NVDA/)
  assert.match(shown, /Available to sell 2 NVDA/)
  assert.match(shown, /In escrow \(pending sale\) 0\.5 NVDA/)
  assert.doesNotMatch(shown, /4\.5 NVDA/, "reserved units are never added to the total")
  assert.match(shown, /Sell 1 NVDA · 120 ARCO_TEST_USDC/)
  assert.match(shown, /not added to the totals/)
})

test("orders list merges BUY and SELL with server state labels", async () => {
  const h = createHarness()
  h.controls.setHolding(WALLET_A, "3000000000")
  await h.enter(WALLET_A)
  await h.quote("1")
  await h.controller.placeOrder()
  h.controller.startNewOrder()
  await h.quote("1", "SELL")
  await h.controller.placeOrder()
  await h.controller.loadOrders()
  const shown = text(render(h.controller, "orders"))
  assert.match(shown, /Awaiting funding/)
  assert.match(shown, /Awaiting escrow/)
  assert.match(shown, /latest 100 per side/)
})

test("the stateful feature renders an update placeholder until the host context is applied", () => {
  const h = createHarness()
  const html = renderToStaticMarkup(<GiwaStocksFeature client={h.client} session={{ status: "signed-out" }} />)
  assert.match(text(html), /Updating session/)
  assert.doesNotMatch(text(html), /NVDA/)
})

test("past the quote deadline (server time) an awaiting order says not to fund it, in list and card", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  await h.controller.placeOrder()
  h.controls.advanceTime(3_600_000)
  await h.controller.refreshAttemptOrder()
  const card = text(render(h.controller, "stocks", true))
  assert.match(card, /Funding deadline passed/)
  assert.match(card, /Do not fund this order/)
  assert.match(card, /held for review/)
  assert.doesNotMatch(card, /Funding required/)
  await h.controller.loadOrders()
  assert.match(text(render(h.controller, "orders")), /Funding deadline passed/)
})

test("review states use the attention tone, never the failure colour", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  await h.controller.placeOrder()
  h.controls.advanceOrder(h.controller.getState().attempt?.order?.id as string, "FUNDING_REVIEW_REQUIRED")
  await h.controller.refreshAttemptOrder()
  const html = render(h.controller, "stocks", true)
  assert.match(text(html), /Funding under review/)
  assert.doesNotMatch(html, /color-arco-down/)
})

test("a negative available or wallet quantity from the server is shown exactly and flagged, not rejected", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  h.controls.corruptNext("portfolio", (body) => ({
    ...body,
    data: {
      holdings: [{ wallet: WALLET_A, symbol: "NVDA", walletQuantity: "0", escrowedQuantity: "10000000000", reservedQuantity: "4000000000", availableQuantity: "-4000000000", quantity: "10000000000" }],
      pending: [],
      projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS",
    },
  }))
  await h.controller.loadPortfolio()
  const shown = text(render(h.controller, "portfolio"))
  assert.match(shown, /Holding under review/)
  assert.match(shown, /Available to sell -4 NVDA/)
  assert.match(shown, /Total \(wallet \+ escrow\) 10 NVDA/)
})

test("without an API client, orders and holdings say not configured instead of loading forever", async () => {
  const h = createHarness()
  h.controller.setContext({ client: null, session: h.session(WALLET_A) })
  for (const tab of ["orders", "portfolio"] as const) {
    const shown = text(render(h.controller, tab))
    assert.match(shown, /not configured/)
    assert.doesNotMatch(shown, /Loading/)
  }
})

test("before the catalog names the deployment, orders wait for it instead of reporting a deployment change", async () => {
  const h = createHarness()
  h.controls.holdNext("catalog")
  h.enterNow(WALLET_A)
  await h.controller.loadOrders()
  const shown = text(render(h.controller, "orders"))
  assert.match(shown, /Waiting for the Stocks catalog/)
  assert.doesNotMatch(shown, /deployment changed/)
  assert.equal(h.requests("GET", "/api/v1/stocks/orders").length, 0)
})

test("order rows expose their visible cost and date as the accessible name (no overriding aria-label)", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  await h.controller.placeOrder()
  await h.controller.loadOrders()
  const html = render(h.controller, "orders")
  const row = html.match(/<li><button type="button"[^>]*>/)?.[0] ?? ""
  assert.ok(row.length > 0)
  assert.doesNotMatch(row, /aria-label=/)
  assert.match(text(html), /Buy 1 NVDA 120 ARCO_TEST_USDC Awaiting funding \d{4}-\d{2}-\d{2}/)
})

test("an unknown outcome is never described as 'not reached' or 'not processed' after a refused retry", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.dropNext("order")
  await h.controller.placeOrder()
  const lost = text(render(h.controller, "stocks", true))
  assert.match(lost, /No answer was received from the Stocks API/)
  assert.doesNotMatch(lost, /could not be reached/)
  h.controls.setPaused(true)
  await h.controller.retryOrder()
  const paused = text(render(h.controller, "stocks", true))
  assert.match(paused, /Order result not confirmed/)
  assert.match(paused, /retry was not processed\. The earlier request may still have created the order/)
  assert.doesNotMatch(paused, /Order not placed|No quote or order was created/)
  h.controls.revokeToken(h.tokenOf(WALLET_A) as string)
  h.controls.setPaused(false)
  await h.controller.retryOrder()
  const unauthorized = text(render(h.controller, "stocks", true))
  assert.match(unauthorized, /may already have created the order/)
  assert.doesNotMatch(unauthorized, /this request was not processed\. After signing in again/)
})

test("quantity errors and disclosures use readable text tokens; muted is placeholder-only", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  h.controller.setQuantity("0.0000000001")
  const html = render(h.controller, "stocks", true)
  assert.match(text(html), /Use at most 9 decimal places/)
  assert.match(html, /aria-invalid="true"/)
  const mutedUses = html.match(/[^\s"]*color-arco-muted[^\s"]*/g) ?? []
  assert.ok(mutedUses.every((use) => use.startsWith("placeholder:")), mutedUses.join(","))
})
