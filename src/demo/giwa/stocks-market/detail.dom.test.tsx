// The /stocks page layout around the right column: the aside keeps one tree position (nothing in it remounts) through list ↔
// detail and symbol changes, its sibling order follows the mode, and opening NVDA from the order panel moves neither focus nor
// scroll. Gated like table.dom.test.tsx: set GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

/** A fresh jsdom for one test; its globals are restored when the test ends. */
function installDom(t: TestContext) {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid/stocks", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const scrolls: Element[] = []
  w.HTMLElement.prototype.scrollIntoView = function (this: Element) { scrolls.push(this) }
  return { w, scrolls }
}

test("the /stocks aside keeps its tree position and order per mode; the order panel's View NVDA opens the detail without moving focus (set GIWA_MARKET_DOM_RUNTIME)", { skip: !runtime }, async (t: TestContext) => {
  const { scrolls } = installDom(t)

  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { createMemoryRouter, RouterProvider } = (await import("react-router-dom")) as AnyModule
  const { StocksMarketFeature } = (await import("./StocksMarketFeature")) as AnyModule
  const { createMarketClient } = (await import("./client")) as AnyModule
  const { fixtureTop40MarketFetch } = (await import("./fixtures")) as AnyModule
  const { act, createElement: h, StrictMode, useEffect } = React
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }

  // Stand-ins for the page's aside siblings; each counts its own mounts (StrictMode mounts twice on first render).
  const mounts: Record<string, number> = {}
  function Probe({ name, children }: { name: string; children?: unknown }) {
    useEffect(() => { mounts[name] = (mounts[name] ?? 0) + 1 }, [])
    return h("div", { "data-probe": name }, children)
  }
  type View = { selection: { symbol: string | null; openDetail(symbol: string, source: string): void }; unverified: boolean }
  const views: View[] = []
  const aside = (view: View) => {
    views.push(view)
    const { selection, unverified } = view
    const trade = h(Probe, { key: "trade", name: "trade" }, h("button", { type: "button", onClick: () => selection.openDetail("NVDA", "investor") }, "View NVDA"))
    const signIn = h(Probe, { key: "sign-in", name: "sign-in" }), notice = h(Probe, { key: "notice", name: "notice" })
    if (selection.symbol === null) return [signIn, notice, trade]
    return [selection.symbol !== "NVDA" && !unverified ? h(Probe, { key: "view-only", name: "view-only" }) : null, trade, signIn, notice]
  }

  const element = document.createElement("div"); document.body.append(element)
  const root = createRoot(element)
  const calls: string[] = []
  const market = fixtureTop40MarketFetch()
  const client = createMarketClient("https://api.fixture", async (url: string, init: RequestInit) => { calls.push(url); return market(url, init) })
  const ordersClient = { async getCatalog() { return { instruments: [{ symbol: "NVDA", orderCapability: "CHECK_PAUSE_AT_ORDER" }] } } }
  const router = createMemoryRouter([{ path: "/stocks", element: h(StocksMarketFeature, { client, ordersClient, aside }) }], { initialEntries: ["/stocks?view=compact"] })
  const run = async (work: () => void) => { await act(async () => { work(); await flush() }) }
  await run(() => root.render(h(StrictMode, null, h(RouterProvider, { router }))))
  // Unmounted in the body (after hooks run in registration order, and the first one removes the jsdom globals).
  try {
    const order = () => [...element.querySelectorAll("[data-probe]")].map(node => node.getAttribute("data-probe"))
    const grid = () => element.querySelector("[data-probe]")!.parentElement!.parentElement!
    const heading = () => element.querySelector("article h1")
    const back = () => [...element.querySelectorAll("button")].find(item => item.textContent === "Stocks & ETFs list") as HTMLButtonElement

    assert.deepEqual(order(), ["sign-in", "notice", "trade"], "list: sign-in, session notice, then the order section")
    const baseline = { ...mounts }
    const tradeNode = element.querySelector('[data-probe="trade"]')

    // The order panel's View NVDA: detail in the same render, URL mirrored with the other params kept, focus and scroll untouched.
    const view = [...element.querySelectorAll("button")].find(item => item.textContent === "View NVDA") as HTMLButtonElement
    view.focus()
    scrolls.length = 0
    act(() => { view.click() })
    assert.match(heading()?.textContent ?? "", /NVDA/, "the detail renders in the click's own commit, before the URL catches up")
    await run(() => {})
    assert.equal(router.state.location.search, "?view=compact&symbol=NVDA")
    assert.match(heading()!.textContent!, /NVDA/)
    assert.ok(document.activeElement === view, `focus stays with the order panel, not ${document.activeElement?.outerHTML.slice(0, 60)}`)
    assert.deepEqual(scrolls, [], "the page does not scroll for an order-panel entry")
    assert.deepEqual(order(), ["trade", "sign-in", "notice"], "NVDA detail: order section first")
    assert.match(grid().className, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,488px\)\]/)
    // Room for the order panel's mobile dock only while it is mounted (its summary heading has the frozen detail-title id),
    // never unconditionally: the Orders/Portfolio tabs and an unloaded order catalog have no dock.
    assert.ok(grid().className.split(" ").includes("max-lg:has-[#giwa-stocks-detail-title]:pb-28"), grid().className)
    assert.ok(!grid().className.split(" ").some(token => token === "pb-28" || token.endsWith(":pb-28") && !token.includes("has-[#giwa-stocks-detail-title]")), "no padding without the dock")
    assert.ok(element.querySelector('[data-probe="trade"]') === tradeNode, "the same DOM node: nothing remounted")
    assert.deepEqual(mounts, baseline)

    // Another symbol from the list: the view-only card leads; the order section is the same instance.
    await run(() => back().click())
    assert.equal(router.state.location.search, "?view=compact")
    assert.deepEqual(order(), ["sign-in", "notice", "trade"])
    await run(() => (element.querySelector('button[data-symbol="MU"]') as HTMLButtonElement).click())
    assert.deepEqual(order(), ["view-only", "trade", "sign-in", "notice"])
    assert.doesNotMatch(grid().className, /pb-28/, "no dock padding without the NVDA order panel")
    assert.equal(views[views.length - 1].unverified, false)
    assert.ok(element.querySelector('[data-probe="trade"]') === tradeNode)
    assert.deepEqual({ ...mounts, "view-only": undefined }, { ...baseline, "view-only": undefined })

    // A symbol the market catalog does not list: the aside is told, so it does not offer the view-only card.
    await run(() => { router.navigate("/stocks?symbol=ZZZZ") })
    assert.equal(heading()!.textContent, "Security not found")
    assert.equal(views[views.length - 1].unverified, true)
    assert.deepEqual(order(), ["trade", "sign-in", "notice"])
    assert.equal(calls.some(url => url.includes("ZZZZ")), false)
    await run(() => { router.navigate(-1) })
    assert.deepEqual(order(), ["view-only", "trade", "sign-in", "notice"], "Back to MU")
    assert.equal(views[views.length - 1].unverified, false)
    assert.ok(element.querySelector('[data-probe="trade"]') === tradeNode)
    assert.equal(mounts.trade, baseline.trade, "the order section never remounted")
  } finally { await act(async () => root.unmount()); router.dispose(); element.remove() }
})

