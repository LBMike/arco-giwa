import assert from "node:assert/strict"
import test from "node:test"
import { dailyClosesOf, STOCK_DECIMALS, STOCK_DISPLAY, stockPriceOf } from "./portfolio-stocks"
import type { Chart, NvdaLiveSnapshot } from "./stocks-market/contracts"

const snapshot = (underlying: Record<string, unknown>) => ({ underlying: { price: "223.71", changePercent: "-1.25", status: "AVAILABLE", ...underlying } }) as unknown as NvdaLiveSnapshot

test("the live snapshot prices the holding while the feed has a price, open or closed market", () => {
  assert.deepEqual(stockPriceOf(snapshot({}), 1000), { value: 223.71, changePct: -1.25, at: 1000 })
  assert.deepEqual(stockPriceOf(snapshot({ status: "STALE", changePercent: null }), 1000), { value: 223.71, changePct: null, at: 1000 })
  for (const underlying of [{ status: "UNAVAILABLE" }, { status: "UNCONFIGURED" }, { price: null }, { price: "0" }, { price: "abc" }]) {
    assert.equal(stockPriceOf(snapshot(underlying), 1000), null, JSON.stringify(underlying))
  }
})

test("daily closes come from the chart's bars; an unavailable chart has none", () => {
  const bar = (timestamp: string, close: string) => ({ timestamp, open: close, high: close, low: close, close, volume: "1" })
  const chart = { data: { bars: [bar("2026-09-23T04:00:00.000Z", "220.5"), bar("2026-09-24T04:00:00.000Z", "223.71")] } as unknown as Chart }
  assert.deepEqual(dailyClosesOf(chart), [{ t: Date.parse("2026-09-23T04:00:00.000Z") / 1000, close: 220.5 }, { t: Date.parse("2026-09-24T04:00:00.000Z") / 1000, close: 223.71 }])
  assert.deepEqual(dailyClosesOf({ data: null }), [])
})

test("the Stocks row is the verified NVDA token at its 9 decimals, with the curated name and logo", () => {
  assert.equal(STOCK_DECIMALS, 9)
  assert.deepEqual(STOCK_DISPLAY, { symbol: "NVDA", name: "NVIDIA Corporation", imageUrl: "/logos/stocks/nvidia.png" })
})

test("the wallet's Stocks trades are a public read: lower-cased wallet, no credentials, a validated envelope", async () => {
  const { readStocksActivity } = await import("./portfolio-stocks")
  const calls: { url: string; init: RequestInit }[] = []
  const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }
  const entry = { side: "BUY", state: "COMPLETED", quantity: "498000000", cashAmount: "60000000", paymentTx: `0x${"ab".repeat(32)}`, settlementTx: null, createdAt: "2026-09-26T01:02:03.000Z" }
  const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }) }
  const wallet = "0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2"
  const entries = await readStocksActivity({ apiBase: "http://127.0.0.1:4392/", wallet, fetch: answer(200, { ...PROFILE, observedAt: "2026-09-26T01:02:04.000Z", data: [entry] }) })
  assert.deepEqual(entries, [entry])
  assert.equal(calls[0]!.url, `http://127.0.0.1:4392/api/v1/stocks/activity/${wallet.toLowerCase()}`)
  assert.equal(calls[0]!.init.credentials, "omit")
  assert.deepEqual(calls[0]!.init.headers, { accept: "application/json" })
  await assert.rejects(readStocksActivity({ apiBase: "http://127.0.0.1:4392", wallet, fetch: answer(404, { statusCode: 404, error: "Not Found", message: "x" }) }), /STOCKS_ACTIVITY_HTTP_404/, "an older API without the route is not 'no trades'")
  await assert.rejects(readStocksActivity({ apiBase: "http://127.0.0.1:4392", wallet, fetch: answer(200, { ...PROFILE, observedAt: "2026-09-26T01:02:04.000Z", data: [{ ...entry, state: "SETTLED" }] }) }))
  await assert.rejects(readStocksActivity({ apiBase: "http://127.0.0.1:4392", wallet, fetch: answer(200, { ...PROFILE, observedAt: "2026-09-26T01:02:04.000Z", data: [{ ...entry, paymentTx: "0x12" }] }) }))
  await assert.rejects(readStocksActivity({ apiBase: "http://127.0.0.1:4392", wallet: "0x1234", fetch: answer(200, {}) }), /STOCKS_ACTIVITY_INVALID_REQUEST/)
})
