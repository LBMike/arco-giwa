import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { tokenIcon } from "../data/products"
import { buildActivityFeed } from "./activity-feed"
import { GiwaActivityTable } from "./components"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption } from "./types"

// Minimal catalog item with just the fields the resolver reads.
function product(over: Partial<GiwaCatalogItem> = {}): GiwaCatalogItem {
  return {
    productId: "beqty",
    symbol: "bEQTY",
    depositVaultAddress: "0xdep",
    redemptionVaultAddress: "0xred",
    productTokenAddress: "0xtok",
    vaultConfig: null,
    ...over,
  } as unknown as GiwaCatalogItem
}
const ev = (over: Partial<GiwaActivity> & { eventName: string }): GiwaActivity => ({
  txHash: "0x0",
  blockNumber: 1,
  args: {},
  ...over,
})
const red = (over: Partial<GiwaRedemption> & { requestId: string; status: string }): GiwaRedemption =>
  ({ productId: "beqty", walletAddress: "0xabc", redemptionVaultAddress: "0xred", sharesIn: "0", lockedAssetsOut: "0", ...over }) as GiwaRedemption

test("Date is a full UTC datetime YYYY-MM-DD HH:MM:SS; unknown timestamp → em dash", () => {
  const iso = "2026-07-11T12:33:12.000Z"
  const [r] = buildActivityFeed([ev({ eventName: "ProductDeposit", contractAddress: "0xdep", blockTimestamp: iso, args: { sharesOut: "1000000000000000000" } })], [], [product()])
  assert.equal(r.date, "2026-07-11 12:33:12")
  assert.equal(r.sortTs, new Date(iso).getTime())

  // Un-backfilled event (no blockTimestamp) → "—" and sinks to the bottom (sortTs 0).
  const [u] = buildActivityFeed([ev({ eventName: "ProductDeposit", contractAddress: "0xdep", blockTimestamp: null })], [], [product()])
  assert.equal(u.date, "—")
  assert.equal(u.sortTs, 0)
})

test("Product resolves config-first (displayName + vaultImageUrl), else legacy symbol + icon", () => {
  const configured = product({
    productId: "beqty",
    symbol: "bEQTY",
    depositVaultAddress: "0xDEP",
    vaultConfig: { displayName: "bEQTY Equity", vaultImageUrl: "/logos/beqty.png" } as never,
  })
  const [r] = buildActivityFeed([ev({ eventName: "ProductDeposit", contractAddress: "0xdep", blockTimestamp: "2026-07-05T00:00:00Z" })], [], [configured])
  assert.equal(r.product.name, "bEQTY Equity") // admin displayName
  assert.equal(r.product.imageUrl, "/logos/beqty.png") // admin vaultImageUrl

  const builtin = product({ productId: "acapix", symbol: "aCAPIX", depositVaultAddress: "0xDEP2", vaultConfig: null })
  const [b] = buildActivityFeed([ev({ eventName: "ProductDeposit", contractAddress: "0xdep2", blockTimestamp: "2026-07-05T00:00:00Z" })], [], [builtin])
  assert.equal(b.product.name, "aCAPIX") // falls back to symbol
  assert.equal(b.product.imageUrl, tokenIcon("acapix")) // legacy per-product icon
})

test("the 4 type labels map by kind/status; request + other events are excluded (no double-appearance)", () => {
  const feed = buildActivityFeed(
    [
      ev({ eventName: "ProductDeposit", txHash: "0xd", contractAddress: "0xdep", blockTimestamp: "2026-07-05T00:00:00Z", args: { sharesOut: "1000000000000000000" } }),
      ev({ eventName: "ProductRedeemInstant", txHash: "0xi", contractAddress: "0xred", blockTimestamp: "2026-07-04T00:00:00Z", args: { sharesIn: "2000000000000000000" } }),
      ev({ eventName: "ProductRedeemRequested", txHash: "0xr", contractAddress: "0xred", blockTimestamp: "2026-07-03T00:00:00Z", args: { sharesIn: "3000000000000000000", requestId: "1" } }),
      ev({ eventName: "FaucetDrip", txHash: "0xf", contractAddress: "0xfaucet", blockTimestamp: "2026-07-02T00:00:00Z", args: { amount: "9000000000000000000" } }),
      ev({ eventName: "PriceUpdated", txHash: "0xp", contractAddress: "0xfeed", blockTimestamp: "2026-07-02T00:00:00Z" }),
    ],
    [
      red({ requestId: "9", status: "REQUESTED", sharesIn: "5000000000000000000", createdAt: "2026-07-06T00:00:00Z" }),
      red({ requestId: "8", status: "SETTLING", sharesIn: "6000000000000000000", createdAt: "2026-07-01T00:00:00Z" }),
      red({ requestId: "7", status: "SETTLED", sharesIn: "7000000000000000000", createdAt: "2026-06-30T00:00:00Z", settledAt: "2026-07-07T00:00:00Z" }),
    ],
    [product()],
  )
  // 2 kept events (deposit + instant) + 3 redemptions = 5; ProductRedeemRequested, FaucetDrip, PriceUpdated dropped.
  assert.equal(feed.length, 5)
  const count = (label: string) => feed.filter((r) => r.typeLabel === label).length
  assert.equal(count("Deposit"), 1) // deposit event
  assert.equal(count("Redemption request"), 1) // REQUESTED
  assert.equal(count("Pending"), 1) // SETTLING
  assert.equal(count("Redemption complete"), 2) // instant redeem + SETTLED
})