test("without a ready market catalog an unknown symbol is unverified: no view-only card and no market-data badge; NVDA and the curated 40 keep theirs (set GIWA_MARKET_DOM_RUNTIME)", { skip: !runtime }, async (t: TestContext) => {
  installDom(t)
  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { createMemoryRouter, RouterProvider } = (await import("react-router-dom")) as AnyModule
  const { StocksMarketFeature } = (await import("./StocksMarketFeature")) as AnyModule
  const { createMarketClient } = (await import("./client")) as AnyModule
  const { fixtureEnvelope } = (await import("./fixtures")) as AnyModule
  const { act, createElement: h } = React
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
  type View = { selection: { symbol: string | null }; unverified: boolean }
  const views: View[] = []
  // The page's rule (StocksPages): the view-only card for a non-NVDA symbol unless it is unverified.
  const aside = (view: View) => { views.push(view); return view.selection.symbol !== null && view.selection.symbol !== "NVDA" && !view.unverified ? h("p", { key: "view-only", "data-probe": "view-only" }, "조회 전용") : null }
  const ordersClient = { async getCatalog() { return { instruments: [{ symbol: "NVDA", orderCapability: "CHECK_PAUSE_AT_ORDER" }] } } }
  // The catalog read fails, answers UNAVAILABLE without data, or never answers; or the page has no market client at all.
  const catalogs: [string, (() => Promise<Response>) | null][] = [
    ["HTTP 503", async () => new Response("{}", { status: 503 })],
    ["UNAVAILABLE", async () => Response.json(fixtureEnvelope(null, "UNAVAILABLE"))],
    ["loading", () => new Promise<Response>(() => {})],
    ["no client", null],
  ]
  for (const [label, catalog] of catalogs) {
    for (const [symbol, known] of [["ZZZZ", false], ["AAPL", false], ["MU", true], ["NVDA", true]] as const) {
      const element = document.createElement("div"); document.body.append(element)
      const root = createRoot(element)
      const calls: string[] = []
      const client = catalog && createMarketClient("https://api.fixture", async (url: string) => { calls.push(url); if (url.endsWith("/market/catalog")) return catalog(); throw new Error(`unexpected ${url}`) })
      const router = createMemoryRouter([{ path: "/stocks", element: h(StocksMarketFeature, { client, ordersClient, aside }) }], { initialEntries: [`/stocks?symbol=${symbol}`] })
      try {
        views.length = 0
        await act(async () => { root.render(h(RouterProvider, { router })); await flush() })
        const where = `${label} · ${symbol}`
        const article = element.querySelector("article")!
        assert.equal(article.querySelector("h1")!.textContent!.includes(symbol), true, `${where}: the heading names the symbol`)
        assert.ok(views.length > 0 && views.every(view => view.unverified === !known), `${where}: unverified=${!known} in every render (never a first-commit card)`)
        assert.equal(element.querySelectorAll('[data-probe="view-only"]').length, known && symbol !== "NVDA" ? 1 : 0, `${where}: view-only card`)
        const header = article.querySelector("header")!.textContent!
        if (known) assert.match(header, /Market data only|Demo trading|Checking|Status unavailable/, `${where}: the order-capability badge stays`)
        else {
          assert.doesNotMatch(header, /Market data only|Demo trading|Checking|Status unavailable|Inactive/, `${where}: no badge for an unverified symbol`)
          assert.match(article.textContent!, new RegExp(`${symbol} has not been verified in the market data catalog\\.`))
        }
        assert.equal(calls.some(url => url.includes(`/${symbol}/`)), false, `${where}: nothing is requested for the symbol`)
      } finally { await act(async () => root.unmount()); router.dispose(); element.remove() }
    }
  }
})

