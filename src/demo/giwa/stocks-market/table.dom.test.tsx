// The Stocks & ETFs table and detail inside the real StocksMarketFeature, on a memory router, against the synthetic 40-symbol
// market fixture. Gated like routes.dom.test.mjs: set GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json. jsdom globals
// are installed before react-dom and the feature are imported (dynamic imports inside the gated body).
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"
import type { Quote } from "./contracts"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

test("Stocks & ETFs table filters, sorts, selects by keyboard and returns focus (set GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t: TestContext) => {
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
  // jsdom has no layout: record scroll requests instead.
  const scrolls: { element: Element; options: ScrollIntoViewOptions | undefined }[] = []
  w.HTMLElement.prototype.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions) { scrolls.push({ element: this, options }) }

  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { createMemoryRouter, RouterProvider } = (await import("react-router-dom")) as AnyModule
  const { StocksMarketFeature } = (await import("./StocksMarketFeature")) as AnyModule
  const { createMarketClient } = (await import("./client")) as AnyModule
  const { fixtureTop40MarketFetch, fixtureTop40Quotes, TOP40_UNAVAILABLE } = (await import("./fixtures")) as AnyModule
  const { CURATED_STOCKS, curatedStock } = (await import("./curated")) as AnyModule
  const { scaled } = (await import("./validate")) as AnyModule
  const { act, createElement: h, StrictMode } = React
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
  const inputValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
  const selectValue = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value")!.set!

  /** Unmounts in the subtest's own after hook, before the parent restores the globals. */
  async function mount(st: TestContext, path = "/stocks") {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const market = fixtureTop40MarketFetch()
    const calls: string[] = []
    let orderReads = 0
    const client = createMarketClient("https://api.fixture", async (url: string, init: RequestInit) => { calls.push(url); return market(url, init) })
    const ordersClient = { async getCatalog() { orderReads++; return { instruments: [{ symbol: "NVDA", orderCapability: "CHECK_PAUSE_AT_ORDER" }] } } }
    const router = createMemoryRouter([{ path: "/stocks", element: h(StocksMarketFeature, { client, ordersClient }) }], { initialEntries: [path] })
    await act(async () => { root.render(h(StrictMode, null, h(RouterProvider, { router }))); await flush() })
    const table = () => element.querySelector('[role="table"][aria-label="Stocks & ETFs"]') as HTMLElement
    const rows = () => [...table().querySelectorAll('[role="rowgroup"]')[1].querySelectorAll('[role="row"]')].filter(row => row.querySelector("[data-symbol]"))
    const visible = () => rows().map(row => [row.querySelector("[data-symbol]")!.getAttribute("data-symbol"), row.querySelector('[role="cell"]')!.textContent])
    const button = (name: string) => [...element.querySelectorAll("button")].find(item => item.textContent === name) as HTMLButtonElement
    const rowButton = (symbol: string) => element.querySelector(`button[data-symbol="${symbol}"]`) as HTMLButtonElement
    const heading = () => element.querySelector("article h2") as HTMLHeadingElement
    const run = async (work: () => void) => { await act(async () => { work(); await flush() }) }
    /** Native <button> activation: browsers turn Enter/Space into a click; jsdom does not, so the click is issued the same way. */
    const press = async (target: HTMLButtonElement, key: "Enter" | " ") => {
      assert.equal(target.tagName, "BUTTON"); assert.equal(target.type, "button")
      await run(() => { target.focus(); target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true })); target.dispatchEvent(new w.KeyboardEvent("keyup", { key, bubbles: true })); target.click() })
    }
    st.after(async () => { await act(async () => root.unmount()); router.dispose(); element.remove() })
    return { element, router, calls, get orderReads() { return orderReads }, table, rows, visible, button, rowButton, heading, run, press }
  }
  const rankOf = (symbol: string) => String(curatedStock(symbol).rank)

  await t.test("chips, search and sort change the visible rows without renumbering #", async (st) => {
    const m = await mount(st)
    assert.equal(m.rows().length, 40)
    assert.deepEqual(m.visible().map(([, rank]) => rank), CURATED_STOCKS.map((item: { rank: number }) => String(item.rank)))
    await m.run(() => m.button("ETF").click())
    assert.equal(m.button("ETF").getAttribute("aria-pressed"), "true")
    assert.equal(m.rows().length, 14)
    for (const [symbol, rank] of m.visible()) { assert.equal(curatedStock(symbol).kind, "ETF"); assert.equal(rank, rankOf(symbol!)) }
    await m.run(() => m.button("Stocks").click())
    assert.equal(m.rows().length, 26)
    await m.run(() => m.button("All assets").click())
    const search = m.element.querySelector('input[type="search"]') as HTMLInputElement
    assert.equal(m.element.querySelector(`label[for="${search.id}"]`)?.textContent, "Search asset name or ticker")
    await m.run(() => { inputValue.call(search, "nvid"); search.dispatchEvent(new w.Event("input", { bubbles: true })) })
    assert.deepEqual(m.visible(), [["NVDA", "10"]])
    await m.run(() => { inputValue.call(search, "DIREXION"); search.dispatchEvent(new w.Event("input", { bubbles: true })) })
    assert.deepEqual(m.visible(), [["SOXL", "1"], ["SOXS", "6"], ["KORU", "12"]])
    assert.match(m.element.querySelector('p[role="status"].sr-only')!.textContent!, /^3개 표시 · 전체 40개$/)
    await m.run(() => { inputValue.call(search, "zzzz"); search.dispatchEvent(new w.Event("input", { bubbles: true })) })
    assert.equal(m.rows().length, 0)
    assert.match(m.element.textContent!, /검색 결과가 없습니다\./)
    assert.doesNotMatch(m.table().textContent!, /검색 결과가 없습니다/, "the empty message is not a one-cell row inside the table")
    await m.run(() => { inputValue.call(search, ""); search.dispatchEvent(new w.Event("input", { bubbles: true })) })
    const sort = m.element.querySelector("select") as HTMLSelectElement
    assert.equal(m.element.querySelector(`label[for="${sort.id}"]`)?.textContent, "Sort")
    const quotes = fixtureTop40Quotes() as Quote[]
    const expected = (field: "changePercent" | "price", descending: boolean) => {
      const withValue = quotes.filter(quote => quote[field] !== null).sort((a, b) => { const x = scaled(a[field]!), y = scaled(b[field]!); return x === y ? Number(rankOf(a.symbol)) - Number(rankOf(b.symbol)) : (x < y ? -1 : 1) * (descending ? -1 : 1) })
      return [...withValue, ...quotes.filter(quote => quote[field] === null)].map(quote => [quote.symbol, rankOf(quote.symbol)])
    }
    for (const [option, field, descending] of [["gainer", "changePercent", true], ["loser", "changePercent", false], ["priceHigh", "price", true], ["priceLow", "price", false]] as const) {
      await m.run(() => { selectValue.call(sort, option); sort.dispatchEvent(new w.Event("change", { bubbles: true })) })
      assert.deepEqual(m.visible(), expected(field, descending), option)
      assert.deepEqual(m.visible().slice(-2).map(([symbol]) => symbol).sort(), [...TOP40_UNAVAILABLE].sort(), `${option}: missing values sort last`)
    }
    await m.run(() => { selectValue.call(sort, "rank"); sort.dispatchEvent(new w.Event("change", { bubbles: true })) })
    assert.deepEqual(m.visible().map(([, rank]) => rank), CURATED_STOCKS.map((item: { rank: number }) => String(item.rank)))
    assert.equal(m.orderReads >= 1 && m.orderReads <= 2, true, "one capability read per mount (StrictMode may repeat the effect)")
    assert.match(m.rows().find(row => row.querySelector('[data-symbol="NVDA"]'))!.textContent!, /모의 주문/)
  })

  await t.test("keyboard activation selects a row: ?symbol updates, the detail heading takes focus; 목록으로 returns to the row", async (st) => {
    const m = await mount(st)
    assert.equal(m.rowButton("SOXL").getAttribute("aria-pressed"), "true", "the first security is shown with no click")
    assert.equal(m.router.state.location.search, "")
    scrolls.length = 0
    await m.press(m.rowButton("MU"), "Enter")
    assert.equal(m.router.state.location.search, "?symbol=MU")
    assert.equal(m.rowButton("MU").getAttribute("aria-pressed"), "true")
    assert.equal(m.rowButton("SOXL").getAttribute("aria-pressed"), "false")
    assert.ok(document.activeElement === m.heading(), `focus on the detail heading, not ${document.activeElement?.tagName}`)
    assert.match(m.heading().textContent!, /MU/)
    assert.equal(m.heading().tabIndex, -1)
    assert.deepEqual(scrolls.map(item => [item.element.tagName, item.options?.behavior]), [["ARTICLE", "smooth"]])
    await m.press(m.rowButton("TSLA"), " ")
    assert.equal(m.router.state.location.search, "?symbol=TSLA")
    assert.ok(document.activeElement === m.heading())
    assert.match(m.heading().textContent!, /TSLA/)
    scrolls.length = 0
    await m.run(() => m.button("목록으로").click())
    assert.ok(document.activeElement === m.rowButton("TSLA"), `focus back on the TSLA row button, not ${document.activeElement?.outerHTML.slice(0, 60)}`)
    assert.deepEqual(scrolls.map(item => [item.element.getAttribute("data-symbol"), item.options?.block]), [["TSLA", "center"]])
    await m.run(() => { m.router.navigate(-1) })
    assert.equal(m.router.state.location.search, "?symbol=MU", "each selection is a history entry")
    assert.equal(m.rowButton("MU").getAttribute("aria-pressed"), "true")
  })

  await t.test("a row click outside the button selects it too; rows never request charts, the detail's 1D chart feeds the row sparkline", async (st) => {
    const m = await mount(st)
    const row = m.rows().find(item => item.querySelector('[data-symbol="NVDA"]'))!
    await m.run(() => (row.querySelector('[role="cell"]') as HTMLElement).click())
    assert.equal(m.router.state.location.search, "?symbol=NVDA")
    const charts = m.calls.filter(url => url.includes("/chart"))
    assert.deepEqual([...new Set(charts.map(url => new URL(url).pathname.split("/")[5]))].sort(), ["NVDA", "SOXL"], "only the detail's symbols")
    for (const symbol of ["NVDA", "SOXL"]) assert.ok(m.rows().find(item => item.querySelector(`[data-symbol="${symbol}"]`))!.querySelector('svg[role="img"][aria-label^="최근 24시간 종가 추이"]'), symbol)
    assert.equal(m.table().querySelectorAll('svg[role="img"]').length, 2)
    const before = m.calls.length
    await m.run(() => {})
    assert.equal(m.calls.length, before, "no polling or update loop")
  })

  await t.test("only a current 1D series feeds the row: other detail ranges keep it, a STALE 1D chart is not drawn", async (st) => {
    const m = await mount(st, "/stocks?symbol=NVDA")
    const spark = (symbol: string) => m.rows().find(item => item.querySelector(`[data-symbol="${symbol}"]`))!.querySelector('svg[role="img"]')
    const label = spark("NVDA")!.getAttribute("aria-label")
    for (const range of ["1W", "1Y"]) {
      await m.run(() => m.button(range).click())
      assert.equal(spark("NVDA")?.getAttribute("aria-label"), label, `${range} detail range leaves the 1D sparkline as it was`)
    }
    await m.press(m.rowButton("SGOV"), "Enter")
    assert.ok(m.calls.some(url => url.includes("/SGOV/chart?range=1D")), "the SGOV detail loaded its 1D chart")
    assert.equal(spark("SGOV"), null, "a STALE series stays in the detail with its notice")
    assert.match(m.rows().find(item => item.querySelector('[data-symbol="SGOV"]'))!.textContent!, /24시간 차트 미로드/)
  })

  await t.test("a ?symbol deep link selects and focuses that security; an unknown symbol falls back to the first without moving focus", async (st) => {
    scrolls.length = 0
    const m = await mount(st, "/stocks?symbol=TSLA")
    assert.equal(m.rowButton("TSLA").getAttribute("aria-pressed"), "true")
    assert.match(m.heading().textContent!, /TSLA/)
    assert.ok(document.activeElement === m.heading())
    assert.deepEqual(scrolls.map(item => item.element.tagName), ["ARTICLE"])
    const reduce = w.matchMedia
    w.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof w.matchMedia
    try {
      scrolls.length = 0
      await m.press(m.rowButton("GOOGL"), "Enter")
      assert.equal(scrolls[0]?.options?.behavior, "auto", "reduced motion scrolls without animation")
    } finally { w.matchMedia = reduce }
    ;(document.activeElement as HTMLElement | null)?.blur()
    const fallback = await mount(st, "/stocks?symbol=ZZZZ")
    assert.equal(fallback.rowButton("SOXL").getAttribute("aria-pressed"), "true")
    assert.match(fallback.heading().textContent!, /SOXL/)
    assert.ok(document.activeElement !== fallback.heading())
  })
})
