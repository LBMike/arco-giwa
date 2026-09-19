// Keyboard focus in the REAL investor feature (GiwaStocksFeature in React DOM + StrictMode) over the TEST-ONLY fake
// Stocks server (fixtures/fake-stocks-server.ts through fixtures/controller-harness.ts). No socket, wallet, key or signature.
//
// Gated like stocks-execution-host/page.dom.test.tsx: set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json.
// jsdom globals are installed BEFORE react-dom and the feature modules are imported (dynamic imports inside the gated
// body); static imports here are type-only apart from node:test/assert/module.
//
// Browsers apply the HTML focus fixup rule: a focused button that becomes disabled loses focus to <body>, and later
// Enter/Space presses go nowhere. jsdom does not implement it, so it is emulated below (a disabled, focused element is
// blurred). A keyboard press is dispatched to whatever holds focus, and turns into a click only on an enabled button.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"

import type { createHarness as CreateHarness } from "./fixtures/controller-harness"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Harness = ReturnType<typeof CreateHarness>

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("investor keyboard focus: busy buttons keep focus and View lands on the detail heading (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t: TestContext) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent, InputEvent: w.InputEvent, CustomEvent: w.CustomEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const fixup = new w.MutationObserver(() => {
    const active = w.document.activeElement as HTMLButtonElement | null
    if (!active || active === w.document.body || !active.disabled) return
    // jsdom ignores blur() on a disabled element: lift the attribute for the blur only (React's DOM value is restored),
    // and drop the records of that toggle so it does not re-trigger this observer.
    active.removeAttribute("disabled")
    active.blur()
    active.setAttribute("disabled", "")
    fixup.takeRecords()
  })
  fixup.observe(w.document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] })
  let cleanups: (() => unknown)[] = []
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { GiwaStocksFeature } = (await import("./GiwaStocksFeature")) as AnyModule
    const { createHarness, WALLET_A } = (await import("./fixtures/controller-harness")) as typeof import("./fixtures/controller-harness")
    const { act, createElement: el, StrictMode } = React
    const inputValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
    // Elements are compared by identity and described by hand: an assert diff would inspect the whole jsdom object graph.
    const describe = (node: Element | null) => (node === null ? "nothing" : `<${node.tagName.toLowerCase()}${node.id ? ` id="${node.id}"` : ""}> "${(node.textContent ?? "").slice(0, 40)}"`)
    const assertFocus = (expected: Element | null, message: string) =>
      assert.ok(expected !== null && w.document.activeElement === expected, `${message}: focus is on ${describe(w.document.activeElement)}, expected ${describe(expected)}`)

    async function mount(deploymentId: string, statusPollMs = 0) {
      // A deployment per scenario: the feature's page-lifetime attempt registry is keyed by API base, deployment and wallet.
      const stocks: Harness = createHarness({ deploymentId })
      const session = stocks.session(WALLET_A)
      const element: HTMLElement = w.document.createElement("div")
      w.document.body.append(element)
      const root = createRoot(element)
      await act(async () => {
        root.render(el(StrictMode, null, el(GiwaStocksFeature, { client: stocks.client, session, statusPollMs })))
        await sleep(0)
      })
      let mounted = true
      const page = {
        stocks,
        element,
        text: () => element.textContent ?? "",
        active: () => w.document.activeElement,
        async unmount() {
          if (!mounted) return
          mounted = false
          await act(async () => root.unmount())
          element.remove()
        },
        async waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
          const end = Date.now() + timeoutMs
          for (;;) {
            const value = read()
            if (value) return value
            if (Date.now() > end) throw new Error(`timed out waiting for ${label}; text=${page.text().slice(0, 1200)}`)
            await act(async () => sleep(10))
          }
        },
        async settle(ms: number) {
          await act(async () => sleep(ms))
        },
        button(label: string, scope: ParentNode = element): HTMLButtonElement | null {
          return ([...scope.querySelectorAll("button")] as HTMLButtonElement[]).find((button) => button.textContent === label) ?? null
        },
        /** Pointer-free activation of an element that already holds focus (the press goes to document.activeElement). */
        async press(key: "Enter" | " ") {
          await act(async () => {
            const target = (w.document.activeElement ?? w.document.body) as HTMLElement
            target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
            if (target instanceof w.HTMLButtonElement && !(target as HTMLButtonElement).disabled) target.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
            target.dispatchEvent(new w.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
            await sleep(0)
          })
        },
        async focus<T extends HTMLElement>(target: T | null, label: string): Promise<T> {
          assert.ok(target, `missing ${label}`)
          await act(async () => target.focus())
          assertFocus(target, `${label} holds focus`)
          return target
        },
        async ready() {
          await page.waitFor(() => element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "verified session")
          return page.waitFor(() => element.querySelector<HTMLButtonElement>('button[aria-label="View NVDA"]'), "View NVDA")
        },
        async openDetail() {
          await page.focus(await page.ready(), "View NVDA")
          await page.press("Enter")
          await page.waitFor(() => element.querySelector("#giwa-stocks-detail-title"), "detail heading")
        },
        async quote(quantity = "1") {
          const input = await page.waitFor(() => element.querySelector<HTMLInputElement>('input[inputmode="decimal"]'), "quantity input")
          await act(async () => {
            inputValue.call(input, quantity)
            input.dispatchEvent(new w.Event("input", { bubbles: true }))
          })
          await page.waitFor(() => page.button("Get quote") && !page.button("Get quote")!.disabled, "Get quote enabled")
          await act(async () => {
            page.button("Get quote")!.click()
            await sleep(0)
          })
          return page.waitFor(() => page.button("Place buy order"), "Place buy order")
        },
        async placeOrder(quantity = "1") {
          const place = await page.quote(quantity)
          await act(async () => {
            place.click()
            await sleep(0)
          })
          return page.waitFor(() => element.querySelector<HTMLElement>('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), "accepted order card")
        },
      }
      cleanups.push(() => page.unmount())
      return page
    }

    const scenario = (name: string, fn: () => Promise<void>) =>
      t.test(name, async () => {
        cleanups = []
        try {
          await fn()
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup()
          cleanups = []
        }
      })

    const orderReads = (stocks: Harness, id: string) => stocks.requests("GET", `/api/v1/stocks/orders/${id}`).length

    await scenario("I8: View lands on the detail heading, with and without an accepted attempt; All stocks returns to the list heading", async () => {
      const page = await mount("focus-dom-view")
      await page.openDetail()
      assert.equal(page.active()?.id, "giwa-stocks-detail-title", "View → detail heading, not the quantity field")

      await page.focus(page.button("All stocks"), "All stocks")
      await page.press("Enter")
      await page.waitFor(() => page.element.querySelector("#giwa-stocks-list-title"), "list heading")
      assert.equal(page.active()?.id, "giwa-stocks-list-title", "All stocks → list heading")

      await page.openDetail()
      assert.equal(page.active()?.id, "giwa-stocks-detail-title")
      await page.placeOrder()
      await page.focus(page.button("All stocks"), "All stocks")
      await page.press("Enter")
      await page.waitFor(() => page.element.querySelector("#giwa-stocks-list-title"), "list heading")
      assert.equal(page.active()?.id, "giwa-stocks-list-title")
      await page.openDetail()
      assert.ok(page.element.querySelector('[data-testid="stocks-attempt-accepted"]'), "the accepted attempt is shown again")
      assert.equal(page.active()?.id, "giwa-stocks-detail-title", "View → detail heading, not the order card heading")

      // Unchanged: leaving the accepted attempt returns to the quantity field.
      await page.focus(page.button("Start a new order"), "Start a new order")
      await page.press("Enter")
      await page.waitFor(() => page.element.querySelector('input[inputmode="decimal"]'), "quantity input")
      assertFocus(page.element.querySelector('input[inputmode="decimal"]'), "Start a new order → quantity field")
    })

    await scenario("I3: Refresh status keeps focus while the order read is held; one read per activation", async () => {
      const page = await mount("focus-dom-refresh")
      await page.openDetail()
      const card = await page.placeOrder()
      const id = page.stocks.controls.orders()[0]!.id
      const refresh = await page.focus(page.button("Refresh status", card), "Refresh status")
      const before = orderReads(page.stocks, id)
      page.stocks.controls.holdNext("order-detail")
      await page.press("Enter")
      await page.waitFor(() => refresh.textContent === "Refreshing…", "Refreshing…")
      assertFocus(refresh, "focus stays on the busy button")
      assert.equal(refresh.disabled, false, "not natively disabled while busy")
      assert.equal(refresh.getAttribute("aria-disabled"), "true")
      assert.equal(refresh.getAttribute("aria-busy"), "true")
      await page.press("Enter")
      await page.press(" ")
      await act(async () => {
        refresh.click()
        await sleep(0)
      })
      await page.settle(50)
      assert.equal(orderReads(page.stocks, id), before + 1, "repeated activation while busy reads once")
      page.stocks.controls.releaseHeld("order-detail")
      await page.waitFor(() => refresh.textContent === "Refresh status", "Refresh status again")
      assertFocus(refresh, "focus is still on the button after the read")
      assert.equal(refresh.getAttribute("aria-disabled"), null)
      await page.press(" ")
      await page.waitFor(() => refresh.textContent === "Refresh status" && orderReads(page.stocks, id) === before + 2, "second read")
      assertFocus(refresh, "focus stays after the second read")
    })

    await scenario("I3: the automatic status poll does not take focus off Refresh status", async () => {
      const page = await mount("focus-dom-poll", 80)
      await page.openDetail()
      const card = await page.placeOrder()
      const id = page.stocks.controls.orders()[0]!.id
      const refresh = await page.focus(page.button("Refresh status", card), "Refresh status")
      page.stocks.controls.holdNext("order-detail")
      await page.waitFor(() => page.stocks.controls.heldCount() === 1 && refresh.textContent === "Refreshing…", "a held poll read")
      assertFocus(refresh, "focus stays on the button during the poll read")
      const reads = orderReads(page.stocks, id)
      await page.settle(300)
      assert.equal(orderReads(page.stocks, id), reads, "no further read while one is in flight")
      page.stocks.controls.releaseHeld("order-detail")
      await page.waitFor(() => refresh.textContent === "Refresh status", "Refresh status again")
      assertFocus(refresh, "focus stays after the poll read")
      assert.equal(page.stocks.requests("POST", "/api/v1/stocks/orders").length, 1, "polling only reads")
    })

    await scenario("I3: Check my orders and Retry same request stay focusable while checking; no second lookup or send", async () => {
      const page = await mount("focus-dom-check")
      await page.openDetail()
      const place = await page.quote()
      // A 500 with an unreadable body: the outcome is unknown and nothing was created.
      page.stocks.controls.failNext("order", 500, "<html>oops</html>")
      await act(async () => {
        place.click()
        await sleep(0)
      })
      await page.waitFor(() => page.button("Check my orders"), "unconfirmed attempt")
      const check = await page.focus(page.button("Check my orders"), "Check my orders")
      const retry = page.button("Retry same request")!
      const lookups = () => page.stocks.requests("GET", "/api/v1/stocks/orders").length
      const sends = () => page.stocks.requests("POST", "/api/v1/stocks/orders").length
      const before = { lookups: lookups(), sends: sends() }
      page.stocks.controls.holdNext("orders")
      await page.press("Enter")
      await page.waitFor(() => check.textContent === "Checking…", "Checking…")
      assertFocus(check, "focus stays on Check my orders")
      assert.equal(check.disabled, false)
      assert.equal(check.getAttribute("aria-disabled"), "true")
      assert.equal(check.getAttribute("aria-busy"), "true")
      assert.equal(retry.disabled, false)
      assert.equal(retry.getAttribute("aria-disabled"), "true")
      await page.press("Enter")
      await act(async () => {
        check.click()
        retry.click()
        await sleep(0)
      })
      await page.settle(50)
      assert.deepEqual({ lookups: lookups(), sends: sends() }, { lookups: before.lookups + 1, sends: before.sends }, "one lookup, no send while checking")
      page.stocks.controls.releaseHeld("orders")
      await page.waitFor(() => check.textContent === "Check my orders", "Check my orders again")
      assert.match(page.text(), /This request was not found in your latest orders\./)
      assertFocus(check, "focus stays after the lookup")
      assert.equal(check.getAttribute("aria-disabled"), null)
      assert.equal(retry.getAttribute("aria-disabled"), null)
      assert.equal(retry.disabled, false)
      assert.equal(sends(), before.sends, "nothing is resent automatically")
    })

    await scenario("I3: Orders and Portfolio Refresh keep focus while loading and read once per activation", async () => {
      const page = await mount("focus-dom-lists")
      await page.ready()
      for (const [tab, route, path, title] of [
        ["orders", "orders", "/api/v1/stocks/orders", "giwa-stocks-orders-title"],
        ["portfolio", "portfolio", "/api/v1/stocks/portfolio", "giwa-stocks-portfolio-title"],
      ] as const) {
        await act(async () => {
          page.element.querySelector<HTMLButtonElement>(`#giwa-stocks-tab-${tab}`)!.click()
          await sleep(0)
        })
        const section = await page.waitFor(() => page.element.querySelector(`[aria-labelledby="${title}"]`), `${tab} section`)
        const refresh = await page.waitFor(() => page.button("Refresh", section), `${tab} Refresh`)
        await page.focus(refresh, `${tab} Refresh`)
        const reads = () => page.stocks.requests("GET", path).length
        const before = reads()
        page.stocks.controls.holdNext(route)
        await page.press("Enter")
        await page.waitFor(() => refresh.textContent === "Loading…", `${tab} Loading…`)
        assertFocus(refresh, `${tab}: focus stays on the busy button`)
        assert.equal(refresh.disabled, false)
        assert.equal(refresh.getAttribute("aria-disabled"), "true")
        assert.equal(refresh.getAttribute("aria-busy"), "true")
        await page.press("Enter")
        await page.press(" ")
        await act(async () => {
          refresh.click()
          await sleep(0)
        })
        await page.settle(50)
        assert.equal(reads(), before + 1, `${tab}: one read while loading`)
        page.stocks.controls.releaseHeld(route)
        await page.waitFor(() => refresh.textContent === "Refresh", `${tab} Refresh again`)
        assertFocus(refresh, `${tab}: focus stays after the read`)
        assert.equal(refresh.getAttribute("aria-disabled"), null)
      }
    })
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    fixup.disconnect()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
