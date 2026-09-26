import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { DemoPresentationContext } from "../demo-presentation"
import type { DirectTrade, DirectTradeState } from "../stocks-direct"
import type { GiwaStocksAccess } from "./access"
import { actionsFor } from "./actions"
import { directFailureMessage, directHeldMessage, directStep, DirectTradeView, type DirectStepInput } from "./DirectTrade"
import { createHarness, WALLET_A } from "./fixtures/controller-harness"
import { DIRECT_CONTRACTS } from "./fixtures/fake-stocks-server"
import { GiwaStocksFeatureView } from "./GiwaStocksFeature"
import type { StocksDirectStatus } from "./types"

const noop = () => undefined
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
const HASH = `0x${"77".repeat(32)}` as const
const KEY = `0x4152434f44524354${"0f".repeat(24)}` as const

const READY: DirectStepInput = {
  access: { wallet: "ready", host: "signed-out", hostError: null, canSignIn: true, signIn: noop },
  owner: WALLET_A, block: "SIGNED_OUT", side: "BUY", amount: "60000000", tooSmall: false, short: false, approvalNeeded: false,
  wallet: "ready", approval: "idle", cashSymbol: "USDC",
}

test("the direct trade asks for no sign-in: wallet → network → amount → approval → Buy or Sell", () => {
  const step = (patch: Partial<DirectStepInput>) => directStep({ ...READY, ...patch })
  const access = READY.access as GiwaStocksAccess
  assert.deepEqual(step({}), { kind: "trade", label: "Buy NVDA", hint: null }, "signed out is not a step")
  assert.deepEqual(step({ side: "SELL" }), { kind: "trade", label: "Sell NVDA", hint: null })
  assert.deepEqual(step({ access: { ...access, wallet: "disconnected" } }), { kind: "connect", label: "Connect wallet", hint: "Connect a wallet using the button at the top of the page." })
  assert.equal(step({ access: { ...access, wallet: "disconnected", connectWallet: noop } }).hint, null)
  assert.equal(step({ owner: null }).kind, "connect")
  assert.deepEqual(step({ access: { ...access, wallet: "wrong-network", switchNetwork: noop } }), { kind: "switch", label: "Switch to GIWA Sepolia", hint: null })
  assert.equal(step({ access: { ...access, wallet: "unavailable" } }).kind, "wallet-unavailable")
  for (const block of ["NO_CLIENT", "CATALOG_NOT_READY", "NOT_ACTIVATED"] as const) assert.deepEqual(step({ block }), { kind: "blocked", label: "Buy NVDA", hint: null })
  assert.equal(step({ block: "AUTH_REJECTED" }).kind, "trade", "a rejected session does not block a direct trade")
  assert.deepEqual(step({ amount: null }), { kind: "amount", label: "Buy NVDA", hint: null })
  assert.equal(step({ tooSmall: true }).kind, "too-small")
  assert.deepEqual(step({ approvalNeeded: null, wallet: "loading" }), { kind: "checking", label: "Checking your wallet…", hint: null })
  assert.equal(step({ approvalNeeded: null, wallet: "error" }).kind, "unreadable")
  assert.deepEqual(step({ short: true }), { kind: "short", label: "Not enough USDC", hint: null })
  assert.deepEqual(step({ side: "SELL", short: true }), { kind: "short", label: "Not enough NVDA", hint: null })
  assert.deepEqual(step({ approvalNeeded: true }), { kind: "approve", label: "Approve USDC", hint: null })
  assert.deepEqual(step({ side: "SELL", approvalNeeded: true }), { kind: "approve", label: "Approve NVDA", hint: null })
  assert.equal(step({ approvalNeeded: true, approval: "wallet" }).label, "Approve in your wallet…")
  assert.equal(step({ approvalNeeded: true, approval: "pending" }).label, "Confirming approval on GIWA…")
  assert.equal(step({ approvalNeeded: true, approval: "confirmed" }).label, "Confirming approval on GIWA…", "until the allowance reads back")
  assert.equal(step({ approvalNeeded: false, approval: "confirmed" }).kind, "trade")
})

