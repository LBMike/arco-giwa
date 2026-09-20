// Mobile NVDA trade: the summary card, the fixed Buy / Sell dock and the bottom sheet holding THE trade panel, in the REAL
// investor feature (GiwaStocksFeature in React DOM + StrictMode) over the TEST-ONLY fake Stocks server. No socket, wallet,
// key or signature. jsdom has no matchMedia: it is stubbed here (mobile first, switchable to desktop).
//
// Gated like focus.dom.test.tsx: set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json. jsdom globals are installed
// BEFORE react-dom and the feature modules are imported (dynamic imports inside the gated body).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"

import type { GiwaStocksAccess } from "./access"
import type { createHarness as CreateHarness } from "./fixtures/controller-harness"
import type { GiwaStocksSession } from "./types"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Harness = ReturnType<typeof CreateHarness>

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const DESKTOP = "(min-width: 1024px)"
/** StocksViews' DOCK_SPACE: the room the shell reserves after its footer while the NVDA dock is mounted. */
const DOCK_SPACE = "calc(env(safe-area-inset-bottom) + 4.5rem)"

test("mobile NVDA trade: dock, bottom sheet and one trade panel (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t: TestContext) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  // matchMedia stub: only the lg query can match; `setDesktop` flips it and notifies the listeners like a resize would.
  let desktop = false
  const listeners = new Set<(event: { matches: boolean; media: string }) => void>()
  w.matchMedia = (media: string) => ({
    media,
    get matches() {
      return media === DESKTOP && desktop
    },
    onchange: null,
    addEventListener: (_type: string, listener: (event: { matches: boolean; media: string }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean; media: string }) => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent, InputEvent: w.InputEvent, CustomEvent: w.CustomEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let cleanups: (() => unknown)[] = []
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { GiwaStocksFeature } = (await import("./GiwaStocksFeature")) as AnyModule
    const { createHarness, WALLET_A } = (await import("./fixtures/controller-harness")) as typeof import("./fixtures/controller-harness")
    const { act, createElement: el, StrictMode } = React
    const inputValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
    const doc: Document = w.document
    const describe = (node: Element | null) => (node === null ? "nothing" : `<${node.tagName.toLowerCase()}${node.id ? ` id="${node.id}"` : ""}${node.getAttribute("aria-label") ? ` aria-label="${node.getAttribute("aria-label")}"` : ""}> "${(node.textContent ?? "").slice(0, 40)}"`)
    const assertFocus = (expected: Element | null | undefined, message: string) =>
      assert.ok(expected && doc.activeElement === expected, `${message}: focus is on ${describe(doc.activeElement)}, expected ${describe(expected ?? null)}`)

    async function setDesktop(value: boolean) {
      desktop = value
      await act(async () => {
        for (const listener of [...listeners]) listener({ matches: value, media: DESKTOP })
        await sleep(0)
      })
    }

    type Commit = { detailOpen: boolean; panels: number; dock: number; selected: string | null }
    /** Records the DOM of every commit that changes the controlled detail (a sibling after the feature: its layout effect
     * runs once that commit's DOM is in place, before anything later can adjust it). */
    function Probe({ detailOpen, element, commits }: { detailOpen: boolean; element: HTMLElement; commits: Commit[] }) {
      React.useLayoutEffect(() => {
        commits.push({
          detailOpen,
          panels: doc.querySelectorAll('[data-testid="stocks-trade-panel"]').length,
          dock: element.querySelectorAll(".fixed.inset-x-0.bottom-0").length,
          selected: element.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null,
        })
      }, [detailOpen])
      return null
    }

    async function mount(deploymentId: string, options: { holding?: string; signedOut?: boolean; detailOpen?: boolean; deviceClock?: boolean } = {}) {
      // A deployment per scenario: the feature's page-lifetime attempt registry is keyed by API base, deployment and wallet.
      const stocks: Harness = createHarness({ deploymentId })
      if (options.holding) stocks.controls.setHolding(WALLET_A, options.holding)
      const calls = { connect: 0, switchNetwork: 0, signIn: 0 }
      const commands = { signIn: () => void (calls.signIn += 1), connectWallet: () => void (calls.connect += 1), switchNetwork: () => void (calls.switchNetwork += 1) }
      const signedIn: GiwaStocksAccess = { wallet: "ready", host: "authenticated", hostError: null, canSignIn: false, ...commands }
      const signedOut: GiwaStocksAccess = { wallet: "ready", host: "signed-out", hostError: null, canSignIn: true, ...commands }
      // Current props; `update` re-renders with new ones (a host session change, or the page opening its detail).
      let props: { session: GiwaStocksSession; access: GiwaStocksAccess; detailOpen?: boolean } = options.signedOut
        ? { session: { status: "signed-out" }, access: signedOut }
        : { session: stocks.session(WALLET_A), access: signedIn }
      const commits: Commit[] = []
      // Optional device clock for quote deadlines (the feature's own `now`), advanced by `advanceDevice`.
      let deviceNow = 1_000_000
      const clock = options.deviceClock ? { now: () => deviceNow } : {}
      if (options.detailOpen !== undefined) props.detailOpen = options.detailOpen
      const element: HTMLElement = doc.createElement("div")
      doc.body.append(element)
      const root = createRoot(element)
      const tree = () =>
        el(
          StrictMode,
          null,
          el(GiwaStocksFeature, {
            client: stocks.client,
            session: props.session,
            statusPollMs: 0,
            access: props.access,
            ...clock,
            // The page's own open/close (inside the user's event, already in act): re-render with the new detail state.
            ...(props.detailOpen === undefined
              ? {}
              : {
                  detailOpen: props.detailOpen,
                  onDetailChange: (open: boolean) => {
                    props = { ...props, detailOpen: open }
                    current.render(tree())
                  },
                }),
          }),
          props.detailOpen === undefined ? null : el(Probe, { detailOpen: props.detailOpen, element, commits }),
        )
      await act(async () => {
        root.render(tree())
        await sleep(0)
      })
      let mounted = true
      let current = root
      const page = {
        stocks,
        calls,
        element,
        commits,
        signedIn,
        async update(next: Partial<typeof props>) {
          props = { ...props, ...next }
          await act(async () => {
            current.render(tree())
            await sleep(0)
          })
        },
        advanceDevice(ms: number) {
          deviceNow += ms
        },
        selectedTab: () => element.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null,
        panels: () => doc.querySelectorAll('[data-testid="stocks-trade-panel"]').length,
        /** Trade status live regions: the panel's own and the mobile summary's (at most one exists at a time). */
        statusRegions: () => ({
          panel: [...doc.querySelectorAll('[data-testid="stocks-trade-status"]')] as HTMLElement[],
          summary: [...doc.querySelectorAll('[data-testid="stocks-trade-summary-status"]')] as HTMLElement[],
        }),
        scrollPadding: () => doc.documentElement.style.getPropertyValue("scroll-padding-bottom"),
        /** The room the shell reserves after its footer while the dock is mounted (GiwaPreprodApp reads this). */
        dockSpace: () => doc.documentElement.style.getPropertyValue("--giwa-dock-space"),
        /** The side the one mounted trade panel shows as chosen. */
        side: () => (["BUY", "SELL"] as const).find((side) => doc.querySelector(`[data-side="${side}"]`)?.getAttribute("aria-checked") === "true") ?? null,
        async unmount() {
          if (!mounted) return
          mounted = false
          await act(async () => root.unmount())
          element.remove()
        },
        async remount() {
          await act(async () => root.unmount())
          const next = createRoot(element)
          current = next
          await act(async () => {
            next.render(tree())
            await sleep(0)
          })
          page.unmount = async () => {
            if (!mounted) return
            mounted = false
            await act(async () => next.unmount())
            element.remove()
          }
        },
        async waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
          const end = Date.now() + timeoutMs
          for (;;) {
            const value = read()
            if (value) return value
            if (Date.now() > end) throw new Error(`timed out waiting for ${label}; text=${(doc.body.textContent ?? "").slice(0, 1200)}`)
            await act(async () => sleep(10))
          }
        },
        async settle(ms: number) {
          await act(async () => sleep(ms))
        },
        /** A button in the page or in the portaled sheet, by its exact text. */
        button(label: string, scope: ParentNode = doc.body): HTMLButtonElement | null {
          return ([...scope.querySelectorAll("button")] as HTMLButtonElement[]).find((button) => button.textContent === label) ?? null
        },
        /** The fixed dock's buttons (the side radios of an inline panel are also named Buy / Sell). */
        dock: () => {
          const bar = element.querySelector<HTMLElement>(".fixed.inset-x-0.bottom-0")
          return bar === null ? { bar, buy: null, sell: null, view: null } : { bar, buy: page.button("Buy", bar), sell: page.button("Sell", bar), view: page.button("View order", bar) }
        },
        sheet: () => doc.querySelector<HTMLElement>('[role="dialog"][aria-label="Trade NVDA"]'),
        inputs: () => doc.querySelectorAll('input[inputmode="decimal"]').length,
        posts: () => stocks.server.controls.requests.filter((request) => request.method === "POST").length,
        portfolioReads: () => stocks.requests("GET", "/api/v1/stocks/portfolio").length,
        /** Keyboard activation of a focused element (the press goes to document.activeElement). */
        async press(key: "Enter" | " " | "Escape" | "Tab", shiftKey = false) {
          let prevented = false
          await act(async () => {
            const target = (doc.activeElement ?? doc.body) as HTMLElement
            const down = new w.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
            target.dispatchEvent(down)
            prevented = down.defaultPrevented
            if ((key === "Enter" || key === " ") && target instanceof w.HTMLButtonElement && !(target as HTMLButtonElement).disabled) target.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
            target.dispatchEvent(new w.KeyboardEvent("keyup", { key, shiftKey, bubbles: true, cancelable: true }))
            await sleep(0)
          })
          return prevented
        },
        async activate(target: HTMLElement | null, label: string) {
          assert.ok(target, `missing ${label}`)
          await act(async () => target.focus())
          await page.press("Enter")
        },
        async click(target: HTMLElement | null, label: string) {
          assert.ok(target, `missing ${label}`)
          await act(async () => {
            target.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true }))
            target.click()
            await sleep(0)
          })
        },
        async type(value: string) {
          const input = await page.waitFor(() => doc.querySelector<HTMLInputElement>('input[inputmode="decimal"]'), "quantity input")
          await act(async () => {
            inputValue.call(input, value)
            input.dispatchEvent(new w.Event("input", { bubbles: true }))
          })
          return input
        },
        async openDetail() {
          await page.waitFor(() => element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "verified session")
          await page.activate(await page.waitFor(() => element.querySelector<HTMLButtonElement>('button[aria-label="View NVDA"]'), "View NVDA"), "View NVDA")
          await page.waitFor(() => element.querySelector("#giwa-stocks-detail-title"), "detail heading")
        },
        async closeSheet() {
          await page.activate(page.sheet()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]') ?? null, "Close")
          await page.waitFor(() => page.sheet() === null, "sheet unmounted after the slide-out")
        },
        async quote(quantity: string, place: string) {
          await page.type(quantity)
          await page.waitFor(() => page.button("Get quote") && !page.button("Get quote")!.disabled, "Get quote enabled")
          await page.click(page.button("Get quote"), "Get quote")
          return page.waitFor(() => page.button(place), place)
        },
      }
      cleanups.push(() => page.unmount())
      return page
    }

    const scenario = (name: string, fn: () => Promise<void>) =>
      t.test(name, async () => {
        cleanups = []
        desktop = false
        try {
          await fn()
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup()
          cleanups = []
          assert.equal(doc.body.style.overflow, "", "no scroll lock is left behind")
          assert.equal(doc.documentElement.style.getPropertyValue("scroll-padding-bottom"), "", "no dock scroll padding is left behind")
          assert.equal(doc.documentElement.style.getPropertyValue("--giwa-dock-space"), "", "no reserved dock space is left behind")
        }
      })

    await scenario("dock opens the sheet with the side preset; focus, Tab trap, other layers, Escape and focus return", async () => {
      const page = await mount("sheet-dom-keyboard", { holding: "1234500000000" })
      await page.openDetail()
      assert.equal(doc.activeElement?.id, "giwa-stocks-detail-title", "View → the mobile summary's detail title")
      assert.match(page.element.textContent ?? "", /Fixed mock price 120 ARCO_TEST_USDC \/ NVDA/)
      assert.equal(page.inputs(), 0, "no trade panel while the sheet is closed")
      assert.ok(page.sheet() === null)
      const { buy, sell } = page.dock()
      assert.ok(buy && sell, "Buy and Sell in the dock")
      for (const button of [buy, sell]) {
        assert.equal(button.hasAttribute("data-side"), false, "dock buttons carry no data-side")
        assert.equal(button.getAttribute("aria-expanded"), "false")
        assert.ok(button.getAttribute("aria-controls"))
      }
      assert.match(page.dock().bar?.className ?? "", /fixed inset-x-0 bottom-0 [^"]*lg:hidden/)
      assert.doesNotMatch(page.dock().bar?.className ?? "", /w-screen|100vw/)
      // No spacer portaled to <body> (html/body/#root are height:100%, so it never reached the end of the page).
      // Identity checks (an assert diff of a jsdom element would walk the whole DOM graph).
      assert.ok(doc.querySelector('[data-testid="stocks-dock-spacer"]') === null, "no body spacer")
      assert.ok(doc.body.lastElementChild === page.element, `nothing appended to <body> after the page: ${describe(doc.body.lastElementChild)}`)
      // The fixed dock's height is reserved for focus scrolling while it is mounted.
      assert.equal(page.scrollPadding(), "7rem", "scroll-padding-bottom while the dock is mounted")
      // ...and published for the page shell, which keeps that much room AFTER its footer (padding inside <main> cannot:
      // the footer comes after main and would stay under the fixed dock).
      assert.equal(page.dockSpace(), DOCK_SPACE, "the dock's height is reserved for the shell while it is mounted")
      const posts = page.posts()

      await page.activate(sell, "Sell")
      const sheet = await page.waitFor(() => page.sheet(), "sheet")
      assert.ok(!page.element.contains(sheet), "portaled to <body>")
      assert.equal(sheet.getAttribute("aria-modal"), "true")
      assert.equal(sheet.id, sell.getAttribute("aria-controls"))
      assert.equal(sell.getAttribute("aria-expanded"), "true")
      const close = sheet.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      assertFocus(close, "focus moves to Close")
      assert.equal(page.inputs(), 1, "exactly one quantity input")
      assert.equal(doc.querySelectorAll("[data-side]").length, 2)
      assert.equal(sheet.querySelector('[data-side="SELL"]')?.getAttribute("aria-checked"), "true", "Sell preset through the panel's own action")
      assert.equal(doc.body.style.overflow, "hidden")
      // Choosing Sell reads the portfolio once (the owner's effect), for the server's available quantity and MAX.
      await page.waitFor(() => /Available to sell: 1,234\.5 NVDA/.test(sheet.textContent ?? ""), "available to sell")
      assert.equal(page.portfolioReads(), 1)
      await page.click(page.button("MAX", sheet), "MAX")
      assert.equal(doc.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value, "1234.5", "MAX fills the exact quantity, ungrouped")

      // Tab / Shift+Tab wrap inside the sheet.
      const tabbable = [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      const last = tabbable[tabbable.length - 1]
      assert.ok(last && last !== close)
      await act(async () => last.focus())
      assert.equal(await page.press("Tab"), true)
      assertFocus(close, "Tab on the last control wraps to Close")
      assert.equal(await page.press("Tab", true), true)
      assertFocus(last, "Shift+Tab on Close wraps to the last control")

      // A layer opened on top (another aria-modal dialog) keeps its own keys.
      const layer = doc.createElement("div")
      layer.setAttribute("role", "dialog")
      layer.setAttribute("aria-modal", "true")
      const other = doc.createElement("button")
      other.textContent = "Other layer"
      layer.append(other)
      doc.body.append(layer)
      await act(async () => other.focus())
      assert.equal(await page.press("Tab"), false, "Tab is not trapped for another layer")
      assertFocus(other, "focus stays in the other layer")
      assert.equal(await page.press("Escape"), false)
      await page.settle(350)
      assert.ok(page.sheet(), "Escape in another layer does not close the sheet")
      layer.remove()

      await act(async () => close!.focus())
      await page.press("Escape")
      await page.waitFor(() => page.sheet() === null, "sheet closed by Escape")
      assertFocus(page.dock().sell, "focus returns to the dock button that opened the sheet")
      assert.equal(page.dock().sell?.getAttribute("aria-expanded"), "false")
      assert.equal(doc.body.style.overflow, "")
      assert.equal(page.inputs(), 0)
      assert.equal(page.posts(), posts, "opening and closing sent nothing")
      assert.deepEqual(page.calls, { connect: 0, switchNetwork: 0, signIn: 0 }, "no wallet or sign-in command")
    })

    await scenario("a quote survives crossing to desktop (the sheet closes, the inline panel shows the same state) and back", async () => {
      const page = await mount("sheet-dom-viewport")
      await page.openDetail()
      await page.activate(page.dock().buy, "Buy")
      const sheet = await page.waitFor(() => page.sheet(), "sheet")
      assert.equal(sheet.querySelector('[data-side="BUY"]')?.getAttribute("aria-checked"), "true")
      await page.quote("2", "Place buy order")
      assert.equal(page.posts(), 1, "one quote request")
      assert.equal(page.inputs(), 1)

      await setDesktop(true)
      assert.ok(page.sheet() === null, "the sheet closes at lg")
      assert.equal(doc.body.style.overflow, "", "scroll lock released")
      assert.equal(page.inputs(), 1, "exactly one input: the inline panel")
      assert.ok(page.element.contains(doc.querySelector('input[inputmode="decimal"]')), "inline, not in a sheet")
      assert.equal(doc.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value, "2", "same quantity")
      assert.ok(page.button("Place buy order", page.element), "same ready quote")
      assert.ok(page.dock().bar === null, "no dock at lg")
      assert.equal(page.scrollPadding(), "", "no dock, no reserved scroll padding")
      assert.equal(page.dockSpace(), "", "no dock, no reserved room after the footer")
      assert.equal(doc.querySelectorAll("#giwa-stocks-detail-title").length, 1)

      await setDesktop(false)
      assert.equal(page.scrollPadding(), "7rem")
      assert.equal(page.dockSpace(), DOCK_SPACE, "the dock is back: so is the room after the footer")
      assert.equal(page.inputs(), 0, "the sheet closed at lg stays closed below it")
      assert.match(page.element.textContent ?? "", /Next stepQuote ready: 240 ARCO_TEST_USDC for 2 NVDA/)
      assert.equal(doc.querySelectorAll("#giwa-stocks-detail-title").length, 1)

      // Tab switches with a quote on screen send nothing.
      const posts = page.posts()
      for (const tab of ["orders", "portfolio", "stocks"]) {
        await page.click(page.element.querySelector(`#giwa-stocks-tab-${tab}`), `${tab} tab`)
        assert.ok(page.inputs() <= 1)
      }
      assert.equal(page.posts(), posts, "no quote or order request from tab switches")
      assert.equal(page.stocks.requests("POST", "/api/v1/stocks/orders").length, 0)
    })

    await scenario("mid-attempt: closing and reopening the sheet (and a remount) keeps the accepted order without new POSTs", async () => {
      const page = await mount("sheet-dom-attempt")
      await page.openDetail()
      await page.activate(page.dock().buy, "Buy")
      await page.waitFor(() => page.sheet(), "sheet")
      const place = await page.quote("1", "Place buy order")
      await page.click(place, "Place buy order")
      await page.waitFor(() => page.sheet()?.querySelector('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), "accepted card in the sheet")
      const orders = () => page.stocks.requests("POST", "/api/v1/stocks/orders").length
      assert.equal(orders(), 1)
      const orderId = page.stocks.controls.orders()[0]!.id

      await page.closeSheet()
      assert.ok(page.dock().buy === null && page.dock().sell === null, "an accepted order: the dock only opens it")
      const view = page.dock().view
      assert.ok(view, "View order")
      assertFocus(view, "focus returns to the dock's current button")
      assert.match(page.element.textContent ?? "", /OrderOrder accepted · Awaiting funding/)

      for (let round = 0; round < 2; round += 1) {
        await page.activate(page.dock().view, "View order")
        const card = await page.waitFor(() => page.sheet()?.querySelector('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), "accepted card again")
        assert.match(card.getAttribute("aria-labelledby") ?? "", new RegExp(orderId))
        assert.equal(page.inputs(), 0, "no form while the order is shown")
        await page.closeSheet()
      }
      await page.remount()
      await page.waitFor(() => page.element.querySelector('button[aria-label="View NVDA"]'), "list after remount")
      await page.activate(page.element.querySelector('button[aria-label="View NVDA"]'), "View NVDA")
      await page.activate(await page.waitFor(() => page.dock().view, "View order after remount"), "View order")
      await page.waitFor(() => page.sheet()?.querySelector('[data-testid="stocks-attempt-accepted"]'), "the registry's accepted attempt")
      assert.equal(orders(), 1, "no new order request")
      assert.equal(page.stocks.controls.orders().length, 1)
    })

    await scenario("an accepted SELL refreshes the available quantity once", async () => {
      const page = await mount("sheet-dom-sell", { holding: "3000000000" })
      await page.openDetail()
      await page.activate(page.dock().sell, "Sell")
      const sheet = await page.waitFor(() => page.sheet(), "sheet")
      await page.waitFor(() => /Available to sell: 3 NVDA/.test(sheet.textContent ?? ""), "available 3")
      assert.equal(page.portfolioReads(), 1)
      const place = await page.quote("1", "Place sell order")
      await page.click(place, "Place sell order")
      await page.waitFor(() => page.sheet()?.querySelector('[data-testid="stocks-attempt-accepted"]'), "accepted SELL")
      await page.waitFor(() => page.portfolioReads() === 2, "one refresh after the acceptance")
      await page.settle(100)
      assert.equal(page.portfolioReads(), 2, "exactly once")
      await page.closeSheet()
      await page.activate(page.dock().view, "View order")
      await page.waitFor(() => page.sheet(), "sheet")
      await page.settle(50)
      assert.equal(page.portfolioReads(), 2, "reopening reads nothing")
    })
    await scenario("signing in from inside the sheet keeps the sheet open, with focus in it (the sheet's state is above the session switch)", async () => {
      const page = await mount("sheet-dom-sign-in", { signedOut: true })
      await page.activate(await page.waitFor(() => page.element.querySelector<HTMLButtonElement>('button[aria-label="View NVDA"]'), "View NVDA"), "View NVDA")
      await page.waitFor(() => page.element.querySelector("#giwa-stocks-detail-title"), "detail heading")
      await page.activate(page.dock().sell, "Sell")
      const before = await page.waitFor(() => page.sheet(), "sheet")
      assert.equal(page.side(), "SELL", "the dock's Sell chose the side before signing in")
      const posts = page.posts()
      const signIn = await page.waitFor(() => page.button("Sign in to trade", before), "Sign in to trade in the sheet")
      await page.click(signIn, "Sign in to trade")
      assert.equal(page.calls.signIn, 1, "the host's sign-in, from the user's click")
      // The host publishes the verified session: the feature swaps its detail for one render ("Updating session…").
      await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
      await page.waitFor(() => page.element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "verified session")
      await page.settle(50)
      const dialogs = doc.querySelectorAll('[role="dialog"]')
      assert.equal(dialogs.length, 1, "exactly one dialog: the sheet is still open")
      const sheet = page.sheet()
      assert.ok(sheet, "the Trade NVDA sheet")
      // A user who opened Sell is still selling: the new identity clears the form, but not the choice they just stated.
      assert.equal(page.side(), "SELL", "the side the user chose before signing in")
      assert.equal(page.posts(), posts, "signing in sends no quote and no order")
      assert.ok(page.button("Get quote", sheet), "the next step is in the sheet")
      assert.ok(sheet.contains(doc.activeElement), `focus is in the sheet, not on ${describe(doc.activeElement)}`)
      assert.equal(page.dock().buy?.getAttribute("aria-expanded"), "true")
      assert.equal(page.inputs(), 1, "one trade panel")
      assert.equal(doc.body.style.overflow, "hidden", "scroll lock kept")
      // Leaving the Stocks tab closes it for good: coming back does not reopen it.
      await page.click(page.element.querySelector("#giwa-stocks-tab-orders"), "Orders tab")
      await page.waitFor(() => page.sheet() === null, "sheet gone on Orders")
      await page.click(page.element.querySelector("#giwa-stocks-tab-stocks"), "Stocks tab")
      await page.settle(350)
      assert.ok(page.sheet() === null, "not reopened on return")
      assert.equal(page.dock().buy?.getAttribute("aria-expanded"), "false")
    })

    await scenario("the Sell chosen for a sign-in is kept through that one step only (and the holdings are then read)", async () => {
      /** Signed out, NVDA detail open, the dock's Sell chosen — the only way to state a side before signing in. */
      const noteSell = async (deploymentId: string, options: { holding?: string } = {}) => {
        const page = await mount(deploymentId, { signedOut: true, ...options })
        await page.activate(await page.waitFor(() => page.element.querySelector<HTMLButtonElement>('button[aria-label="View NVDA"]'), "View NVDA"), "View NVDA")
        await page.waitFor(() => page.element.querySelector("#giwa-stocks-detail-title"), "detail heading")
        await page.activate(page.dock().sell, "Sell")
        const sheet = await page.waitFor(() => page.sheet(), "sheet")
        assert.equal(page.side(), "SELL", `${deploymentId}: the dock's Sell chose the side`)
        return { page, sheet }
      }
      /** The inline panel at lg shows the side without a dock press of its own (the dock's buttons set it). */
      const sideAfterSignIn = async (page: Awaited<ReturnType<typeof mount>>) => {
        await setDesktop(true)
        await page.waitFor(() => page.button("Get quote", page.element), "the signed-in form")
        const side = page.side()
        await setDesktop(false)
        return side
      }

      // Kept: the user's own sign-in, the same view, the same wallet. The holdings of the wallet that just signed in are
      // read once for the Sell form, and the next quote the user asks for is a SELL quote.
      {
        const { page, sheet } = await noteSell("sheet-dom-intent-kept", { holding: "2000000000" })
        await page.click(await page.waitFor(() => page.button("Sign in to trade", sheet), "Sign in to trade"), "Sign in to trade")
        const posts = page.posts()
        await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
        await page.waitFor(() => page.button("Get quote"), "the form after signing in")
        assert.equal(page.side(), "SELL", "still selling")
        await page.waitFor(() => page.portfolioReads() === 1, "the Sell form reads the holdings of the wallet that signed in")
        await page.settle(120)
        assert.equal(page.portfolioReads(), 1, "exactly once")
        assert.equal(page.posts(), posts, "signing in and rendering send no quote and no order")
        await page.quote("1", "Place sell order")
        assert.equal(page.stocks.requests("POST", "/api/v1/stocks/orders").length, 0, "no order was placed")
        await page.unmount()
      }
      // Dropped: the user left the trade view before the sign-in landed.
      {
        const { page, sheet } = await noteSell("sheet-dom-intent-left")
        await page.click(await page.waitFor(() => page.button("Sign in to trade", sheet), "Sign in to trade"), "Sign in to trade")
        await page.click(page.element.querySelector("#giwa-stocks-tab-orders"), "Orders tab")
        await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
        await page.click(page.element.querySelector("#giwa-stocks-tab-stocks"), "Stocks tab")
        assert.equal(await sideAfterSignIn(page), "BUY", "a sign-in that lands after the user left the trade view starts on Buy")
        await page.unmount()
      }
      // Dropped: the connected wallet went away while the sign-in was running.
      {
        const { page, sheet } = await noteSell("sheet-dom-intent-wallet")
        await page.click(await page.waitFor(() => page.button("Sign in to trade", sheet), "Sign in to trade"), "Sign in to trade")
        await page.update({ access: { ...page.signedIn, wallet: "disconnected", host: "signed-out", canSignIn: false } })
        await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
        assert.equal(await sideAfterSignIn(page), "BUY", "no connected wallet, no kept side")
        await page.unmount()
      }
      // Dropped: nothing in the panel started this sign-in (the page's own sign-in region, or a session restored elsewhere).
      {
        const { page } = await noteSell("sheet-dom-intent-elsewhere")
        await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
        assert.equal(page.calls.signIn, 0, "the panel never asked for a sign-in")
        assert.equal(await sideAfterSignIn(page), "BUY", "a session the panel did not ask for starts on Buy")
        await page.unmount()
      }
      // Dropped: the host reported the sign-in as failed. Pressing sign-in again notes it afresh, and that one is kept.
      {
        {
          const { page, sheet } = await noteSell("sheet-dom-intent-failed")
          await page.click(await page.waitFor(() => page.button("Sign in to trade", sheet), "Sign in to trade"), "Sign in to trade")
          await page.update({ access: { ...page.signedIn, host: "error", hostError: null, canSignIn: true } })
          assert.equal(page.side(), "SELL", "a failed sign-in changes nothing on screen")
          await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
          assert.equal(await sideAfterSignIn(page), "BUY", "a session that lands after a failed sign-in starts on Buy")
          await page.unmount()
        }
        {
          const { page, sheet } = await noteSell("sheet-dom-intent-retry")
          await page.click(await page.waitFor(() => page.button("Sign in to trade", sheet), "Sign in to trade"), "Sign in to trade")
          await page.update({ access: { ...page.signedIn, host: "error", hostError: null, canSignIn: true } })
          await page.click(await page.waitFor(() => page.button("Sign in to trade", page.sheet() ?? doc.body), "Sign in to trade again"), "Sign in to trade")
          assert.equal(page.calls.signIn, 2, "two presses, two host sign-ins")
          await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
          await page.waitFor(() => page.button("Get quote"), "the form after signing in")
          assert.equal(page.side(), "SELL", "the fresh press kept the side")
          await page.unmount()
        }
      }
      // The side that is kept is the one on screen when the sign-in lands, not a copy taken at the press: a Buy chosen
      // after pressing sign-in (the dock's buttons work while signed out) is the user's last word.
      {
        const { page, sheet } = await noteSell("sheet-dom-intent-changed-mind")
        await page.click(await page.waitFor(() => page.button("Sign in to trade", sheet), "Sign in to trade"), "Sign in to trade")
        await page.activate(page.sheet()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]') ?? null, "Close")
        await page.waitFor(() => page.sheet() === null, "sheet closed")
        await page.activate(page.dock().buy, "Buy")
        await page.waitFor(() => page.sheet(), "sheet reopened on Buy")
        assert.equal(page.side(), "BUY", "the dock's Buy changed the user's mind")
        await page.update({ session: page.stocks.session(WALLET_A), access: page.signedIn })
        await page.waitFor(() => page.button("Get quote"), "the form after signing in")
        assert.equal(page.side(), "BUY", "the later choice wins over the earlier sign-in press")
        await page.unmount()
      }
      // Unchanged: already signed in, the host issues a new token for the same wallet. That is not a sign-in the user
      // started from the panel, so the new identity starts on Buy exactly as before.
      {
        await setDesktop(true)
        const page = await mount("sheet-dom-intent-refresh")
        await page.openDetail()
        await page.click(page.element.querySelector('[data-side="SELL"]'), "Sell")
        assert.equal(page.side(), "SELL", "signed in, the panel's own Sell")
        await page.update({ session: page.stocks.session(WALLET_A, true) })
        await page.waitFor(() => page.button("Get quote", page.element), "the form under the new token")
        assert.equal(page.side(), "BUY", "a refreshed token still clears the form")
        await page.unmount()
        await setDesktop(false)
      }
    })

    await scenario("with the sheet closed, one polite summary line announces quote expiry and order results (never two status lines)", async () => {
      const page = await mount("sheet-dom-live", { deviceClock: true })
      // Every DOM change is checked: never both status lines (the sheet's panel and the summary's) at once.
      let most = 0
      const observer = new w.MutationObserver(() => {
        const { panel, summary } = page.statusRegions()
        most = Math.max(most, panel.length + summary.length)
      })
      observer.observe(doc.body, { subtree: true, childList: true })
      cleanups.push(() => observer.disconnect())
      await page.openDetail()
      let regions = page.statusRegions()
      assert.deepEqual([regions.panel.length, regions.summary.length], [0, 1], "sheet closed: the summary's line only")
      assert.equal(regions.summary[0].getAttribute("aria-live"), "polite")
      assert.match(regions.summary[0].className, /(^| )sr-only( |$)/)
      await page.activate(page.dock().buy, "Buy")
      const sheet = await page.waitFor(() => page.sheet(), "sheet")
      regions = page.statusRegions()
      assert.deepEqual([regions.panel.length, regions.summary.length], [1, 0], "sheet open: the panel's line only")
      await page.quote("1", "Place buy order")
      assert.match(page.statusRegions().panel[0].textContent ?? "", /^Quote ready: 120 test cash for 1 NVDA\.$/)
      await act(async () => sheet.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.focus())
      await page.press("Escape")
      regions = page.statusRegions()
      assert.equal(regions.panel.length + regions.summary.length, 1, "during the slide-out: still one line")
      await page.waitFor(() => page.sheet() === null, "sheet unmounted")
      regions = page.statusRegions()
      assert.deepEqual([regions.panel.length, regions.summary.length], [0, 1], "sheet closed again: the summary's line")
      const summary = regions.summary[0]
      assert.equal(summary.textContent, "Quote ready: 120 test cash for 1 NVDA.")
      // The quote runs out while the sheet is closed (device clock; the feature's 1 s tick notices it).
      page.advanceDevice(61_000)
      await page.waitFor(() => summary.isConnected && summary.textContent === "Quote expired. No order was placed.", "expiry announced in the summary", 3_000)
      assert.match(page.element.textContent ?? "", /Next stepQuote expired\. No order was placed\./)
      assert.equal(most, 1, "never two status lines at once")
      assert.ok(doc.querySelector('[data-testid="stocks-dock-spacer"]') === null, "no body spacer")
    })

    await scenario("a detail opened from outside lands on the Stocks tab in the same commit; the user's own tab choice while it is open is kept", async () => {
      desktop = true
      const page = await mount("sheet-dom-controlled", { detailOpen: false })
      await page.waitFor(() => page.element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "verified session")
      // View NVDA in the page-owned detail: the page opens it; focus lands on the trade heading, aligned to the top of the
      // viewport (not centred), so the quantity field and the next-step action are on screen. jsdom has no layout:
      // scrollIntoView and focus options are recorded.
      const scrolls: { id: string; options: unknown }[] = []
      const focuses: { id: string; options: unknown }[] = []
      const scrollIntoView = w.Element.prototype.scrollIntoView
      const focus = w.HTMLElement.prototype.focus
      w.Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
        scrolls.push({ id: this.id, options })
      }
      w.HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
        focuses.push({ id: this.id, options })
        return focus.call(this, options)
      }
      cleanups.push(() => {
        w.Element.prototype.scrollIntoView = scrollIntoView
        w.HTMLElement.prototype.focus = focus
      })
      await page.activate(await page.waitFor(() => page.element.querySelector<HTMLButtonElement>('button[aria-label="View NVDA"]'), "View NVDA"), "View NVDA")
      assert.equal(doc.activeElement?.id, "giwa-stocks-detail-title")
      assert.deepEqual(focuses.filter((entry) => entry.id === "giwa-stocks-detail-title"), [{ id: "giwa-stocks-detail-title", options: { preventScroll: true } }])
      assert.deepEqual(scrolls, [{ id: "giwa-stocks-detail-title", options: { block: "start", behavior: "smooth" } }])
      await page.update({ detailOpen: false })
      await page.click(page.element.querySelector("#giwa-stocks-tab-orders"), "Orders tab")
      assert.equal(page.selectedTab(), "giwa-stocks-tab-orders")
      // The page opens the detail (a market row): the trade panel is in the very commit that opens it.
      page.commits.length = 0
      await page.update({ detailOpen: true })
      assert.deepEqual(page.commits[0], { detailOpen: true, panels: 1, dock: 0, selected: "giwa-stocks-tab-stocks" }, JSON.stringify(page.commits))
      assert.equal(page.selectedTab(), "giwa-stocks-tab-stocks")
      assert.equal(page.inputs(), 1)
      // While it stays open, Orders is the user's choice: kept, and the trade panel is unmounted.
      await page.click(page.element.querySelector("#giwa-stocks-tab-orders"), "Orders tab")
      await page.update({ detailOpen: true })
      await page.settle(50)
      assert.equal(page.selectedTab(), "giwa-stocks-tab-orders", "not forced back while the detail stays open")
      assert.equal(page.panels(), 0)
      // Below lg: closed → Portfolio → reopened from outside shows the dock in the same commit.
      await page.update({ detailOpen: false })
      await page.click(page.element.querySelector("#giwa-stocks-tab-portfolio"), "Portfolio tab")
      await setDesktop(false)
      page.commits.length = 0
      await page.update({ detailOpen: true })
      assert.deepEqual(page.commits[0], { detailOpen: true, panels: 0, dock: 1, selected: "giwa-stocks-tab-stocks" }, JSON.stringify(page.commits))
      assert.ok(page.dock().buy && page.dock().sell)
    })

    await scenario("the Sell form re-reads the portfolio each time the user brings it into view; a finished read starts nothing", async () => {
      desktop = true
      const page = await mount("sheet-dom-sell-reread", { holding: "3000000000" })
      await page.openDetail()
      const side = (value: "BUY" | "SELL") => page.element.querySelector<HTMLButtonElement>(`[data-side="${value}"]`)
      await page.click(side("SELL"), "Sell")
      await page.waitFor(() => /Available to sell: 3 NVDA/.test(page.element.textContent ?? ""), "available 3")
      assert.equal(page.portfolioReads(), 1)
      await page.click(side("BUY"), "Buy")
      page.stocks.controls.setHolding(WALLET_A, "5000000000")
      await page.settle(50)
      assert.equal(page.portfolioReads(), 1, "Buy reads nothing")
      await page.click(side("SELL"), "Sell again")
      await page.waitFor(() => /Available to sell: 5 NVDA/.test(page.element.textContent ?? ""), "available 5 after choosing Sell again")
      await page.settle(150)
      assert.equal(page.portfolioReads(), 2, "one read per choice, no loop")
      // A refused sell returns to the form on Sell: read again (the refusal was about availability).
      page.stocks.controls.setHolding(WALLET_A, "4000000000")
      const place = await page.quote("6", "Place sell order")
      await page.click(place, "Place sell order")
      await page.waitFor(() => page.element.querySelector('[data-testid="stocks-attempt-rejected"]'), "refused sell")
      await page.waitFor(() => /Available to sell: 4 NVDA/.test(page.element.textContent ?? ""), "available 4 after the refusal")
      await page.settle(150)
      assert.equal(page.portfolioReads(), 3)
      // Editing after the refusal clears it while the form stays in view: not a new appearance, no read.
      await page.type("1")
      await page.settle(150)
      assert.equal(page.portfolioReads(), 3, "editing after a refusal reads nothing")
      // An accepted sell reads once (its reservation); Start a new order back on Sell reads once more.
      const again = await page.quote("1", "Place sell order")
      await page.click(again, "Place sell order")
      await page.waitFor(() => page.element.querySelector('[data-testid="stocks-attempt-accepted"]'), "accepted sell")
      await page.waitFor(() => page.portfolioReads() === 4, "read after acceptance")
      await page.click(page.button("Start a new order"), "Start a new order")
      await page.waitFor(() => page.portfolioReads() === 5, "read when the Sell form is back")
      await page.settle(150)
      assert.equal(page.portfolioReads(), 5, "exactly once")
      assert.equal(side("SELL")?.getAttribute("aria-checked"), "true")
    })
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
