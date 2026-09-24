import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import type { StocksInvestorContext } from "../stocks-investor/controller"

const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("top-level Stocks Portfolio DOM integration", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://fixture.invalid", pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  t.after(() => {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const { act, StrictMode } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { StocksPortfolioPanel } = await import("./StocksPortfolioSection")
  const { createHarness, WALLET_A, WALLET_B, flush } = await import("../stocks-investor/fixtures/controller-harness")

  async function mount(h: ReturnType<typeof createHarness>, first: StocksInvestorContext = h.context(h.session(WALLET_A))) {
    const element = document.createElement("div")
    document.body.append(element)
    const root = createRoot(element)
    let context = first
    const render = async (next = context) => {
      context = next
      await act(async () => { root.render(<StrictMode><StocksPortfolioPanel {...context} pollMs={0} /></StrictMode>); await flush() })
    }
    const click = async (label: string) => {
      const button = [...element.querySelectorAll("button")].find(node => node.textContent === label)
      assert.ok(button, `missing ${label}: ${element.textContent}`)
      await act(async () => { button.click(); await flush() })
    }
    await render()
    return {
      element, render, click,
      text: () => element.textContent ?? "",
      field: (label: string) => [...element.querySelectorAll("dt")].find(node => node.textContent === label)?.nextElementSibling?.textContent,
      async unmount() { await act(async () => root.unmount()); element.remove() },
    }
  }

  await t.test("strict-mode mount reads verified holdings and refreshes after a sale/page return", async () => {
    const h = createHarness()
    h.controls.setHolding(WALLET_A, "2000000000")
    const m = await mount(h)
    try {
      assert.equal(m.field("Total (wallet + escrow)"), "2 NVDA")
      assert.equal(m.field("Available to sell"), "2 NVDA")
      h.controls.setHolding(WALLET_A, "1500000000")
      await act(async () => { window.dispatchEvent(new dom.window.Event("pageshow")); await flush() })
      assert.equal(m.field("Total (wallet + escrow)"), "1.5 NVDA")
      assert.equal(h.controls.requests.filter(r => r.method !== "GET").length, 0)
    } finally { await m.unmount() }
    const remounted = await mount(h)
    try { assert.equal(remounted.field("Total (wallet + escrow)"), "1.5 NVDA") }
    finally { await remounted.unmount() }
  })

  await t.test("reserved units and pending orders do not inflate wallet-plus-escrow totals", async () => {
    const h = createHarness()
    h.controls.setHolding(WALLET_A, "2000000000", "500000000")
    await h.enter(WALLET_A)
    await h.quote("1", "SELL")
    await h.controller.placeOrder()
    const m = await mount(h)
    try {
      assert.equal(m.field("Total (wallet + escrow)"), "2.5 NVDA")
      assert.equal(m.field("Reserved for sell orders (part of wallet)"), "1 NVDA")
      assert.equal(m.field("Available to sell"), "1 NVDA")
      assert.equal(m.field("In escrow (pending sale)"), "0.5 NVDA")
      assert.match(m.text(), /Sell 1 NVDA/)
      assert.match(m.text(), /Orders in progress are not holdings/)
    } finally { await m.unmount(); h.controller.suspend() }
  })

  await t.test("a delayed wallet A response cannot overwrite wallet B; logout and wrong chain remove holdings", async () => {
    const h = createHarness()
    h.controls.setHolding(WALLET_A, "123000000000")
    h.controls.setHolding(WALLET_B, "7000000000")
    h.controls.setIgnoreAbort(true)
    const m = await mount(h)
    try {
      h.controls.holdNext("portfolio")
      await m.click("Refresh")
      await m.render(h.context(h.session(WALLET_B), { address: WALLET_B, chainId: 91342 }))
      assert.equal(m.field("Total (wallet + escrow)"), "7 NVDA")
      await act(async () => { h.controls.releaseHeld(); await flush() })
      assert.equal(m.field("Total (wallet + escrow)"), "7 NVDA")
      assert.doesNotMatch(m.text(), /123 NVDA/)
      await m.render(h.context({ status: "signed-out" }))
      assert.equal(m.element.querySelectorAll("[data-testid=stocks-holding]").length, 0)
      await m.render(h.context(h.session(WALLET_B), { address: WALLET_B, chainId: 1 }))
      assert.equal(m.element.querySelectorAll("[data-testid=stocks-holding]").length, 0)
      await m.render(h.context(h.session(WALLET_B, true), { address: WALLET_B, chainId: 91342 }))
      assert.equal(m.field("Total (wallet + escrow)"), "7 NVDA")
    } finally { await m.unmount() }
  })

  await t.test("401 clears holdings, while a delayed old-session 401 cannot reject a new session", async () => {
    const h = createHarness()
    h.controls.setHolding(WALLET_A, "2000000000")
    const m = await mount(h)
    try {
      h.controls.revokeToken(h.tokenOf(WALLET_A)!)
      await m.click("Refresh")
      assert.equal(h.rejected.length, 1)
      assert.equal(m.element.querySelectorAll("[data-testid=stocks-holding]").length, 0)
      await m.render(h.context(h.session(WALLET_A, true)))
      assert.equal(m.field("Total (wallet + escrow)"), "2 NVDA")
      h.controls.setIgnoreAbort(true)
      h.controls.revokeToken(h.tokenOf(WALLET_A)!)
      h.controls.holdNext("portfolio")
      await m.click("Refresh")
      await m.render(h.context(h.session(WALLET_B)))
      await act(async () => { h.controls.releaseHeld(); await flush() })
      assert.equal(h.rejected.length, 1)
      assert.match(m.text(), /No Stocks holdings for this wallet/)
    } finally { await m.unmount() }
  })

  await t.test("failed reads are not zero holdings and Refresh recovers; absent API is explicit", async () => {
    const h = createHarness()
    h.controls.dropNext("portfolio")
    const m = await mount(h)
    try {
      assert.doesNotMatch(m.text(), /No Stocks holdings/)
      assert.ok(m.element.querySelectorAll("[data-testid=stocks-holding]").length === 0)
      await m.click("Refresh")
      assert.match(m.text(), /No Stocks holdings for this wallet/)
      await m.render({ ...h.context(h.session(WALLET_A)), client: null })
      assert.match(m.text(), /Stocks API is not configured/)
      assert.doesNotMatch(m.text(), /No Stocks holdings/)
    } finally { await m.unmount() }
  })

  await t.test("catalog failure has a working local retry; unregistered API never looks empty", async () => {
    const h = createHarness()
    h.controls.setCatalogMode("invalid")
    const m = await mount(h)
    try {
      assert.match(m.text(), /balance has not been confirmed/)
      h.controls.setCatalogMode("registered")
      await m.click("Retry Stocks connection")
      assert.match(m.text(), /No Stocks holdings for this wallet/)
    } finally { await m.unmount() }
    const absent = createHarness()
    absent.controls.setCatalogMode("not-registered")
    const empty = await mount(absent)
    try {
      assert.match(empty.text(), /not available on this server/)
      assert.doesNotMatch(empty.text(), /No Stocks holdings/)
    } finally { await empty.unmount() }
  })

  await t.test("signed-out wallets perform no private reads and large fractional quantities stay exact", async () => {
    const h = createHarness()
    const m = await mount(h, h.context({ status: "signed-out" }))
    try {
      assert.equal(h.requests("GET", "/portfolio").length, 0)
      assert.match(m.text(), /Sign-in required/)
      h.controls.setHolding(WALLET_A, "9007199254740993123456789")
      await m.render(h.context(h.session(WALLET_A)))
      assert.equal(m.field("In wallet")?.replace(/,/g, ""), "9007199254740993.123456789 NVDA")
      h.controls.setHolding(WALLET_A, "-1")
      await m.click("Refresh")
      assert.match(m.text(), /Holding under review/)
      assert.equal(m.field("Available to sell"), "-0.000000001 NVDA")
    } finally { await m.unmount() }
  })
})