test("with published contracts the customer panel is the direct one: no sign-in text, no quote step, one NVDA's price, fees only in the details", async () => {
  const h = createHarness()
  h.controls.setCatalogMode("direct")
  await h.enter(null)
  const access: GiwaStocksAccess = { wallet: "disconnected", host: "signed-out", hostError: null, canSignIn: false, connectWallet: noop }
  const html = renderToStaticMarkup(
    <DemoPresentationContext.Provider value>
      <GiwaStocksFeatureView state={h.controller.getState()} actions={actionsFor(h.controller)} tab="stocks" onTabChange={noop} detailOpen onDetailChange={noop} access={access} />
    </DemoPresentationContext.Provider>,
  )
  assert.match(html, /data-mode="direct"/)
  assert.doesNotMatch(text(html), /Sign in|sign-in|Get quote|Place buy order/i)
  assert.match(text(html), /Quote \? 1 NVDA = 120 USDC \(\$120\) Order details Connect wallet$/, "one NVDA's price at the price on screen, above the details")
  assert.match(text(html), /You pay .*You receive/)
  assert.match(text(html), /Order details Connect wallet$/, "the details hold the fees only (collapsed), then the one action")
  assert.doesNotMatch(text(html), /Side|Quantity|Order capability|Deployment/)
  // An older server (no contracts) keeps the session panel.
  const old = createHarness()
  await old.enter(null)
  const session = renderToStaticMarkup(
    <DemoPresentationContext.Provider value>
      <GiwaStocksFeatureView state={old.controller.getState()} actions={actionsFor(old.controller)} tab="stocks" onTabChange={noop} detailOpen onDetailChange={noop} access={access} />
    </DemoPresentationContext.Provider>,
  )
  assert.doesNotMatch(session, /data-mode="direct"/)
  // The technical preview never trades directly.
  const preview = renderToStaticMarkup(<GiwaStocksFeatureView state={h.controller.getState()} actions={actionsFor(h.controller)} tab="stocks" onTabChange={noop} detailOpen onDetailChange={noop} access={access} />)
  assert.doesNotMatch(preview, /data-mode="direct"/)
  assert.ok(DIRECT_CONTRACTS.cashToken)
})

const trade = (state: DirectTradeState, side: "BUY" | "SELL" = "BUY", estimate: string | null = side === "BUY" ? "500000000" : "30000000"): DirectTrade => ({
  id: 7, key: KEY, state,
  input: { side, owner: WALLET_A, contracts: DIRECT_CONTRACTS, amount: side === "BUY" ? "60000000" : "250000000", estimate },
})
const status = (patch: Partial<StocksDirectStatus>) => ({ side: "BUY", state: "BROKER_PENDING", quantity: "498000000", cashAmount: "60000000", hold: null, ...patch }) as StocksDirectStatus
const view = (value: DirectTrade) => text(renderToStaticMarkup(<DirectTradeView trade={value} onMore={noop} onCheckAgain={noop} />))

test("the trade's progress: wallet, GIWA confirmation, settlement, then the server's amounts", () => {
  assert.equal(view(trade({ phase: "WALLET" })), "Buying NVDA You pay 60 USDC You receive ≈0.5 NVDA Confirm the transaction in your wallet…")
  assert.match(view(trade({ phase: "CONFIRMING", hash: HASH })), /Waiting for GIWA to confirm your payment…/)
  assert.match(view(trade({ phase: "SETTLING", hash: HASH, status: null })), /You receive ≈0\.5 NVDA GIWA confirmed your payment\. Delivering NVDA…/)
  assert.match(view(trade({ phase: "SETTLING", hash: HASH, status: status({}) })), /You receive 0\.498 NVDA/, "the server's quantity once it has priced the payment")
  assert.equal(view(trade({ phase: "DONE", hash: HASH, status: status({ state: "COMPLETED" }) })), "Bought 0.498 NVDA You pay 60 USDC You received 0.498 NVDA 0.498 NVDA is in your wallet. Buy more")
  // Sell: the NVDA escrowed is exact, the payout is the estimate until the server's.
  assert.equal(view(trade({ phase: "WALLET" }, "SELL")), "Selling 0.25 NVDA You sell 0.25 NVDA You receive ≈30 USDC Confirm the transaction in your wallet…")
  assert.match(view(trade({ phase: "CONFIRMING", hash: HASH }, "SELL")), /Waiting for GIWA to confirm your escrow…/)
  assert.match(view(trade({ phase: "SETTLING", hash: HASH, status: status({ side: "SELL", state: "LIQUIDITY_PENDING", quantity: "250000000", cashAmount: "29990000" }) }, "SELL")), /You receive 29\.99 USDC Waiting for payout liquidity\. Your NVDA stays held until it is paid out\./)
  assert.equal(view(trade({ phase: "DONE", hash: HASH, status: status({ side: "SELL", state: "COMPLETED", quantity: "250000000", cashAmount: "29990000" }) }, "SELL")), "Sold 0.25 NVDA You sell 0.25 NVDA You received 29.99 USDC 29.99 USDC is in your wallet. Sell more")
})

