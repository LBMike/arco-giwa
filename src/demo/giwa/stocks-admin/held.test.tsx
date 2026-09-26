import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HELD_INITIAL, heldPath, heldReducer, parseHeldPage, type HeldPage, type HeldState } from "./held"
import { HeldPaymentsView } from "./HeldPaymentsPanel"
import { StocksContractError } from "./parse"

const TX = (n: number) => `0x${String(n).padStart(64, "0")}`
const buy = {
  id: "funding-1", side: "BUY", wallet: "0x00000000000000000000000000000000000000b1", cashAmount: "12500000", quantity: null,
  txHash: TX(1), hold: "TRADING_PAUSED", reason: "UNIDENTIFIED_ORDER", status: "SUSPENSE", createdAt: "2026-09-25T10:00:00.000Z",
}
const sell = {
  id: "custody-2", side: "SELL", wallet: "0x00000000000000000000000000000000000000b2", cashAmount: null, quantity: "500000000",
  txHash: TX(2), hold: "BELOW_ONE_UNIT", reason: "UNIDENTIFIED_ORDER", status: "HELD", createdAt: "2026-09-25T09:00:00.000Z",
}
const plain = { ...buy, id: "funding-3", hold: null, reason: "UNATTRIBUTED_TRANSFER", txHash: TX(3), createdAt: "2026-09-25T08:00:00.000Z" }
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ")
const noop = () => {}
const ready = (page: HeldPage): HeldState => heldReducer(heldReducer(HELD_INITIAL, { type: "start", append: false }), { type: "loaded", page, append: false, at: Date.UTC(2026, 8, 25, 11) })

test("held path: page size and the opaque cursor only", () => {
  assert.equal(heldPath(null), "/api/v1/admin/stocks/held?limit=50")
  assert.equal(heldPath("abc_DEF-1", 10), "/api/v1/admin/stocks/held?limit=10&cursor=abc_DEF-1")
})

test("held page: strict contract; a single bad row rejects the whole page", () => {
  assert.deepEqual(parseHeldPage({ items: [buy, sell], nextCursor: "next_1" }), { items: [buy, sell], nextCursor: "next_1" })
  assert.deepEqual(parseHeldPage({ items: [], nextCursor: null }), { items: [], nextCursor: null })
  // The trading limits add two holds.
  for (const hold of ["SIDE_DISABLED", "DAILY_LIMIT_REACHED"]) assert.equal(parseHeldPage({ items: [{ ...buy, hold }], nextCursor: null }).items[0].hold, hold)
  for (const data of [
    null, [], {}, { items: {}, nextCursor: null }, { items: [], nextCursor: "has space" },
    { items: [{ ...buy, side: "HOLD" }], nextCursor: null }, { items: [{ ...buy, cashAmount: "1.5" }], nextCursor: null },
    { items: [{ ...buy, quantity: "1" }], nextCursor: null }, { items: [{ ...sell, cashAmount: "1" }], nextCursor: null },
    { items: [{ ...buy, hold: "SOMETHING" }], nextCursor: null }, { items: [{ ...buy, txHash: "0x1" }], nextCursor: null },
    { items: [{ ...buy, wallet: "0x123" }], nextCursor: null }, { items: [{ ...buy, createdAt: "yesterday" }], nextCursor: null },
    { items: [{ ...buy, reason: "lowercase" }], nextCursor: null }, { items: [{ ...buy, id: "" }], nextCursor: null },
  ]) {
    assert.throws(() => parseHeldPage(data), StocksContractError, JSON.stringify(data))
  }
})

test("held reducer: an older page is appended once; a failed older page keeps the rows", () => {
  const first = ready({ items: [buy as never], nextCursor: "c1" })
  const appending = heldReducer(first, { type: "start", append: true })
  assert.equal(appending.appending, true)
  assert.deepEqual(appending.items, first.items)
  const both = heldReducer(appending, { type: "loaded", page: { items: [buy as never, sell as never], nextCursor: null }, append: true, at: 0 })
  assert.deepEqual(both.items.map((item) => item.id), ["funding-1", "custody-2"])
  assert.equal(both.nextCursor, null)
  assert.equal(both.loadedAt, first.loadedAt)
  const failed = heldReducer(heldReducer(first, { type: "start", append: true }), { type: "failed", error: { kind: "network", status: null, code: null }, append: true })
  assert.deepEqual(failed.items, first.items)
  assert.equal(failed.appendError?.kind, "network")
  const reset = heldReducer(both, { type: "start", append: false })
  assert.equal(reset.phase, "loading")
  assert.equal(reset.items.length, 0)
})

test("Held payments tab: rows with side, wallet, exact amount, hold reason, status and an explorer link; no refund button", () => {
  const state = ready({ items: [buy as never, sell as never, plain as never], nextCursor: "next_1" })
  const html = renderToStaticMarkup(
    <HeldPaymentsView state={state} signedIn now={Date.UTC(2026, 8, 25, 12)} explorerTxUrl={(hash) => `https://explorer.example.test/tx/${hash}`} onRefresh={noop} onLoadOlder={noop} />,
  )
  const plainText = text(html)
  assert.match(plainText, /Held payments/)
  assert.match(plainText, /12\.5 TEST_CASH/)
  assert.match(plainText, /0\.5 NVDA/)
  assert.match(plainText, /Trading was paused TRADING_PAUSED/)
  assert.match(plainText, /Too small for one whole unit BELOW_ONE_UNIT/)
  assert.match(plainText, /Plain transfer without an order key UNATTRIBUTED_TRANSFER/)
  const limited = ready({ items: [{ ...buy, hold: "DAILY_LIMIT_REACHED" } as never, { ...sell, hold: "SIDE_DISABLED" } as never], nextCursor: null })
  const limitedText = text(renderToStaticMarkup(<HeldPaymentsView state={limited} signedIn now={0} onRefresh={noop} onLoadOlder={noop} />))
  assert.match(limitedText, /The daily cap in Limits was reached DAILY_LIMIT_REACHED/)
  assert.match(limitedText, /The side was turned off in Limits SIDE_DISABLED/)
  assert.match(plainText, /Suspense/)
  assert.match(plainText, /Held in escrow/)
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`href="https://explorer.example.test/tx/${TX(n)}"`))
  assert.match(html, /target="_blank" rel="noreferrer"/)
  assert.match(plainText, /Load 50 older/)
  assert.doesNotMatch(plainText, /Refund|Return to|Release/)
})

test("Held payments tab: signed out, 401, 403, route absent, empty and loading states", () => {
  const view = (state: HeldState, signedIn = true) => text(renderToStaticMarkup(<HeldPaymentsView state={state} signedIn={signedIn} now={0} onRefresh={noop} onLoadOlder={noop} onSignInRequired={noop} />))
  assert.match(view(HELD_INITIAL, false), /Operator session required.*Sign in with operator wallet/)
  const failed = (kind: "unauthorized" | "forbidden" | "disabled" | "server", status: number) =>
    heldReducer(HELD_INITIAL, { type: "failed", error: { kind, status, code: null }, append: false })
  assert.match(view(failed("unauthorized", 401)), /Session missing or expired \(401\).*Sign in with operator wallet/)
  assert.match(view(failed("forbidden", 403)), /No Stocks read permission \(403\)/)
  assert.match(view(failed("disabled", 404)), /not enabled on this server/)
  assert.match(view(failed("server", 503)), /Server error/)
  assert.match(view(heldReducer(HELD_INITIAL, { type: "start", append: false })), /Loading held payments/)
  assert.match(view(ready({ items: [], nextCursor: null })), /no held payments for this deployment/)
})
