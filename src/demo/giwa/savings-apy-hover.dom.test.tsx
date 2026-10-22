// The Savings APY sparkline under a pointer: the dot follows it along the line, and the figures beside it show that
// point's APY, its date and its change since the line's first point; leaving puts the latest back.
// Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const DAY = 86_400

test("APY sparkline: pointing moves the dot and shows that day's APY, date and change (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
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
    const { SavingsStatsRow } = (await import("./SavingsStatsRow")) as AnyModule
    const now = Math.floor(Date.now() / 1000)
    // Three days a day apart: 3.8%, 4.2%, 4.6%, the first at local noon so the date reads the same everywhere.
    const noon = new Date((now - 2 * DAY) * 1000)
    noon.setHours(12, 0, 0, 0)
    const start = Math.floor(noon.getTime() / 1000)
    const history = {
      productId: "sarcousd",
      apy: null,
      points: [3.8, 4.2, 4.6].map((apy, day) => ({ t: start + day * DAY, navBase: 1, navUsd: 1, apy })),
    }
    const element = w.document.getElementById("root")!
    const root = createRoot(element)
    await React.act(async () => root.render(React.createElement(SavingsStatsRow, { apyText: "4.6%", history, tvlText: "$1K" })))

    const line = element.querySelector('div[aria-hidden="true"].cursor-crosshair') as HTMLElement
    assert.ok(line, "the sparkline")
    line.getBoundingClientRect = () => ({ left: 100, top: 0, width: 200, height: 40, right: 300, bottom: 40, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect
    const dot = () => (line.querySelector("span") as HTMLElement).style.left
    const figures = () => element.textContent ?? ""
    const date = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

    // At rest: the latest APY, the change over the line, the dot at the end, no date.
    assert.match(figures(), /4\.6%/)
    assert.match(figures(), /0\.8pp/)
    assert.equal(dot(), "100%")
    assert.doesNotMatch(figures(), new RegExp(date(start)))

    // A quarter of the way in: the first day's step (3.8%, its date, no change), the dot under the pointer.
    await React.act(async () => line.dispatchEvent(new w.MouseEvent("pointermove", { bubbles: true, clientX: 150 })))
    assert.match(figures(), /3\.8%/)
    assert.match(figures(), new RegExp(date(start)))
    assert.match(figures(), /0pp/)
    assert.equal(dot(), "25%")

    // Three quarters in: the second day's step.
    await React.act(async () => line.dispatchEvent(new w.MouseEvent("pointermove", { bubbles: true, clientX: 250 })))
    assert.match(figures(), /4\.2%/)
    assert.match(figures(), new RegExp(date(start + DAY)))
    assert.match(figures(), /0\.4pp/)
    assert.equal(dot(), "75%")

    // Leaving puts the latest back.
    await React.act(async () => line.dispatchEvent(new w.MouseEvent("pointerout", { bubbles: true, relatedTarget: w.document.body })))
    await React.act(async () => line.dispatchEvent(new w.MouseEvent("pointerleave", { bubbles: false })))
    assert.match(figures(), /4\.6%/)
    assert.doesNotMatch(figures(), new RegExp(date(start + DAY)))
    assert.equal(dot(), "100%")
    await React.act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
