// The Funds page in a browser DOM: the Featured card's arrows and dots switch funds, the tabs narrow the list (arrow
// keys move between them), the Risk profile card opens and closes, and AUM / APY sort it. Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom
// package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("Funds page: Featured arrows and dots, tabs, Risk profile card and sorting (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/funds", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element,
    Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { MemoryRouter } = (await import("react-router-dom")) as AnyModule
    const { default: GiwaInvestorPage } = (await import("./Investor")) as AnyModule
    const element = w.document.getElementById("root")!
    const root = createRoot(element)
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ["/funds"] }, React.createElement(GiwaInvestorPage))))

    const card = () => element.querySelector('[data-testid="featured-fund"]')!
    const featuredName = () => card().querySelector("a p")!.textContent
    const rows = () => [...element.querySelectorAll('[data-testid="fund-row"] a[href^="/product/"]')].map((link) => link.textContent!.split(/\s|·/)[0])
    const click = async (target: Element) => React.act(async () => target.dispatchEvent(new w.MouseEvent("click", { bubbles: true })))
    const byLabel = (label: string) => element.querySelector(`[aria-label="${label}"]`)!
    const tab = (label: string) => [...element.querySelectorAll('[role="tab"]')].find((node) => node.textContent === label)!

    // Featured: HOME, then next → JX, next → PPLUS, next wraps to HOME; previous wraps back to PPLUS; a dot picks JX.
    assert.equal(featuredName(), "NUVA HOME Vault")
    await click(byLabel("Next featured fund"))
    assert.equal(featuredName(), "SBI Japan High Dividend Equity Strategy")
    await click(byLabel("Next featured fund"))
    assert.equal(featuredName(), "Bitwise Premium+ RWA Vault")
    await click(byLabel("Next featured fund"))
    assert.equal(featuredName(), "NUVA HOME Vault")
    await click(byLabel("Previous featured fund"))
    assert.equal(featuredName(), "Bitwise Premium+ RWA Vault")
    await click(byLabel("Show JX"))
    assert.equal(featuredName(), "SBI Japan High Dividend Equity Strategy")
    assert.equal(byLabel("Show JX").getAttribute("aria-current"), "true")

    // Tabs.
    assert.deepEqual(rows(), ["HOME", "JX", "PPLUS"])
    await click(tab("Credit"))
    assert.deepEqual(rows(), ["HOME", "PPLUS"])
    assert.equal(tab("Credit").getAttribute("aria-selected"), "true")
    await React.act(async () => tab("Credit").dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })))
    assert.deepEqual(rows(), ["JX"])
    assert.equal(w.document.activeElement, tab("Equity"))
    await click(tab("All Funds"))

    // Risk profile: a click opens HOME's card, Escape closes it and returns focus, a press elsewhere closes it.
    const meter = () => element.querySelector('[data-testid="fund-row"] button[data-risk]') as HTMLButtonElement
    const panel = () => w.document.getElementById(meter().getAttribute("aria-controls")!)!
    assert.equal(meter().getAttribute("aria-expanded"), "false")
    await click(meter())
    assert.equal(meter().getAttribute("aria-expanded"), "true")
    assert.equal((panel() as HTMLElement).hidden, false)
    assert.ok(panel().textContent!.includes("Up to 3 business days"))
    meter().focus()
    await React.act(async () => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    assert.equal(meter().getAttribute("aria-expanded"), "false")
    assert.equal((panel() as HTMLElement).hidden, true)
    assert.equal(w.document.activeElement, meter())
    await click(meter())
    await React.act(async () => w.document.body.dispatchEvent(new w.Event("pointerdown", { bubbles: true })))
    assert.equal(meter().getAttribute("aria-expanded"), "false")
    await click(meter())
    await click(meter())
    assert.equal(meter().getAttribute("aria-expanded"), "false") // a second click closes it

    // Sorting: AUM high to low, then low to high; APY high to low.
    await click(byLabel("Sort by AUM"))
    assert.deepEqual(rows(), ["JX", "PPLUS", "HOME"])
    await click(byLabel("AUM, sorted high to low"))
    assert.deepEqual(rows(), ["HOME", "PPLUS", "JX"])
    await click(byLabel("Sort by APY"))
    assert.deepEqual(rows(), ["JX", "PPLUS", "HOME"])

    await React.act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})

test("On a phone, tapping the Risk profile opens it as a bottom sheet (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="giwa-main" tabindex="-1"><div id="root"></div></main></body></html>', {
    url: "http://localhost/funds",
    pretendToBeVisual: true,
  })
  const w = dom.window
  // A phone-width viewport: no media query matches (neither sm nor lg).
  w.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element,
    Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { MemoryRouter } = (await import("react-router-dom")) as AnyModule
    const { default: GiwaInvestorPage } = (await import("./Investor")) as AnyModule
    const element = w.document.getElementById("root")!
    const root = createRoot(element)
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ["/funds"] }, React.createElement(GiwaInvestorPage))))

    const meters = () => [...element.querySelectorAll('[data-testid="fund-row"] button[data-risk]')] as HTMLButtonElement[]
    const dialog = () => w.document.querySelector('[role="dialog"]')
    const click = async (target: Element) => React.act(async () => target.dispatchEvent(new w.MouseEvent("click", { bubbles: true })))

    // PPLUS (third row): the sheet, not the card under the meter.
    await click(meters()[2]!)
    await React.act(async () => new Promise((resolve) => w.requestAnimationFrame(resolve)))
    const sheet = dialog()!
    assert.ok(sheet, "a dialog opens")
    assert.equal(sheet.getAttribute("aria-label"), "Risk profile")
    assert.equal(sheet.getAttribute("aria-modal"), "true")
    assert.equal(meters()[2]!.getAttribute("aria-expanded"), "true")
    assert.equal((w.document.getElementById(meters()[2]!.getAttribute("aria-controls")!) as HTMLElement).hidden, true)
    const text = sheet.textContent!
    for (const part of ["Medium", "Tokenized private credit", "Liquidation risk", "Yes, up to 5x leverage", "T+4 to T+7", "Learn more about risk"]) {
      assert.ok(text.includes(part), part)
    }
    const link = [...sheet.querySelectorAll("a")].find((anchor) => anchor.textContent!.includes("Learn more about risk"))!
    assert.equal(link.getAttribute("href"), "https://docs.arco.financial/security/user-risks")
    assert.equal(link.getAttribute("target"), "_blank")

    // Close returns focus to the meter.
    await click(sheet.querySelector('button[aria-label="Close"]')!)
    assert.equal(meters()[2]!.getAttribute("aria-expanded"), "false")
    await React.act(async () => new Promise((resolve) => w.setTimeout(resolve, 350)))
    assert.equal(dialog(), null)
    assert.equal(w.document.activeElement, meters()[2])

    await React.act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
