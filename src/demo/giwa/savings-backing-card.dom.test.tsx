// The Backing tiles' detail card in React DOM: pointing at a tile opens its card (the asset, its manager, chain, value
// and share), the pointer can move onto the card without it closing, leaving closes it, Escape closes it, and keyboard
// focus opens it too. Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("backing tiles: a card on pointing or focus, kept while pointed at, closed by leaving or Escape (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement,
    Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    // React DOM detects its event support when first loaded, so it is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { AllocationTreemap } = (await import("./AllocationTreemap")) as AnyModule
    const { savingsBacking } = (await import("./savings-backing")) as AnyModule
    const { act, createElement: h } = React

    const root = createRoot(w.document.getElementById("root")!)
    await act(async () =>
      root.render(h(AllocationTreemap, { slices: savingsBacking({ symbol: "USDC", icon: "/logos/usdc.svg" }), title: "Backing assets", info: "x", total: "$50K", totalUsd: 50_000 })),
    )
    // The wide grid (the tall one is the same for phones).
    const grid = w.document.querySelectorAll('ul[aria-label="Backing assets"]')[0]!
    const tile = (name: string) => ([...grid.querySelectorAll('[tabindex="0"]')] as HTMLElement[]).find((element) => element.textContent?.startsWith(name))!
    const card = () => grid.parentElement!.querySelector('[role="tooltip"]') as HTMLElement | null
    const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
    const pointer = (type: "mouseover" | "mouseout", target: Element, related: Element | null) =>
      act(async () => {
        target.dispatchEvent(new w.MouseEvent(type, { bubbles: true, relatedTarget: related }))
      })

    assert.equal(card(), null, "no card until a tile is pointed at")

    // Pointing at Fidelity's tile: its card, and the tile describes itself by it.
    await pointer("mouseover", tile("Fidelity"), w.document.body)
    const text = card()?.textContent ?? ""
    for (const part of ["Reserve-Grade US Treasury Strategy Token", "RRDY", "Asset manager", "Fidelity", "Ethereum", "$20K", "40%"]) {
      assert.ok(text.includes(part), part)
    }
    assert.equal(tile("Fidelity").getAttribute("aria-describedby"), card()!.id)
    assert.equal(tile("Fidelity").dataset.active, "true")

    // The pointer moves from the tile onto the card: it stays. Leaving the card closes it a moment later.
    await pointer("mouseout", tile("Fidelity"), card())
    await pointer("mouseover", card()!, tile("Fidelity"))
    await wait(250)
    assert.ok(card(), "kept while pointed at")
    await pointer("mouseout", card()!, w.document.body)
    await wait(250)
    assert.equal(card(), null, "closed after leaving")

    // Another tile: its own card (the loans, made through Morpho).
    await pointer("mouseover", tile("Crypto"), w.document.body)
    assert.match(card()?.textContent ?? "", /Protocol.*Morpho/)
    assert.match(card()?.textContent ?? "", /\$10K/)
    // Escape closes it.
    await act(async () => {
      tile("Crypto").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    assert.equal(card(), null, "Escape closes")

    // Keyboard focus opens a tile's card too; moving focus away closes it.
    await act(async () => tile("UBS").focus())
    assert.match(card()?.textContent ?? "", /uMINT/)
    await act(async () => tile("UBS").blur())
    assert.equal(card(), null)

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
