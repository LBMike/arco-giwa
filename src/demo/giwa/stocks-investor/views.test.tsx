import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { actionsFor } from "./actions"
import { createHarness, flush, WALLET_A } from "./fixtures/controller-harness"
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
  assert.match(unauthorized, /After signing in again, retry it unchanged or check your orders/)
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

// 003B: a host slot supplies the wallet steps. The card then points to them instead of saying they do not exist.
test("003B: with a host execution slot the accepted order card shows the slot and wallet-step copy for BUY and SELL", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const h = createHarness()
    if (side === "SELL") h.controls.setHolding(WALLET_A, "3000000000")
    await h.enter(WALLET_A)
    await h.quote("2.5", side)
    await h.controller.placeOrder()
    const seen: { id: string; state: string; refreshing: boolean }[] = []
    const html = renderToStaticMarkup(
      <GiwaStocksFeatureView
        state={h.controller.getState()}
        actions={actionsFor(h.controller)}
        tab="stocks"
        onTabChange={() => undefined}
        detailOpen
        onDetailChange={() => undefined}
        renderOrderExecution={({ order, refreshing }) => {
          seen.push({ id: order.id, state: order.state, refreshing })
          return <div data-testid="host-slot">host wallet steps</div>
        }}
      />,
    )
    const shown = text(html)
    const order = h.controller.getState().attempt?.order
    assert.ok(order)
    assert.deepEqual(seen, [{ id: order.id, state: side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW", refreshing: false }], `${side}: slot receives the displayed row`)
    assert.match(html, /data-testid="host-slot"/)
    assert.match(shown, side === "BUY" ? /Funding required This order is matched only by a depositForOrder call/ : /Escrow required This order is matched only by an escrowForOrder call/)
    assert.match(shown, side === "BUY" ? /The wallet steps below check this order and show any approval or deposit already requested for it; never send one again from another app or wallet\./ : /The wallet steps below check this order and show any approval or escrow already requested for it; never send one again from another app or wallet\./)
    assert.doesNotMatch(shown, /then deposit it|then escrow them/, "the card never tells a user to send the transfer: the panel knows whether one was already sent")
    assert.doesNotMatch(shown, /not available in this app yet|does not sign or send anything/)
    // Without a slot nothing changes.
    assert.match(text(render(h.controller, "stocks", true)), side === "BUY" ? /Funding required — not available in this app yet/ : /Escrow required — not available in this app yet/)
  }
})

// ── UI review 2026-09-19 (G2) ───────────────────────────────────────────

const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }

/** The sr-only polite status sentence of the trade panel. */
function liveText(html: string): string {
  const match = html.match(/data-testid="stocks-trade-status">([^<]*)<\/p>/)
  assert.ok(match, "trade status live region")
  return text(match[1]).trim()
}

/** Everything from the unresolved attempt block on (nothing else of the trade panel follows it). */
function attemptPart(html: string): string {
  const start = html.indexOf('data-testid="stocks-unconfirmed-attempt"')
  assert.ok(start >= 0, "unresolved attempt block")
  return html.slice(start)
}

function retryButton(html: string): string {
  const match = html.match(/<button[^>]*>Retry same request<\/button>/)
  assert.ok(match, "Retry same request button")
  return match[0]
}

test("I1: a 401'd order request stops asking to sign in once the same wallet is verified again; retry stays a manual click", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.revokeToken(h.tokenOf(WALLET_A) as string)
  await h.controller.placeOrder()
  assert.equal(h.controller.getState().attempt?.status, "AUTH_REQUIRED")
  assert.equal(h.controller.getState().attempt?.outcomeUnknown, false)

  // Session still rejected (authRejected): every sign-in string is kept and both buttons stay disabled.
  const rejected = render(h.controller, "stocks", true)
  const rejectedBlock = text(attemptPart(rejected))
  assert.match(rejectedBlock, /Sign in again to finish this order request/)
  assert.match(rejectedBlock, /The server did not accept the sign-in session, so this request was not processed\. After signing in again, retry it unchanged\./)
  assert.match(rejectedBlock, /The server did not accept this sign-in session\. Sign in again\./)
  assert.equal(liveText(rejected), "Sign in again to finish this order request.")
  assert.match(retryButton(rejected), /\sdisabled=""/)

  h.enterWith({ status: "signed-out" })
  await flush()
  assert.equal(h.controller.getState().attempt, null, "a signed-out view shows no attempt")
  h.enterWith(h.session(WALLET_A, true))
  await flush()
  const state = h.controller.getState()
  assert.equal(state.attempt?.status, "AUTH_REQUIRED", "the same request is kept for the same wallet")
  assert.equal(state.authRejected, false)

  const html = render(h.controller, "stocks", true)
  const shown = text(html)
  assert.doesNotMatch(shown, /Sign in again/, "no sign-in request once the session is verified again")
  assert.match(text(attemptPart(html)), /Order request not processed/)
  assert.match(text(attemptPart(html)), /The server did not accept the sign-in session, so this request was not processed\. After signing in again, retry it unchanged\./)
  assert.doesNotMatch(shown, /The server did not accept this sign-in session/)
  assert.equal(liveText(html), "Order request not processed. Retry it unchanged.")
  assert.doesNotMatch(retryButton(html), /\sdisabled=""|aria-disabled="true"/, "Retry same request is enabled")
  assert.equal(h.requests("POST", "/api/v1/stocks/orders").length, 1, "nothing is resent automatically")
  assert.equal(h.controls.orders().length, 0)
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "ACCEPTED", "the explicit retry sends the same request")
})

