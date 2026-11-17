// The Crypto Native tab's menu: opening it lists the supported coins (mark, name, APY) with the open account checked;
// picking a row selects that account and closes the menu; Escape closes it. Gated like the other DOM tests
// (GIWA_HOST_DOM_RUNTIME = a jsdom package.json). jsdom has no matchMedia, so this covers the list (from `sm`); the
// phone's bottom sheet shows the same rows.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("savings tabs: the Crypto Native menu lists supported coins and picks one (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
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
    const { SavingsTabs } = (await import("./SavingsTabs")) as AnyModule
    const account = (symbol: string, apy: string, disabled = false) => ({
      key: `real:v-${symbol}:${symbol}`, symbol, icon: `/accept/${symbol}.png`, apy, disabled, vault: null, vaultId: `v-${symbol}`, sortOrder: null,
    })
    const accounts = [account("USDC", "3.92%"), account("ETH", "3.86%"), account("XRP", "4.57%"), account("SOL", "9%", true)]
    const picked: string[] = []
    const element = w.document.getElementById("root")!
    const root = createRoot(element)
    const render = async (selectedKey: string) =>
      React.act(async () => root.render(React.createElement(SavingsTabs, { accounts, selectedKey, onSelect: (a: { symbol: string }) => picked.push(a.symbol) })))
    const act = async (run: () => void) => React.act(async () => run())
    const tab = () => element.querySelector("[data-crypto-tab]") as HTMLButtonElement
    const menu = () => w.document.querySelector('[role="menu"]')

    await render(accounts[1]!.key)
    assert.equal(menu(), null)
    assert.equal(tab().getAttribute("aria-expanded"), "false")

    // Open: one row per supported coin (no SOL), each with its name, symbol and APY; ETH is checked and focused.
    await act(() => tab().click())
    assert.equal(tab().getAttribute("aria-expanded"), "true")
    const rows = Array.from(menu()!.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[]
    assert.deepEqual(rows.map((row) => row.textContent), ["EthereumETH3.86%", "XRP4.57%"])
    assert.deepEqual(rows.map((row) => row.getAttribute("aria-checked")), ["true", "false"])
    assert.deepEqual(rows.map((row) => row.querySelector("img")?.getAttribute("src")), ["/accept/ETH.png", "/accept/XRP.png"])
    assert.equal(w.document.activeElement, rows[0])
    assert.ok(menu()!.closest(".arco-demo"), "the portal carries the theme scope")

    // Arrow down moves to XRP; picking it selects the account and closes the menu, focus back on the tab.
    await act(() => rows[0]!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
    assert.equal(w.document.activeElement, rows[1])
    await act(() => rows[1]!.click())
    assert.deepEqual(picked, ["XRP"])
    assert.equal(menu(), null)
    assert.equal(w.document.activeElement, tab())

    // Escape closes without picking; a press elsewhere closes too.
    await act(() => tab().click())
    await act(() => menu()!.querySelector("button")!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    assert.equal(menu(), null)
    await act(() => tab().click())
    await act(() => w.document.body.dispatchEvent(new w.Event("pointerdown", { bubbles: true })))
    assert.equal(menu(), null)
    assert.deepEqual(picked, ["XRP"])

    await React.act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
})
