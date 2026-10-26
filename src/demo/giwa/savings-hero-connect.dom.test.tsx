// The Savings card before a wallet: its connect button calls onConnect; the slides' own buttons keep doing their own
// thing and do not call it. (jsdom does no hit-testing: that the slides and logos sit above the card's button is checked
// in a browser, not here.) Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("savings card before a wallet: its button connects; the slide buttons do their own thing (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element,
    Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsHeroCard } = (await import("./SavingsHeroCard")) as AnyModule
    let connects = 0
    const element = w.document.getElementById("root")!
    const root = createRoot(element)
    const props = {
      connected: false, depositLabel: "Stablecoins", tokenSymbol: "sArcoUSD", tokenIcon: "/logos/sarcousd.png", paySymbol: "USDC",
      payIcon: undefined, balanceUsd: null, shares: null, available: null, availableUsd: null, apyPercent: 4.6,
      onDeposit: () => undefined, onWithdraw: () => undefined, onConnect: () => { connects += 1 },
    }
    await React.act(async () => root.render(React.createElement(SavingsHeroCard, props)))

    const click = async (target: Element) => React.act(async () => { (target as HTMLElement).click() })
    const byLabel = (label: string) => element.querySelector(`button[aria-label="${label}"]`)!

    // The card's first button is the connect button.
    const connect = element.querySelector("button")!
    assert.equal(connect.getAttribute("aria-label"), "Connect wallet to start saving")
    await click(connect)
    assert.equal(connects, 1)

    // The slides: pause, then next; neither connects, and the slide moves on.
    await click(byLabel("Pause slides"))
    assert.ok(byLabel("Play slides"), "paused")
    assert.match(element.textContent ?? "", /Institution-grade backing/)
    await click(byLabel("Next"))
    assert.doesNotMatch(element.textContent ?? "", /Institution-grade backing/)
    assert.equal(connects, 1, "the slide buttons do not connect")

    // Connected: the balance card, no connect button.
    await React.act(async () => root.render(React.createElement(SavingsHeroCard, { ...props, connected: true, balanceUsd: 0, shares: 0 })))
    assert.equal(element.querySelector("[data-hero-connect]"), null)

    await React.act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
})