test("Amount is a human token count, not raw wei", () => {
  const [r] = buildActivityFeed([ev({ eventName: "ProductDeposit", contractAddress: "0xdep", blockTimestamp: "2026-07-05T00:00:00Z", args: { sharesOut: "1500000000000000000" } })], [], [product({ symbol: "bEQTY" })])
  assert.equal(r.amount, "1.5 bEQTY") // 1.5e18 base units → 1.5 shares
})

test("a REQUESTED redemption appears as a 'Redemption request' row with a human amount", () => {
  const feed = buildActivityFeed([], [red({ requestId: "1", status: "REQUESTED", sharesIn: "1000000000000000000", createdAt: "2026-07-05T00:00:00Z" })], [product()])
  assert.equal(feed.length, 1)
  assert.equal(feed[0].typeLabel, "Redemption request")
  assert.equal(feed[0].kind, "request")
  assert.equal(feed[0].amount, "1 bEQTY")
})

test("feed is ordered newest first", () => {
  const feed = buildActivityFeed(
    [ev({ eventName: "ProductDeposit", contractAddress: "0xdep", blockTimestamp: "2026-01-01T00:00:00Z" })],
    [red({ requestId: "1", status: "REQUESTED", createdAt: "2026-12-01T00:00:00Z" })],
    [product()],
  )
  assert.equal(feed[0].typeLabel, "Redemption request") // Dec 2026
  assert.equal(feed[1].typeLabel, "Deposit") // Jan 2026
})

// ── Render test: the table MUST consume buildActivityFeed output, never raw events ─────────
// Guards the wiring: if GiwaActivityTable is ever pointed back at raw EvmIndexedEvent rows,
// raw event names / wei amounts / block numbers / FaucetDrip rows reappear and this fails.
test("GiwaActivityTable renders the built feed — no raw event names, wei amounts, block numbers, or FaucetDrip", () => {
  const hash = (c: string) => `0x${c.repeat(64)}`
  const events = [
    ev({ eventName: "ProductDeposit", txHash: hash("a"), blockNumber: 123456, contractAddress: "0xdep", blockTimestamp: "2026-07-11T12:33:12Z", args: { sharesOut: "1000000000000000000" } }),
    ev({ eventName: "FaucetDrip", txHash: hash("b"), blockNumber: 999111, contractAddress: "0xfaucet", blockTimestamp: "2026-07-10T00:00:00Z", args: { amount: "5000000000000000000" } }),
    ev({ eventName: "ProductRedeemRequested", txHash: hash("c"), blockNumber: 777222, contractAddress: "0xred", blockTimestamp: "2026-07-09T00:00:00Z", args: { sharesIn: "3000000000000000000" } }),
  ]
  const redemptions = [
    red({ requestId: "1", status: "REQUESTED", sharesIn: "2000000000000000000", createdAt: "2026-07-12T01:02:03Z", requestedTxHash: hash("d") }),
  ]
  const configured = product({ vaultConfig: { displayName: "Beta Equity", vaultImageUrl: "/logos/beqty.png" } as never })
  const html = renderToStaticMarkup(<GiwaActivityTable rows={buildActivityFeed(events, redemptions, [configured])} />)

  // Header order: Date · Product · Type · Amount · TxID · Network
  for (const label of ["Date", "Product", "Type", "Amount", "TxID", "Network"]) assert.match(html, new RegExp(label))
  assert.doesNotMatch(html, /Block/) // the Block column is gone

  // Human, resolved values.
  assert.match(html, /2026-07-11 12:33:12/) // full datetime, not "Jul 11, 2026"
  assert.match(html, /2026-07-12 01:02:03/)
  assert.match(html, /Deposit/)
  assert.match(html, /Redemption request/) // REQUESTED redemption surfaces
  assert.match(html, /1 bEQTY/) // human amount (deposit)
  assert.match(html, /2 bEQTY/) // human amount (request)
  assert.match(html, /Beta Equity/) // config-first vault name
  assert.match(html, /\/logos\/beqty\.png/) // config-first vault logo

  // No raw data may leak through.
  assert.doesNotMatch(html, /FaucetDrip/) // excluded event kind
  assert.doesNotMatch(html, /ProductDeposit/) // raw event name
  assert.doesNotMatch(html, /ProductRedeemRequested/) // raw event name (and no double-appearance)
  assert.doesNotMatch(html, /1000000000000000000/) // raw wei
  assert.doesNotMatch(html, /5000000000000000000/)
  assert.doesNotMatch(html, /123456/) // block number
  assert.doesNotMatch(html, /999111/)
  assert.doesNotMatch(html, /GIWA Event/) // generic fallback product label
})

