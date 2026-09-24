// Hook-level browser behavior with an in-memory EventSource and batch transport.
// Set GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json to run this suite.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"
import type { MarketClient, MarketEventSource } from "./client"
import type { Envelope, NvdaLiveSnapshot, Quote } from "./contracts"
import { withNvdaSnapshot, type MarketQuoteView } from "./useMarketQuotes"
import type { ReadState } from "./useOwnedRead"

const runtime = process.env.GIWA_MARKET_DOM_RUNTIME
const START = Date.parse("2026-09-24T18:00:00.000Z")
const SYMBOLS = ["NVDA", "AAPL"] as const

const quote = (symbol: "NVDA" | "AAPL", price: string): Quote => ({
  symbol, currency: "USD", price, change: "1", changePercent: "1", sessionVolume: "1000",
  previousClose: "100", sourceTimestamp: "2026-09-24T17:59:30.000Z", observationAgeMs: 30_000,
  priceSource: "LAST_TRADE", status: "AVAILABLE", reason: null,
})

function snapshot(price: string, state: NvdaLiveSnapshot["marketSession"]["state"] = "OPEN", nextOpen = "2026-09-25T13:30:00.000Z"): NvdaLiveSnapshot {
  const observedAt = new Date(Date.now()).toISOString()
  return {
    schemaVersion: 1, symbol: "NVDA", observedAt,
    underlying: { basis: "UNDERLYING_SECURITY", currency: "USD", price, change: "2", changePercent: "2",
      sessionVolume: "2000", previousClose: "100", observationAgeMs: 0, status: "AVAILABLE", reason: null,
      sourceTimestamp: observedAt, priceSource: "LAST_TRADE", provider: "ALPACA", marketFeed: "IEX", feedDelay: "REALTIME" },
    marketSession: { state, observedAt, nextOpen, nextClose: state === "CLOSED" ? "2026-09-26T20:00:00.000Z" : "2026-09-24T20:00:00.000Z" },
    token: { basis: "ARCO_TOKEN", indicativePrice: null, status: "UNAVAILABLE" },
    testnetExecution: { mode: "FIXED_MOCK_PRICE", status: "CATALOG_ONLY", unitPrice: "120.000000", quoteRequired: true },
  }
}

test("live NVDA recomputes aggregate availability after replacing the batch row", () => {
  const unavailable = (symbol: "NVDA" | "AAPL"): Quote => ({ ...quote(symbol, "100"), price: null, sourceTimestamp: null, priceSource: null, status: "UNAVAILABLE", reason: "PROVIDER_UNAVAILABLE" })
  const batch: ReadState<Envelope<Quote[]>> = { phase: "ready", value: {
    status: "UNAVAILABLE", reason: "PROVIDER_UNAVAILABLE", provider: "ALPACA", marketFeed: "IEX",
    fetchedAt: null, cacheAgeMs: null, feedDelay: "UNKNOWN", data: [unavailable("NVDA"), unavailable("AAPL")],
  } }
  const recovered = withNvdaSnapshot(batch, snapshot("125"), "streaming")
  assert.equal(recovered.phase, "ready")
  if (recovered.phase !== "ready") return
  assert.equal(recovered.value.status, "AVAILABLE", "a recovered NVDA row must not inherit the old failure banner")
  assert.equal(recovered.value.feedDelay, "REALTIME")
  assert.equal(recovered.value.data?.find(row => row.symbol === "NVDA")?.price, "125")
  assert.equal(recovered.value.data?.find(row => row.symbol === "AAPL")?.status, "UNAVAILABLE")

  const stale = snapshot("125")
  stale.underlying.status = "STALE"
  stale.underlying.reason = "OLD_OBSERVATION"
  const current: ReadState<Envelope<Quote[]>> = { phase: "ready", value: { ...batch.value, status: "AVAILABLE", reason: null, data: [quote("NVDA", "100"), quote("AAPL", "200")] } }
  stale.underlying.sourceTimestamp = current.value.data![0].sourceTimestamp
  const mixed = withNvdaSnapshot(current, stale, "streaming")
  assert.equal(mixed.phase, "ready")
  if (mixed.phase === "ready") {
    assert.equal(mixed.value.status, "STALE", "the live row's stale state must be visible at the aggregate level")
    assert.equal(mixed.value.reason, "OLD_OBSERVATION")
  }

  const newerBatch: ReadState<Envelope<Quote[]>> = { phase: "ready", value: { ...current.value, data: [
    { ...quote("NVDA", "150"), sourceTimestamp: "2026-09-24T18:01:00.000Z" }, quote("AAPL", "200"),
  ] } }
  const olderLive = snapshot("125")
  olderLive.underlying.sourceTimestamp = "2026-09-24T18:00:00.000Z"
  assert.equal(withNvdaSnapshot(newerBatch, olderLive, "streaming"), newerBatch, "an older cached SSE snapshot cannot roll the quote back")
})