test("I1: an AUTH_REQUIRED retry whose earlier send is unknown is never called 'not processed' after signing in again", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  h.controls.dropNext("order")
  await h.controller.placeOrder()
  h.controls.revokeToken(h.tokenOf(WALLET_A) as string)
  await h.controller.retryOrder()
  assert.equal(h.controller.getState().attempt?.status, "AUTH_REQUIRED")
  assert.equal(h.controller.getState().attempt?.outcomeUnknown, true)
  assert.match(text(attemptPart(render(h.controller, "stocks", true))), /Sign in again to finish this order request/)

  h.enterWith(h.session(WALLET_A, true))
  await flush()
  const html = render(h.controller, "stocks", true)
  const block = text(attemptPart(html))
  assert.doesNotMatch(text(html), /Sign in again|Order request not processed/)
  assert.match(block, /Order result not confirmed/)
  assert.match(block, /This request may already have created the order\./)
  assert.match(block, /so this retry was not processed\. The earlier request may still have created the order\./)
  assert.equal(liveText(html), "Order result not confirmed.")
  assert.doesNotMatch(retryButton(html), /\sdisabled=""|aria-disabled="true"/)
  assert.equal(h.requests("POST", "/api/v1/stocks/orders").length, 2, "nothing is resent automatically")
})

test("I2: the accepted-order announcement uses the displayed status label, including a passed deadline", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  await h.controller.placeOrder()
  assert.equal(liveText(render(h.controller, "stocks", true)), "Order accepted. Status: Awaiting funding.")
  h.controls.advanceOrder(h.controller.getState().attempt?.order?.id as string, "MINT_UNKNOWN")
  await h.controller.refreshAttemptOrder()
  assert.equal(liveText(render(h.controller, "stocks", true)), "Order accepted. Status: Checking mint result.")

  const late = createHarness()
  await late.enter(WALLET_A)
  await late.quote("1")
  await late.controller.placeOrder()
  late.controls.advanceTime(3_600_000)
  await late.controller.refreshAttemptOrder()
  assert.equal(liveText(render(late.controller, "stocks", true)), "Order accepted. Status: Funding deadline passed.")
})

test("I5: an order refused because trading is paused or unavailable does not claim that no quote was created", async () => {
  for (const [code, expected] of [
    ["STOCKS_PAUSED", "Trading is paused. No order was created."],
    ["STOCKS_NOT_ACTIVATED", "Stocks trading is unavailable. No order was created."],
    ["VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT", "Stocks trading is unavailable. No order was created."],
  ] as const) {
    const h = createHarness()
    await h.enter(WALLET_A)
    await h.quote("1")
    if (code === "STOCKS_PAUSED") h.controls.setPaused(true)
    else h.controls.failNext("order", 503, { error: code, ...PROFILE })
    await h.controller.placeOrder()
    await flush() // a 503 refusal re-reads the catalog
    const attempt = h.controller.getState().attempt
    assert.equal(attempt?.status, "REJECTED", code)
    assert.equal(attempt?.outcomeUnknown, false)
    const html = render(h.controller, "stocks", true)
    assert.match(text(html), new RegExp(`Order not placed ${expected.replace(/\./g, "\\.")}`), code)
    assert.equal(liveText(html), `Order not placed. ${expected}`)
    assert.doesNotMatch(text(html), /No quote or order/, code)
  }
})

test("I5: quote refusals keep their quote-context wording", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  h.controls.setPaused(true)
  await h.quote("1")
  assert.match(text(render(h.controller, "stocks", true)), /Trading is paused\. No quote or order was created\./)
})

test("I6: the feature title is a section heading (h2) below the page's h1, same id and text", async () => {
  const h = createHarness()
  await h.enter(null)
  const html = render(h.controller, "stocks")
  assert.match(html, /<h2 id="giwa-stocks-title" class="text-2xl font-medium text-\[var\(--color-arco-ink\)\]">Stocks<\/h2>/)
  assert.doesNotMatch(html, /<h1\b/)
  assert.match(html, /aria-labelledby="giwa-stocks-title"/)
})