// ── Stocks trades (GET /api/v1/stocks/activity/:wallet) ──
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`
const trade = (over: Record<string, unknown> = {}) =>
  ({ side: "BUY", state: "COMPLETED", quantity: "498000000", cashAmount: "60000000", paymentTx: TX(1), settlementTx: TX(2), createdAt: "2026-09-26T01:02:03.000Z", ...over }) as never

test("a Stocks trade is one row: NVDA, Buy or Sell by the server's state, both amounts, dated and linked to the wallet's own transaction", () => {
  const [row] = buildActivityFeed([], [], [], [trade()])
  assert.equal(row!.product.name, "NVIDIA Corporation")
  assert.equal(row!.product.symbol, "NVDA")
  assert.equal(row!.product.category, "Stocks")
  assert.equal(row!.typeLabel, "Buy")
  assert.equal(row!.amount, "0.498 NVDA · 60 USDC")
  assert.equal(row!.date, "2026-09-26 01:02:03")
  assert.equal(row!.txHash, TX(1), "the payment the wallet sent, not the platform's mint")
  const label = (over: Record<string, unknown>) => buildActivityFeed([], [], [], [trade(over)])[0]!.typeLabel
  assert.equal(label({ side: "SELL" }), "Sell")
  const tone = (over: Record<string, unknown>) => buildActivityFeed([], [], [], [trade(over)])[0]!.typeTone
  assert.equal(tone({ side: "SELL" }), "text-[var(--color-arco-down)]", "a completed sell reads red")
  assert.equal(tone({}), "text-[var(--color-arco-up)]", "a completed buy keeps the complete green")
  assert.equal(label({ state: "MINT_SUBMITTED" }), "Buy processing")
  assert.equal(label({ side: "SELL", state: "LIQUIDITY_PENDING" }), "Sell processing")
  assert.equal(label({ state: "FUNDING_REVIEW_REQUIRED" }), "Held for review")
  assert.equal(label({ state: "REFUNDED" }), "Buy refunded")
  assert.equal(label({ side: "SELL", state: "RETURNED" }), "Sell returned")
  // A payment held without an order has no NVDA amount; an escrow held without one has no cash amount.
  assert.equal(buildActivityFeed([], [], [], [trade({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", cashAmount: "5000000" })])[0]!.amount, "5 USDC")
  assert.equal(buildActivityFeed([], [], [], [trade({ side: "SELL", state: "ESCROW_REVIEW_REQUIRED", quantity: "100000000", cashAmount: "0" })])[0]!.amount, "0.1 NVDA")
})

test("Stocks trades merge into the one feed by time, and render in the Activity table with their explorer link", () => {
  const rows = buildActivityFeed(
    [ev({ eventName: "ProductDeposit", txHash: "0xdeposit", contractAddress: "0xdep", blockTimestamp: "2026-09-26T00:00:00.000Z", args: { sharesOut: "1000000000000000000" } })],
    [],
    [product()],
    [trade(), trade({ side: "SELL", paymentTx: TX(3), createdAt: "2026-09-25T00:00:00.000Z" })],
  )
  assert.deepEqual(rows.map((row) => row.typeLabel), ["Buy", "Deposit", "Sell"])
  const html = renderToStaticMarkup(<GiwaActivityTable rows={rows} />)
  assert.match(html, /NVIDIA Corporation/)
  assert.match(html, /0\.498 NVDA · 60 USDC/)
  assert.ok(html.includes(`/tx/${TX(1)}`), "linked to the payment transaction on the explorer")
  assert.doesNotMatch(html, /No indexed activity yet/)
})