class FakeStream implements MarketEventSource {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  closes = 0
  addEventListener: EventTarget["addEventListener"] = (type, listener) => {
    if (!listener) return
    const group = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
    group.add(listener)
    this.listeners.set(type, group)
  }
  close() { this.closes++ }
  private emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event)
      else listener.handleEvent(event)
    }
  }
  publish(value: NvdaLiveSnapshot) {
    this.emit("snapshot", { data: JSON.stringify(value) } as MessageEvent<string>)
  }
  fail() { this.emit("error", {} as Event) }
}

function marketClient(base: string) {
  const streams: FakeStream[] = []
  const calls: { url: string }[] = []
  const signals: AbortSignal[] = []
  let batchNvdaPrice = "100"
  const fetcher = async (url: string, init: RequestInit) => {
    assert.equal(url, `${base}/api/v1/stocks/market/quotes`)
    assert.ok(init.signal)
    calls.push({ url })
    return Response.json({ schemaVersion: 1, profile: "DEMO_TESTNET", chainId: 91342,
      purpose: "DISPLAY_ONLY", priceBasis: "UNDERLYING_SECURITY", executionPriceSource: "FIXED_MOCK_PRICE",
      provider: "ALPACA", marketFeed: "IEX", status: "AVAILABLE", reason: null,
      fetchedAt: new Date(Date.now()).toISOString(), cacheAgeMs: 0, feedDelay: "REALTIME",
      data: [quote("NVDA", batchNvdaPrice), quote("AAPL", "200")] })
  }
  const client = (async () => {
    const { createMarketClient } = await import("./client")
    const real = createMarketClient(base, fetcher, 10_000, () => {
      const stream = new FakeStream()
      streams.push(stream)
      return stream
    })
    return { ...real, quotes: (names: readonly string[], signal: AbortSignal) => {
      signals.push(signal)
      return real.quotes(names, signal)
    } }
  })()
  return { client, streams, calls, signals, setBatchPrice: (value: string) => { batchNvdaPrice = value } }
}

async function mount(t: TestContext) {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid/stocks", pretendToBeVisual: true })
  const w = dom.window
  let hidden = false
  Object.defineProperty(w.document, "hidden", { configurable: true, get: () => hidden })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, Event: w.Event, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START })
  const React = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { useMarketQuotes } = await import("./useMarketQuotes")
  const { act, createElement: h } = React
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let view: MarketQuoteView | null = null
  function Probe({ client }: { client: MarketClient }) {
    view = useMarketQuotes(client, SYMBOLS, true)
    return null
  }
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }
  const run = async (action: () => void) => { await act(async () => { action(); await flush() }) }
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    t.mock.timers.reset()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const current = () => { assert.ok(view); return view }
  return {
    render: (client: MarketClient) => run(() => root.render(h(Probe, { client }))),
    emit: (stream: FakeStream, value: NvdaLiveSnapshot) => run(() => stream.publish(value)),
    error: (stream: FakeStream) => run(() => stream.fail()),
    tick: (milliseconds: number) => run(() => t.mock.timers.tick(milliseconds)),
    visibility: (value: boolean) => run(() => { hidden = value; document.dispatchEvent(new w.Event("visibilitychange")) }),
    unmount: () => run(() => root.unmount()),
    current,
    prices: () => {
      const result = current().quotes
      assert.equal(result.phase, "ready")
      return Object.fromEntries((result.value.data ?? []).map(row => [row.symbol, row.price]))
    },
  }
}

test("stream snapshots own NVDA, refresh the other rows once per event, and suppress independent polling", { skip: !runtime }, async t => {
  const page = await mount(t)
  const market = marketClient("https://market-a.invalid")
  await page.render(await market.client)
  assert.equal(market.calls.length, 1)
  assert.equal(market.streams.length, 1)
  assert.deepEqual(page.prices(), { NVDA: "100", AAPL: "200" })

  await page.emit(market.streams[0], snapshot("125.25"))
  assert.equal(page.current().connection, "streaming")
  assert.deepEqual(page.prices(), { NVDA: "125.25", AAPL: "200" })
  assert.equal(market.calls.length, 2)
  await page.emit(market.streams[0], snapshot("126.5"))
  assert.deepEqual(page.prices(), { NVDA: "126.5", AAPL: "200" })
  assert.equal(market.calls.length, 3)

  await page.tick(90_000)
  assert.equal(market.calls.length, 3, "a healthy stream replaces the 30-second batch poll")
  assert.equal(market.streams.length, 1)
})

