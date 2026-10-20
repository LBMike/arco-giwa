// The Savings token picker in React DOM: its lists (coins held first, coming soon last and not pickable), the search,
// the network menu (which closes on Escape before the picker does) and picking a coin. Gated like the other DOM tests
// (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import type { SavingsAssetChoice } from "./savings-assets"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("token picker: held coins first, search, a network menu closed by Escape first, picking (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="giwa-main" tabindex="-1"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement, SVGElement: w.SVGElement,
    Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    // React DOM detects its event support when first loaded, so it is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsAssetPicker } = (await import("./SavingsAssetPicker")) as AnyModule
    const { SAVINGS_ASSET_OPTIONS } = (await import("./savings-assets")) as AnyModule
    const { act, createElement: h } = React

    const choice = (key: string, available: boolean, balance: number | null): SavingsAssetChoice => ({
      ...SAVINGS_ASSET_OPTIONS.find((entry: { key: string }) => entry.key === key),
      available,
      balance,
      usd: balance,
    })
    const choices = [choice("usdc-ethereum", true, 25_000), choice("usdc-giwa", true, 9_000), choice("usdt-ethereum", true, 0), choice("rlusd-xrpl", false, null)]
    const calls = { selected: [] as string[], closed: 0 }

    const root = createRoot(w.document.getElementById("giwa-main")!)
    await act(async () =>
      root.render(
        h(SavingsAssetPicker, {
          open: true,
          onClose: () => {
            calls.closed += 1
          },
          choices,
          selected: "usdc-giwa",
          onSelect: (key: string) => calls.selected.push(key),
        }),
      ),
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    const dialog = () => w.document.querySelector('[role="dialog"]') as HTMLElement | null
    const rows = () => [...dialog()!.querySelectorAll("[data-choice]")] as HTMLButtonElement[]
    const keys = () => rows().map((row) => row.dataset.choice)
    const row = (key: string) => rows().find((item) => item.dataset.choice === key)!
    const search = () => dialog()!.querySelector('input[aria-label="Search token"]') as HTMLInputElement
    const networkButton = () => dialog()!.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
    const menu = () => dialog()!.querySelector('[role="menu"]') as HTMLElement | null
    const key = (target: Element, name: string) =>
      act(async () => {
        target.dispatchEvent(new w.KeyboardEvent("keydown", { key: name, bubbles: true }))
      })
    const type = (value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
        setter.call(search(), value)
        search().dispatchEvent(new w.Event("input", { bubbles: true }))
      })

    // A titled dialog, focus in the search; the coins held first (largest first), the rest after, coming soon last.
    assert.equal(w.document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent, "Select a token")
    assert.equal(w.document.activeElement, search())
    assert.deepEqual([...dialog()!.querySelectorAll("h3")].map((item) => item.textContent), ["Your tokens", "Other tokens"])
    assert.deepEqual(keys(), ["usdc-ethereum", "usdc-giwa", "usdt-ethereum", "rlusd-xrpl"])
    assert.equal(row("usdc-giwa").getAttribute("aria-pressed"), "true")
    assert.equal(row("usdc-ethereum").getAttribute("aria-pressed"), "false")
    assert.match(row("usdc-ethereum").textContent ?? "", /USDCon Ethereum.*25,000.*\$25,000/)
    assert.equal(row("rlusd-xrpl").disabled, true)
    assert.match(row("rlusd-xrpl").textContent ?? "", /Coming soon/)

    // The search narrows by ticker, name or chain; nothing found says so.
    await type("usdt")
    assert.deepEqual(keys(), ["usdt-ethereum"])
    await type("zzz")
    assert.deepEqual(keys(), [])
    assert.match(dialog()!.textContent ?? "", /No tokens match “zzz”\./)
    await type("")

    // The network menu: All Networks, then the chains with a balance, then the others; focus on the one in use.
    await act(async () => networkButton().click())
    assert.ok(menu())
    assert.equal(networkButton().getAttribute("aria-expanded"), "true")
    assert.deepEqual([...menu()!.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent), ["All Networks", "Ethereum", "GIWA", "XRPL"])
    assert.deepEqual([...menu()!.querySelectorAll("p")].map((item) => item.textContent), ["With balance", "Other Networks"])
    assert.equal(w.document.activeElement?.textContent, "All Networks")
    await key(w.document.activeElement!, "ArrowDown")
    assert.equal(w.document.activeElement?.textContent, "Ethereum")
    // Escape closes the menu, not the picker, and goes back to its button.
    await key(w.document.activeElement!, "Escape")
    assert.equal(menu(), null)
    assert.equal(calls.closed, 0)
    assert.ok(dialog())
    assert.equal(w.document.activeElement, networkButton())

    // A network narrows the list.
    await act(async () => networkButton().click())
    const xrpl = [...menu()!.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent === "XRPL") as HTMLButtonElement
    await act(async () => xrpl.click())
    assert.equal(menu(), null)
    assert.equal(networkButton().getAttribute("aria-label"), "Network: XRPL")
    assert.deepEqual(keys(), ["rlusd-xrpl"])
    await act(async () => networkButton().click())
    const all = [...menu()!.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent === "All Networks") as HTMLButtonElement
    await act(async () => all.click())
    assert.equal(keys().length, 4)

    // Picking a coin; one coming soon cannot be picked.
    await act(async () => row("usdt-ethereum").click())
    assert.deepEqual(calls.selected, ["usdt-ethereum"])
    await act(async () => row("rlusd-xrpl").click())
    assert.deepEqual(calls.selected, ["usdt-ethereum"])

    // Escape anywhere else in the picker closes it.
    search().focus()
    await key(search(), "Escape")
    assert.equal(calls.closed, 1)

    await act(async () => root.unmount())
    // jsdom fires a pending selectionchange on a timer; let it land while the DOM globals still exist.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