test("the chart's Y axis is drawn at the whole-cent ticks: narrow SGOV-like closes get one exact, distinct label per gridline (set GIWA_MARKET_DOM_RUNTIME)", { skip: !runtime }, async (t: TestContext) => {
  const { w } = installDom(t)
  // jsdom has no layout: every element measures 640×300, so the responsive container renders the chart at that size.
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 640, height: 300, top: 0, left: 0, right: 640, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect }
  for (const key of ["requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: w[key].bind(w) })
  // A chart timer can still fire after the window closes: leave inert frame functions behind (this process ends with the file).
  t.after(() => { Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: () => 0 }); Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: () => {} }) })
  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { MarketChart } = (await import("./MarketChart")) as AnyModule
  const { FIXTURE_TIME, fixtureTop40Chart } = (await import("./fixtures")) as AnyModule
  const { act, createElement: h } = React
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
  for (const [low, high, expected] of [[10049, 10052, ["$100.49", "$100.5", "$100.51", "$100.52"]], [10001, 10004, ["$100.01", "$100.02", "$100.03", "$100.04"]], [2231, 2236, ["$22.3", "$22.32", "$22.34", "$22.36"]]] as const) {
    const chart = fixtureTop40Chart("SGOV", "1D")
    const last = chart.bars.length - 1
    chart.bars = chart.bars.map((bar: Record<string, string>, index: number) => {
      const cents = index === 0 ? low : index === last ? high : low + Math.round((high - low) * (0.5 + 0.5 * Math.sin(index / 7)))
      const value = (cents / 100).toFixed(2)
      return { ...bar, open: value, high: value, low: value, close: value }
    })
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    try {
      await act(async () => { root.render(h(MarketChart, { response: { status: "AVAILABLE", reason: null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data: chart } })); await flush() })
      const labels = [...element.querySelectorAll("svg text")].map(node => node.textContent ?? "").filter(label => label.startsWith("$"))
      assert.deepEqual(labels, expected, `closes ${low / 100}–${high / 100}`)
      assert.equal(element.querySelectorAll(".recharts-cartesian-grid-horizontal line").length, expected.length, "one gridline per labelled tick")
    } finally { await act(async () => root.unmount()); element.remove() }
  }
})