test("a stream error releases its connection and restores 30-second batch polling", { skip: !runtime }, async t => {
  const page = await mount(t)
  const market = marketClient("https://market-a.invalid")
  await page.render(await market.client)
  await page.emit(market.streams[0], snapshot("125.25"))
  market.setBatchPrice("111")
  await page.error(market.streams[0])
  assert.equal(market.streams[0].closes, 1)
  assert.equal(page.current().connection, "reconnecting")
  assert.deepEqual(page.prices(), { NVDA: "100", AAPL: "200" }, "the disconnected stream no longer overrides the batch")

  await page.tick(30_000)
  assert.equal(market.calls.length, 3)
  assert.deepEqual(page.prices(), { NVDA: "111", AAPL: "200" })
  await page.tick(30_000)
  assert.equal(market.calls.length, 4)
  assert.equal(market.streams.length, 2, "reconnection remains bounded to the retry cadence")
})

test("closed-session ticks respect the 15-minute batch budget and the announced next opening", { skip: !runtime }, async t => {
  const page = await mount(t)
  const market = marketClient("https://market-a.invalid")
  await page.render(await market.client)
  await page.emit(market.streams[0], snapshot("125", "OPEN"))
  assert.equal(market.calls.length, 2)
  await page.emit(market.streams[0], snapshot("126", "CLOSED", "2026-09-24T18:10:00.000Z"))
  assert.equal(market.calls.length, 3, "an OPEN to CLOSED transition refreshes the batch")

  await page.tick(9 * 60_000 + 59_000)
  await page.emit(market.streams[0], snapshot("127", "CLOSED", "2026-09-24T18:10:00.000Z"))
  assert.equal(market.calls.length, 3)
  assert.equal(page.prices().NVDA, "127", "the streamed row still advances while batch reads rest")
  await page.error(market.streams[0])
  await page.tick(30_000)
  assert.equal(market.calls.length, 4, "fallback polling refreshes at the next-open boundary")
  assert.equal(market.streams.length, 2)

  await page.emit(market.streams[1], snapshot("129", "CLOSED", "2026-09-25T13:30:00.000Z"))
  assert.equal(market.calls.length, 4)
  await page.tick(14 * 60_000 + 59_000)
  await page.emit(market.streams[1], snapshot("130", "CLOSED", "2026-09-25T13:30:00.000Z"))
  assert.equal(market.calls.length, 4)
  await page.tick(1_000)
  await page.emit(market.streams[1], snapshot("131", "CLOSED", "2026-09-25T13:30:00.000Z"))
  assert.equal(market.calls.length, 5, "closed-session batch read resumes after 15 minutes")
  await page.emit(market.streams[1], snapshot("132", "OPEN"))
  assert.equal(market.calls.length, 6, "a CLOSED to OPEN transition refreshes immediately")
})

test("hiding, changing clients, and unmounting close streams and fence stale updates", { skip: !runtime }, async t => {
  const page = await mount(t)
  const first = marketClient("https://market-a.invalid")
  const second = marketClient("https://market-b.invalid")
  await page.render(await first.client)
  await page.emit(first.streams[0], snapshot("125"))
  await page.visibility(true)
  assert.equal(first.streams[0].closes, 1)
  assert.equal(page.current().connection, "paused")
  await page.emit(first.streams[0], snapshot("999"))
  await page.tick(90_000)
  assert.equal(first.calls.length, 2, "hidden tabs make no batch requests")

  await page.visibility(false)
  assert.equal(first.streams.length, 2)
  assert.equal(first.calls.length, 3)
  await page.emit(first.streams[1], snapshot("126"))
  assert.equal(page.prices().NVDA, "126")

  await page.render(await second.client)
  assert.equal(first.streams[1].closes, 1)
  assert.equal(first.signals[first.signals.length - 1]?.aborted, true)
  assert.equal(second.calls.length, 1)
  assert.equal(second.streams.length, 1)
  await page.emit(first.streams[1], snapshot("998"))
  assert.deepEqual(page.prices(), { NVDA: "100", AAPL: "200" })
  await page.emit(second.streams[0], snapshot("127"))
  assert.equal(page.prices().NVDA, "127")

  await page.unmount()
  assert.equal(second.streams[0].closes, 1)
  assert.equal(second.signals[second.signals.length - 1]?.aborted, true)
  await page.tick(120_000)
  assert.equal(second.calls.length, 2, "unmounted hooks schedule no further reads")
})
