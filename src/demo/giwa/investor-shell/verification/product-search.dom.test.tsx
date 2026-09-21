import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

test("header search opens, filters, navigates by keyboard and closes on Escape/outside; partial stock failure preserves funds", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<html><body><div id="root"></div><button id="outside">Outside</button></body></html>', { url: "https://fixture.invalid", pretendToBeVisual: true })
  const w = dom.window
  w.matchMedia = () => ({ matches: true })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, Event: w.Event, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  try {
    const { act, createElement: h } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { MemoryRouter, useLocation } = await import("react-router-dom")
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
    const { GiwaProductSearch } = await import("../../GiwaProductSearch")
    const { StocksPageEnvironment } = await import("../../stocks-market/environment")
    const { fixtureTop40MarketFetch } = await import("../../stocks-market/fixtures")
    const { giwaApi } = await import("../../api")
    const { default: snapshot } = await import("./deployed-giwa.snapshot.json")
    const original = { catalog: giwaApi.catalog, market: giwaApi.market }
    giwaApi.catalog = async () => snapshot.catalog as unknown as Awaited<ReturnType<typeof giwaApi.catalog>>
    giwaApi.market = async () => snapshot.market
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    const root = createRoot(w.document.getElementById("root")!)
    const fetcher = fixtureTop40MarketFetch()
    let failStocks = false
    const environment = { apiBase: "https://fixture.invalid", fetch: (url: string, init: RequestInit) => failStocks ? Promise.reject(new Error("offline")) : fetcher(url, init) }
    const tick = async () => { await new Promise(resolve => setTimeout(resolve, 30)) }
    const key = async (el: Element, value: string) => { await act(async () => { el.dispatchEvent(new w.KeyboardEvent("keydown", { key: value, bubbles: true })); await tick() }) }
    const click = async (el: Element | null) => { assert.ok(el); await act(async () => { (el as HTMLElement).click(); await tick() }) }
    const field = () => w.document.querySelector("input")!
    const input = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(field(), value); field().dispatchEvent(new w.Event("input", { bubbles: true })); await tick() }) }
    const options = (): Element[] => Array.from(w.document.querySelectorAll('[role="option"]'))
    const button = (name: string) => Array.from(w.document.querySelectorAll("button")).find((el: any) => el.textContent === name) as HTMLElement
    function Route() { const location = useLocation(); return h("output", { id: "route" }, location.pathname + location.search) }
    try {
      await act(async () => root.render(h(QueryClientProvider, { client }, h(StocksPageEnvironment.Provider, { value: environment }, h(MemoryRouter, null, h(GiwaProductSearch), h(Route))))))
      await key(w.document.body, "/")
      await act(tick)
      assert.equal(options().length, 48)
      assert.equal(w.document.activeElement, field())
      await click(button("Stocks"))
      assert.equal(options().length, 40)
      await input("tesla")
      assert.equal(options().length, 1)
      assert.match(options()[0].textContent!, /TSLA/)
      await key(field(), "ArrowDown")
      assert.equal(field().getAttribute("aria-activedescendant"), options()[0].id)
      await key(field(), "Enter")
      assert.equal(w.document.getElementById("route")!.textContent, "/stocks?symbol=TSLA")
      assert.equal(options().length, 0)
      await click(w.document.querySelector('[aria-label="Show product search results"]'))
      await input("notlisted")
      assert.match(w.document.body.textContent!, /No products found/)
      await key(field(), "Escape")
      assert.equal(w.document.querySelector('[aria-label="Product search"]'), null)
      assert.equal(w.document.activeElement, field())
      await click(w.document.querySelector('[aria-label="Show product search results"]'))
      await act(async () => w.document.getElementById("outside")!.dispatchEvent(new w.Event("pointerdown", { bubbles: true })))
      assert.equal(w.document.querySelector('[aria-label="Product search"]'), null)
      failStocks = true
      await click(w.document.querySelector('[aria-label="Show product search results"]'))
      await input("")
      await click(button("Funds"))
      assert.equal(options().length, 4)
      assert.match(w.document.body.textContent!, /Stocks are temporarily unavailable/)
      await click(options().find(el => el.textContent!.includes("auMINT"))!)
      assert.equal(w.document.getElementById("route")!.textContent, "/product/umint")
      await click(w.document.querySelector('[aria-label="Show product search results"]'))
      await input("ETH")
      await click(options().find(el => el.textContent!.includes("ETH Savings"))!)
      assert.equal(w.document.getElementById("route")!.textContent, "/savings?asset=ETH&account=real%3Aaeth%3AETH")
    } finally { await act(async () => root.unmount()); client.clear(); Object.assign(giwaApi, original) }
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!); else Reflect.deleteProperty(globalThis, key) }
  }
})
