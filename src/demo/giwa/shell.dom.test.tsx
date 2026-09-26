import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
// GiwaPreprodApp and ./wallet are imported inside the test, after the fetch guard below is installed (see there).

// No dependency added: opt into the already-installed DOM runtime for this integration gate.
// jsdom has no media queries, so both the xl sidebar and the below-xl drawer are in the DOM; the
// assertions cover behaviour (focus, keyboard, routing), not which one CSS shows.
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("investor shell DOM (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example/", pretendToBeVisual: true })
  // Everything this shell renders comes from the seeded query cache: any app network read is a failure (fetchCalls).
  // One third-party request is expected and answered offline: loading the Dynamic SDK (./wallet imports it) starts a
  // wallet-book CDN fetch at module evaluation (@dynamic-labs/wallet-book hooks/useWalletBookCdn.js: "Initiate wallet
  // book fetch immediately"), retries it and then uses its bundled fallback list. Only that exact URL gets a 503 stub and
  // is counted apart (sdkAssetCalls); nothing leaves the process. The app modules are imported after this guard is
  // installed, so the request can no longer reach the real network or land at an arbitrary point of a leaf test.
  const DYNAMIC_WALLET_BOOK = "https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json"
  const fetchCalls: string[] = []
  const sdkAssetCalls: string[] = []
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input)
      if (url === DYNAMIC_WALLET_BOOK) { sdkAssetCalls.push(url); return new Response(null, { status: 503, statusText: "offline test stub" }) }
      fetchCalls.push(url)
      throw new Error("network disabled in shell DOM test")
    }) as typeof fetch,
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  const { GiwaPreprodApp } = await import("./GiwaPreprodApp")
  const { GiwaWalletProvider } = await import("./wallet")
  t.after(() => { t.diagnostic(`Dynamic wallet-book requests answered offline: ${sdkAssetCalls.length}; other requests: ${fetchCalls.length}`) })

  async function mount(path: string) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(["giwa", "catalog"], [])
    const probe: { pathname: string; navigate: NavigateFunction | null } = { pathname: "", navigate: null }
    function Probe() { probe.pathname = useLocation().pathname; probe.navigate = useNavigate(); return null }
    await act(async () => {
      root.render(<StrictMode><QueryClientProvider client={client}><GiwaWalletProvider><MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes><Route element={<GiwaPreprodApp />}><Route path="*" element={<p>page body</p>} /></Route></Routes>
      </MemoryRouter></GiwaWalletProvider></QueryClientProvider></StrictMode>)
      await flush()
    })
    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!
    const dialogId = trigger.getAttribute("aria-controls")!
    return {
      element, probe, trigger, dialogId,
      sidebar: () => element.querySelector<HTMLElement>('aside nav[aria-label="Main"]')!,
      dialog: () => document.getElementById(dialogId),
      async go(to: string) { await act(async () => { probe.navigate!(to); await flush() }) },
      async open() { await act(async () => { trigger.click(); await flush(); await sleep(40) }) },
      async settle() { await act(async () => { await sleep(350) }) },
      async unmount() { await act(async () => root.unmount()); element.remove() },
    }
  }
  function key(target: Element, name: string, shiftKey = false) {
    const event = new dom.window.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })
    act(() => { target.dispatchEvent(event) })
    return event
  }
  function currentLabels(scope: Element) {
    return [...scope.querySelectorAll('[aria-current="page"]')].map(node => node.textContent?.trim())
  }

  await t.test("sidebar links carry aria-current for the active route; no Send row", async () => {
    const m = await mount("/funds")
    const cases: Array<[string, string]> = [["/funds", "Funds"], ["/product/abc", "Funds"], ["/stocks", "Stocks"], ["/admin/stocks", "Stocks"], ["/", "Home"], ["/savings", "Savings"], ["/portfolio", "Portfolio"]]
    for (const [path, label] of cases) {
      await m.go(path)
      assert.deepEqual(currentLabels(m.sidebar()), [label], path)
      assert.equal(m.sidebar().querySelector('[aria-current="page"]')!.tagName, "A", path)
    }
    assert.equal(m.sidebar().querySelector('a[href="/admin"]'), null, "Admin only for allowlisted wallets")

    assert.equal([...m.sidebar().querySelectorAll("li")].some(node => node.textContent?.includes("Send")), false, "Send stays out of the menu until it exists")

    const first = m.element.querySelector<HTMLElement>(FOCUSABLE)!
    assert.equal(first.textContent, "Skip to content")
    await act(async () => { first.click() })
    assert.equal(document.activeElement?.id, "giwa-main")
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("drawer: opens with focus on Close, traps Tab/Shift+Tab, Escape closes and returns focus", async () => {
    const m = await mount("/funds")
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false")
    assert.ok(m.dialogId)
    assert.equal(m.dialog(), null)

    await m.open()
    const dialog = m.dialog()!
    assert.ok(dialog)
    assert.equal(dialog.getAttribute("role"), "dialog")
    assert.equal(dialog.getAttribute("aria-modal"), "true")
    assert.equal(dialog.getAttribute("aria-label"), "Menu")
    assert.ok(!m.element.contains(dialog), "portaled to <body>")
    assert.equal(m.trigger.getAttribute("aria-expanded"), "true")
    assert.equal(document.body.style.overflow, "hidden")
    const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close menu"]')!
    assert.equal(document.activeElement, close)

    const backdrop = dialog.previousElementSibling as HTMLElement
    assert.equal(backdrop.getAttribute("aria-hidden"), "true")
    assert.equal(backdrop.tagName, "DIV")
    assert.equal(backdrop.hasAttribute("tabindex"), false)

    const drawerNav = dialog.querySelector('nav[aria-label="Main"]')!
    assert.deepEqual(currentLabels(drawerNav), ["Funds"])
    assert.ok(![...drawerNav.querySelectorAll("li")].some(node => node.textContent?.includes("Send")), "the drawer has no Send row either")

    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const firstEl = focusable[0], lastEl = focusable[focusable.length - 1]
    assert.equal(firstEl, close)
    assert.ok(!focusable.some(node => node.textContent?.includes("Send")))

    lastEl.focus()
    assert.equal(key(lastEl, "Tab").defaultPrevented, true)
    assert.equal(document.activeElement, firstEl, "Tab from last wraps to first")
    assert.equal(key(firstEl, "Tab", true).defaultPrevented, true)
    assert.equal(document.activeElement, lastEl, "Shift+Tab from first wraps to last")
    const middle = focusable[1]
    middle.focus()
    assert.equal(key(middle, "Tab").defaultPrevented, false, "inner Tab keeps native order")
    document.body.focus(); (document.activeElement as HTMLElement | null)?.blur()
    key(document.body, "Tab")
    assert.equal(document.activeElement, firstEl, "Tab with focus outside returns into the drawer")

    key(document.activeElement!, "Escape")
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false")
    assert.equal(document.activeElement, m.trigger)
    assert.equal(document.body.style.overflow, "")
    await m.settle()
    assert.equal(m.dialog(), null)
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("drawer: a nav link navigates and closes; current-page link and backdrop also close", async () => {
    const m = await mount("/funds")
    await m.open()
    const savings = m.dialog()!.querySelector<HTMLAnchorElement>('a[href="/savings"]')!
    await act(async () => { savings.click(); await flush() })
    assert.equal(m.probe.pathname, "/savings")
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false")
    assert.equal(document.activeElement, m.trigger)
    await m.settle()
    assert.equal(m.dialog(), null)
    assert.deepEqual(currentLabels(m.sidebar()), ["Savings"])

    await m.open()
    const current = m.dialog()!.querySelector<HTMLAnchorElement>('a[aria-current="page"]')!
    assert.equal(current.getAttribute("href"), "/savings")
    await act(async () => { current.click(); await flush() })
    assert.equal(m.probe.pathname, "/savings")
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false")
    await m.settle()

    await m.open()
    await act(async () => { (m.dialog()!.previousElementSibling as HTMLElement).click(); await flush() })
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false")
    await m.settle()
    assert.equal(m.dialog(), null)

    // A route change while open (browser Back, no drawer click) closes it; mount never focused the trigger.
    await m.open()
    await m.go("/funds")
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false", "route change closes the drawer")
    await m.settle()
    assert.equal(m.dialog(), null)

    // Keys that belong to another layer opened on top (e.g. a wallet sign-in modal) are not trapped.
    await m.open()
    const other = document.createElement("div")
    other.setAttribute("role", "dialog"); other.setAttribute("aria-modal", "true")
    const field = document.createElement("input"); other.append(field); document.body.append(other)
    field.focus()
    const tab = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    field.dispatchEvent(tab)
    assert.equal(tab.defaultPrevented, false, "Tab inside another modal is left to that modal")
    assert.equal(document.activeElement, field)
    await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush() })
    assert.equal(m.trigger.getAttribute("aria-expanded"), "true", "Escape in another modal does not close the drawer under it")
    other.remove()
    await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await flush() })
    assert.equal(m.trigger.getAttribute("aria-expanded"), "false")
    await m.settle()

    // A route change while closed never steals focus.
    const main = m.element.querySelector<HTMLElement>("#giwa-main")!
    main.focus()
    await m.go("/portfolio")
    assert.equal(document.activeElement, main)
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("desktop sidebar collapses to named icons, remembers its choice and leaves the drawer expanded", async () => {
    const storageKey = "giwa-investor-sidebar-collapsed"
    window.localStorage.removeItem(storageKey)
    const m = await mount("/savings")
    const shell = () => m.element.querySelector<HTMLElement>("[data-sidebar-state]")!
    assert.equal(shell().dataset.sidebarState, "expanded")
    assert.match(shell().className, /xl:grid-cols-\[224px_minmax\(0,1fr\)\]/)

    await act(async () => { m.element.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')!.click(); await flush() })
    assert.equal(shell().dataset.sidebarState, "collapsed")
    assert.match(shell().className, /xl:grid-cols-\[56px_minmax\(0,1fr\)\]/)
    assert.equal(window.localStorage.getItem(storageKey), "1")
    assert.equal(m.sidebar().querySelector<HTMLAnchorElement>('a[href="/savings"]')?.getAttribute("aria-label"), "Savings")
    assert.deepEqual(currentLabels(m.sidebar()), ["Savings"])
    assert.equal(m.sidebar().querySelector('[aria-label="Savings categories"]'), null)
    assert.equal(m.sidebar().querySelector('[aria-disabled="true"]')?.closest('a, button'), null)

    await m.open()
    assert.ok(m.dialog()?.querySelector('a[href="/savings"]')?.textContent?.includes("Savings"), "mobile drawer keeps full labels")
    key(m.dialog()!, "Escape")
    await m.settle()
    await m.unmount()

    const restored = await mount("/funds")
    assert.equal(restored.element.querySelector<HTMLElement>("[data-sidebar-state]")?.dataset.sidebarState, "collapsed")
    await act(async () => { restored.element.querySelector<HTMLButtonElement>('button[aria-label="Expand sidebar"]')!.click(); await flush() })
    assert.equal(restored.element.querySelector<HTMLElement>("[data-sidebar-state]")?.dataset.sidebarState, "expanded")
    assert.equal(window.localStorage.getItem(storageKey), "0")
    await restored.unmount()
    window.localStorage.removeItem(storageKey)
  })
})
