// The Stocks & ETFs list and the security detail inside the real StocksMarketFeature (list ↔ detail on ?symbol=), on a memory
// router, against the synthetic 40-symbol market fixture. Gated like routes.dom.test.mjs: set GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json. jsdom globals
// are installed before react-dom and the feature are imported (dynamic imports inside the gated body).
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"
import type { Quote } from "./contracts"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

test("Stocks & ETFs list and detail: filters, sorts, opens by keyboard, keeps list state and returns focus (set GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t: TestContext) => {
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
  /** `intercept` may replace a fixture answer (url, fixture response) → response. */
  async function mount(st: TestContext, path = "/stocks", intercept?: (url: string, response: Response) => Promise<Response>) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const market = fixtureTop40MarketFetch()
    const calls: string[] = []
    let orderReads = 0
    const client = createMarketClient("https://api.fixture", async (url: string, init: RequestInit) => { calls.push(url); const response = await market(url, init); return intercept ? intercept(url, response) : response })
    const ordersClient = { async getCatalog() { orderReads++; return { instruments: [{ symbol: "NVDA", orderCapability: "CHECK_PAUSE_AT_ORDER" }] } } }
    const router = createMemoryRouter([{ path: "/stocks", element: h(StocksMarketFeature, { client, ordersClient }) }], { initialEntries: [path] })
    await act(async () => { root.render(h(StrictMode, null, h(RouterProvider, { router }))); await flush() })
    const table = () => element.querySelector('[role="table"][aria-label="Stocks & ETFs"]') as HTMLElement
    const rows = () => [...table().querySelectorAll('[role="rowgroup"]')[1].querySelectorAll('[role="row"]')].filter(row => row.querySelector("[data-symbol]"))
    const visible = () => rows().map(row => [row.querySelector("[data-symbol]")!.getAttribute("data-symbol"), row.querySelector('[role="cell"]')!.textContent])
    const button = (name: string) => [...element.querySelectorAll("button")].find(item => item.textContent === name) as HTMLButtonElement
    const rowButton = (symbol: string) => element.querySelector(`button[data-symbol="${symbol}"]`) as HTMLButtonElement
    const heading = () => element.querySelector("article h1") as HTMLHeadingElement
    /** The page-level back control above the detail ("← Stocks & ETFs", accessible name with 목록으로). */
    const back = () => [...element.querySelectorAll("button")].find(item => item.textContent === "Stocks & ETFs 목록으로") as HTMLButtonElement
    const listed = () => Boolean(element.querySelector('[role="table"][aria-label="Stocks & ETFs"]'))
    const run = async (work: () => void) => { await act(async () => { work(); await flush() }) }
    /** Native <button> activation: browsers turn Enter/Space into a click; jsdom does not, so the click is issued the same way. */
    const press = async (target: HTMLButtonElement, key: "Enter" | " ") => {
      assert.equal(target.tagName, "BUTTON"); assert.equal(target.type, "button")
      await run(() => { target.focus(); target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true })); target.dispatchEvent(new w.KeyboardEvent("keyup", { key, bubbles: true })); target.click() })
    }
    st.after(async () => { await act(async () => root.unmount()); router.dispose(); element.remove() })
    return { element, router, calls, get orderReads() { return orderReads }, table, rows, visible, button, rowButton, heading, back, listed, run, press, close: () => run(() => back().click()) }
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

  await t.test("a row opens the detail in place of the list: ?symbol is pushed and the heading takes focus; Back returns focus to the row", async (st) => {
    const m = await mount(st)
    assert.equal(m.router.state.location.search, "")
    assert.equal(m.heading(), null, "no detail without ?symbol")
    // The rows open a detail page (they toggle nothing), so the list's row buttons carry no pressed state at all.
    assert.ok(m.rows().every(row => !row.querySelector("[data-symbol]")!.hasAttribute("aria-pressed")), "no toggle-button semantics on navigating rows")
    assert.ok(m.calls.some(url => url.includes("/chart?range=1D")) && m.calls.some(url => url.includes("/profile")), "the list loads row charts and valuations")
    scrolls.length = 0
    await m.press(m.rowButton("MU"), "Enter")
    assert.equal(m.router.state.location.search, "?symbol=MU")
    assert.equal(m.listed(), false, "the detail replaces the list")
    assert.ok(document.activeElement === m.heading(), `focus on the detail heading, not ${document.activeElement?.tagName}`)
    assert.match(m.heading().textContent!, /MU/)
    assert.equal(m.heading().tabIndex, -1)
    assert.deepEqual(scrolls.map(item => [item.element.textContent, item.options?.behavior, item.options?.block]), [["Stocks & ETFs 목록으로", "smooth", "start"]], "the top of the detail (its back control) scrolls into view")
    scrolls.length = 0
    await m.close()
    assert.equal(m.router.state.location.search, "", "closing pushes the list URL")
    assert.ok(document.activeElement === m.rowButton("MU"), `focus back on the MU row button, not ${document.activeElement?.outerHTML.slice(0, 60)}`)
    assert.deepEqual(scrolls.map(item => [item.element.getAttribute("data-symbol"), item.options?.block]), [["MU", "center"]])
    await m.press(m.rowButton("TSLA"), " ")
    assert.equal(m.router.state.location.search, "?symbol=TSLA")
    assert.ok(document.activeElement === m.heading())
    assert.match(m.heading().textContent!, /TSLA/)
    await m.close()
    assert.ok(document.activeElement === m.rowButton("TSLA"))
    // Back/Forward follow the history entries without moving focus.
    ;(document.activeElement as HTMLElement | null)?.blur()
    scrolls.length = 0
    await m.run(() => { m.router.navigate(-1) })
    assert.equal(m.router.state.location.search, "?symbol=TSLA", "each open and close is a history entry")
    assert.match(m.heading().textContent!, /TSLA/)
    assert.ok(document.activeElement !== m.heading(), "Back into a detail does not take focus")
    await m.run(() => { m.router.navigate(-1) })
    assert.equal(m.router.state.location.search, "")
    assert.equal(m.listed(), true)
    await m.run(() => { m.router.navigate(-1) })
    assert.match(m.heading().textContent!, /MU/)
    await m.run(() => { m.router.navigate(1) })
    assert.equal(m.listed(), true)
    assert.deepEqual(scrolls, [], "history moves never scroll or focus")
    assert.ok(document.activeElement === document.body)
  })

  await t.test("the list's filter, search and sort survive a detail visit; a row the filter hides returns focus to the table", async (st) => {
    const m = await mount(st)
    const search = () => m.element.querySelector('input[type="search"]') as HTMLInputElement
    const sort = () => m.element.querySelector("select") as HTMLSelectElement
    await m.run(() => m.button("ETF").click())
    await m.run(() => { inputValue.call(search(), "direxion"); search().dispatchEvent(new w.Event("input", { bubbles: true })) })
    await m.run(() => { selectValue.call(sort(), "gainer"); sort().dispatchEvent(new w.Event("change", { bubbles: true })) })
    const before = m.visible()
    assert.equal(before.length, 3)
    await m.press(m.rowButton("SOXS"), "Enter")
    assert.equal(m.listed(), false)
    await m.close()
    assert.equal(m.button("ETF").getAttribute("aria-pressed"), "true")
    assert.equal(search().value, "direxion")
    assert.equal(sort().value, "gainer")
    assert.deepEqual(m.visible(), before)
    assert.ok(document.activeElement === m.rowButton("SOXS"))
    // A navigation made elsewhere (a link to /stocks?symbol=TSLA) opens TSLA without moving focus; TSLA is not an ETF row.
    await m.run(() => { m.router.navigate("/stocks?symbol=TSLA") })
    assert.match(m.heading().textContent!, /TSLA/)
    assert.ok(document.activeElement !== m.heading())
    scrolls.length = 0
    await m.close()
    assert.equal(document.activeElement?.getAttribute("role"), "region", "the filtered-out row falls back to the table region")
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Stocks & ETFs 표 · 좌우로 스크롤")
    assert.deepEqual(scrolls.map(item => item.options?.block), ["start"])
  })

  await t.test("a row click outside the button opens it too; all listed rows load their own current 1D chart", async (st) => {
    const m = await mount(st)
    const row = m.rows().find(item => item.querySelector('[data-symbol="NVDA"]'))!
    await m.run(() => (row.querySelector('[role="cell"]') as HTMLElement).click())
    assert.equal(m.router.state.location.search, "?symbol=NVDA")
    const charts = m.calls.filter(url => url.includes("/chart"))
    assert.equal(new Set(charts.map(url => new URL(url).pathname.split("/")[5])).size, 40, "each listed symbol has its own chart request")
    await m.close()
    assert.ok(m.rows().find(item => item.querySelector('[data-symbol="NVDA"]'))!.querySelector('svg[role="img"][aria-label^="최근 24시간 종가 추이"]'))
    assert.equal(m.table().querySelectorAll('svg[role="img"]').length, 37)
    const before = m.calls.length
    await m.run(() => {})
    assert.equal(m.calls.length, before, "no polling or update loop")
  })

  await t.test("a background chart completing after a failed detail read restores that row", async (st) => {
    let release: (() => void) | undefined
    let reads = 0
    const intercept = async (url: string, response: Response) => {
      if (!url.endsWith("/NVDA/chart?range=1D")) return response
      if (++reads === 1) {
        await new Promise<void>(resolve => { release = resolve })
        return response
      }
      return Response.json({}, { status: 503 })
    }
    const m = await mount(st, "/stocks", intercept)
    assert.ok(release, "the list's chart request is pending")
    await m.press(m.rowButton("NVDA"), "Enter")
    await m.close()
    const spark = () => m.rows().find(row => row.querySelector('[data-symbol="NVDA"]'))!.querySelector('svg[role="img"]')
    assert.equal(spark(), null, "failed detail read leaves the row empty")
    await m.run(() => release!())
    assert.ok(spark(), "a later successful background result replaces the empty state")
  })

  await t.test("only a current 1D series feeds the row: other detail ranges keep it, a STALE 1D chart is not drawn", async (st) => {
    const m = await mount(st, "/stocks?symbol=NVDA")
    const spark = (symbol: string) => m.rows().find(item => item.querySelector(`[data-symbol="${symbol}"]`))!.querySelector('svg[role="img"]')
    await m.close()
    const label = spark("NVDA")!.getAttribute("aria-label")
    assert.ok(label)
    await m.press(m.rowButton("NVDA"), "Enter")
    for (const range of ["1W", "1Y"]) await m.run(() => m.button(range).click())
    await m.close()
    assert.equal(spark("NVDA")?.getAttribute("aria-label"), label, "1W and 1Y detail ranges leave the 1D sparkline as it was")
    await m.press(m.rowButton("SGOV"), "Enter")
    assert.ok(m.calls.some(url => url.includes("/SGOV/chart?range=1D")), "the SGOV detail loaded its 1D chart")
    await m.close()
    assert.equal(spark("SGOV"), null, "a STALE series stays in the detail with its notice")
    assert.match(m.rows().find(item => item.querySelector('[data-symbol="SGOV"]'))!.textContent!, /24시간 차트 데이터 없음/)
  })

  await t.test("a finished 1D re-read that is not current clears the row sparkline; the next valid read restores it", async (st) => {
    type Outcome = "STALE" | "UNAVAILABLE" | "UNCONFIGURED" | "EMPTY" | "ONE_BAR" | "HTTP_503" | null
    let next: Outcome = null
    const replaced: string[] = []
    // Only NVDA's 1D chart answer is swapped; everything else stays the fixture answer.
    const intercept = async (url: string, response: Response) => {
      if (next === null || !url.endsWith("/NVDA/chart?range=1D")) return response
      replaced.push(next)
      if (next === "HTTP_503") return Response.json({}, { status: 503 })
      const body = await response.json()
      if (next === "EMPTY") { body.data.bars = []; body.data.history = "EMPTY" }
      else if (next === "ONE_BAR") body.data.bars = body.data.bars.slice(0, 1)
      else { body.status = next; body.reason = next === "STALE" ? "OLD_OBSERVATION" : next === "UNCONFIGURED" ? "NOT_CONFIGURED" : "MISSING_OBSERVATION"; if (next !== "STALE") body.data = null }
      return Response.json(body)
    }
    const m = await mount(st, "/stocks?symbol=NVDA", intercept)
    const row = () => m.rows().find(item => item.querySelector('[data-symbol="NVDA"]'))!
    const spark = () => row().querySelector('svg[role="img"]')
    // Closing unmounts the detail, so opening NVDA again is a fresh 1D read; the row is read back in the list.
    const reselect = async (outcome: Outcome) => { next = outcome; await m.press(m.rowButton("NVDA"), "Enter"); next = null; await m.close() }
    await m.close()
    const valid = spark()?.getAttribute("aria-label")
    assert.ok(valid, "the first AVAILABLE 1D read draws the NVDA sparkline")
    for (const outcome of ["STALE", "UNAVAILABLE", "UNCONFIGURED", "EMPTY", "ONE_BAR", "HTTP_503"] as const) {
      await st.test(`AVAILABLE → ${outcome} → AVAILABLE`, async () => {
        await reselect(outcome)
        assert.equal(replaced[replaced.length - 1], outcome, `${outcome}: the replacement answer was requested`)
        assert.equal(Boolean(spark()), false, `${outcome}: the old sparkline is gone`)
        assert.match(row().textContent!, /24시간 차트 데이터 없음/, `${outcome}: the row falls back to the not-loaded state`)
        await reselect(null)
        assert.equal(spark()?.getAttribute("aria-label"), valid, `${outcome}: a following valid read restores it`)
      })
    }
    // Other ranges neither clear nor replace a valid 1D entry, even when their own read fails.
    next = null
    const failRange = async (url: string, response: Response) => url.includes("/NVDA/chart?range=1W") ? Response.json({}, { status: 503 }) : response
    const other = await mount(st, "/stocks?symbol=NVDA", failRange)
    const otherSpark = () => other.rows().find(item => item.querySelector('[data-symbol="NVDA"]'))!.querySelector('svg[role="img"]')
    await other.close()
    const before = otherSpark()?.getAttribute("aria-label")
    assert.ok(before)
    await other.press(other.rowButton("NVDA"), "Enter")
    for (const range of ["1W", "1Y"]) await other.run(() => other.button(range).click())
    await other.close()
    assert.equal(otherSpark()?.getAttribute("aria-label"), before, "1W (fails with 503) and 1Y leave the 1D sparkline")
    assert.ok(other.calls.some(url => url.includes("/NVDA/chart?range=1W")) && other.calls.some(url => url.includes("/NVDA/chart?range=1Y")))
    assert.ok(other.calls.some(url => url.includes("/MU/chart?range=1D")), "other rows load their own charts")
  })

  await t.test("a ?symbol deep link opens and focuses that security; an unknown symbol is not found (nothing requested); a malformed one is the list", async (st) => {
    scrolls.length = 0
    const m = await mount(st, "/stocks?symbol=TSLA")
    assert.equal(m.listed(), false)
    assert.match(m.heading().textContent!, /TSLA/)
    assert.ok(document.activeElement === m.heading())
    assert.deepEqual(scrolls.map(item => item.element.textContent), ["Stocks & ETFs 목록으로"])
    await m.close()
    assert.ok(document.activeElement === m.rowButton("TSLA"))
    const reduce = w.matchMedia
    w.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof w.matchMedia
    try {
      scrolls.length = 0
      await m.press(m.rowButton("GOOGL"), "Enter")
      assert.equal(scrolls[0]?.options?.behavior, "auto", "reduced motion scrolls without animation")
    } finally { w.matchMedia = reduce }
    ;(document.activeElement as HTMLElement | null)?.blur()
    const unknown = await mount(st, "/stocks?symbol=ZZZZ")
    assert.equal(unknown.listed(), false)
    assert.equal(unknown.heading().textContent, "종목을 찾을 수 없습니다")
    assert.ok(document.activeElement === unknown.heading(), "a deep link focuses the not-found heading")
    assert.match(unknown.element.textContent!, /ZZZZ은 서버 시장정보 목록에 없는 종목입니다/)
    assert.equal(unknown.calls.some(url => url.includes("ZZZZ")), false, "no profile or chart request for a symbol the catalog does not list")
    await unknown.run(() => unknown.button("목록으로").click())
    assert.equal(unknown.listed(), true)
    assert.equal(unknown.router.state.location.search, "")
    const malformed = await mount(st, "/stocks?symbol=nvda%3Cx%3E")
    assert.equal(malformed.listed(), true, "a symbol outside the contract syntax is never used")
    assert.equal(malformed.heading(), null)
    assert.equal(malformed.calls.some(url => /%3C/i.test(url)), false)
  })
})
