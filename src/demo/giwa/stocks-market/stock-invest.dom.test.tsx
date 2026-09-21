import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

test("stock invest panel: amounts, side and symbol isolation, explicit connect, mobile sheet focus and dock cleanup", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<html><body><main id="giwa-main" tabindex="-1"></main></body></html>', { url: "https://fixture.invalid", pretendToBeVisual: true })
  const w = dom.window
  let desktop = true
  const listeners = new Set<() => void>()
  w.matchMedia = (query: string) => ({ media: query, get matches() { return query === "(min-width: 1024px)" && desktop }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, Event: w.Event, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  try {
    const { act, createElement: h } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { StockMarketInvestPanel } = await import("./StockMarketInvestPanel")
    const { fixtureTop40Quote } = await import("./fixtures")
    const container = w.document.getElementById("giwa-main")!
    const root = createRoot(container)
    let connects = 0
    const show = (symbol: string) => h(StockMarketInvestPanel, { key: symbol, symbol, quote: fixtureTop40Quote(symbol), access: { wallet: "disconnected", host: "signed-out", hostError: null, canSignIn: false, connectWallet: () => { connects++ } } })
    const click = async (el: Element | null) => { assert.ok(el); await act(async () => (el as HTMLElement).click()) }
    const input = async (value: string) => { const el = w.document.querySelector("input")!; assert.ok(el); await act(async () => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new w.Event("input", { bubbles: true })) }) }
    await act(async () => root.render(show("SOXL")))
    await input("1000")
    assert.match(container.textContent!, /5\.83/)
    await click(container.querySelectorAll('[role="tab"]')[1])
    assert.equal(container.querySelector("input")!.value, "")
    await input("2")
    assert.match(container.textContent!, /343\.26/)
    assert.equal(connects, 0)
    await click(Array.from(container.querySelectorAll("button")).find((el: any) => el.textContent === "Connect Wallet") as Element)
    assert.equal(connects, 1)
    await act(async () => root.render(show("TSLA")))
    assert.equal(container.querySelector("input")!.value, "")
    assert.doesNotMatch(container.textContent!, /SOXL/)
    await act(async () => { desktop = false; listeners.forEach(fn => fn()) })
    assert.equal(w.document.querySelector('[role="dialog"]'), null)
    const sell = Array.from(container.querySelectorAll("button")).find((el: any) => el.textContent === "Sell") as HTMLElement
    await click(sell)
    assert.match(w.document.querySelector('[role="dialog"]')!.textContent!, /TSLA/)
    assert.equal(w.document.querySelectorAll('[aria-label="TSLA invest panel"]').length, 1)
    await input("2")
    assert.match(w.document.querySelector('[role="dialog"]')!.textContent!, /1247\.5/)
    await click(w.document.querySelector('[role="dialog"] button[aria-label="Close"]'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    assert.equal(w.document.querySelector('[role="dialog"]'), null)
    assert.equal(w.document.activeElement, sell)
    await act(async () => root.unmount())
    assert.equal(w.document.documentElement.style.getPropertyValue("--giwa-dock-space"), "")
    assert.equal(connects, 1)

    // The new NVDA presentation uses the existing controller and exact server quote; UI estimates never reach it.
    desktop = true
    const { GiwaStocksFeature } = await import("../stocks-investor/GiwaStocksFeature")
    const { DemoPresentationContext } = await import("../demo-presentation")
    const { createHarness, WALLET_A, flush } = await import("../stocks-investor/fixtures/controller-harness")
    const harness = createHarness()
    const investorRoot = createRoot(container)
    try {
      await act(async () => { investorRoot.render(h(DemoPresentationContext.Provider, { value: true }, h(GiwaStocksFeature, { client: harness.client, session: harness.session(WALLET_A), detailOpen: true, onDetailChange: () => {}, now: () => 1000000, statusPollMs: 0 }))); await flush() })
      assert.equal(container.querySelectorAll('[aria-label="NVDA invest panel"]').length, 1)
      await input("0.5")
      await click(Array.from(container.querySelectorAll("button")).find((el: any) => el.textContent === "Get quote") as Element)
      await act(async () => { await flush() })
      assert.equal(harness.requests("POST", "/quotes").length, 1)
      assert.match(container.textContent!, /60/)
      assert.match(container.textContent!, /Place buy order/)
      assert.equal(harness.requests("POST", "/orders").length, 0)
      await click(container.querySelectorAll('[role="tab"]')[1])
      await act(async () => { await flush() })
      assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent, "Sell")
      assert.doesNotMatch(container.textContent!, /Place buy order/)
    } finally { await act(async () => investorRoot.unmount()) }
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) { const original = previous[key]; if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key) }
  }
})