test("held and slow trades say what happened and never claim a result", () => {
  const paused = view(trade({ phase: "HELD", hash: HASH, status: status({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", hold: "TRADING_PAUSED" }) }))
  assert.equal(paused, "Purchase held for review You pay 60 USDC Trading was paused when GIWA confirmed your payment, so it is held for review. Nothing was bought. Buy more")
  assert.match(directHeldMessage(status({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", hold: "PRICE_UNAVAILABLE" })), /No price could be read/)
  assert.match(directHeldMessage(status({ side: "SELL", state: "ESCROW_REVIEW_REQUIRED", hold: "BELOW_ONE_UNIT" })), /pays out less than 0\.000001 USDC/)
  assert.match(directHeldMessage(status({ state: "REVIEW_REQUIRED" })), /Operations must review this order/)
  assert.match(view(trade({ phase: "SLOW", hash: HASH, status: null, stage: "RECEIPT" })), /Your transaction was sent\. GIWA has not confirmed it yet\. Check again Start a new trade$/)
  assert.match(view(trade({ phase: "SLOW", hash: HASH, status: null, stage: "SETTLEMENT" }, "SELL")), /Settlement is taking longer than usual\. Check again Start a new trade$/)
  assert.equal(directFailureMessage("WALLET_REQUEST_REJECTED", "BUY"), "The payment was declined in your wallet. Nothing was sent.")
  assert.equal(directFailureMessage("REVERTED", "SELL"), "The escrow failed on GIWA, so nothing was escrowed. Check the wallet's test ETH for gas, then try again.")
  assert.match(directFailureMessage("NOT_ACCEPTED", "BUY"), /your wallet was not asked/)
  // The trading limits: said before the wallet is asked, or when a payment arrived anyway.
  assert.equal(directFailureMessage("SIDE_DISABLED", "BUY"), "Buying NVDA is paused for now, so your wallet was not asked. Nothing was sent.")
  assert.equal(directFailureMessage("SIDE_DISABLED", "SELL"), "Selling NVDA is paused for now, so your wallet was not asked. Nothing was sent.")
  assert.equal(directFailureMessage("DAILY_LIMIT_REACHED", "BUY"), "Today's NVDA buy limit has been reached. Try again after 00:00 KST. Nothing was sent.")
  assert.equal(directFailureMessage("DAILY_LIMIT_REACHED", "SELL"), "Today's NVDA sell limit has been reached. Try again after 00:00 KST. Nothing was sent.")
  assert.equal(directFailureMessage("TRADING_PAUSED", "SELL"), "Trading is paused right now, so your wallet was not asked. Nothing was sent.")
  assert.equal(directHeldMessage(status({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", hold: "SIDE_DISABLED" })), "Buying NVDA was paused when GIWA confirmed your payment, so it is held for review. Nothing was bought.")
  assert.equal(directHeldMessage(status({ side: "SELL", state: "ESCROW_REVIEW_REQUIRED", hold: "DAILY_LIMIT_REACHED" })), "Today's NVDA sell limit was reached when GIWA confirmed your escrow, so it is held for review. Nothing was sold.")
  assert.match(view(trade({ phase: "HELD", hash: HASH, status: status({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", hold: "DAILY_LIMIT_REACHED" }) })), /^Purchase held for review You pay 60 USDC Today's NVDA buy limit was reached when GIWA confirmed your payment/)
})
