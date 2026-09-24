// UI review 2026-09-19 (G4): where keyboard focus goes in the operator console when the control that had it disappears.
//
// A3: "Open detail" (Overview > Unfinished orders) switches to the Orders section and unmounts the focused button; focus
// goes to the Order detail heading, never to <body>, and never on a plain tab switch or a list selection.
// S3: "Check access again" unmounts the access panel; a repeated denial puts focus on the new access heading, a granted
// retry on the console title (h1). Only headings are focused, never a button, and nothing moves on the first load or when
// the operator's focus is outside the console.
//
// React DOM + StrictMode against the fixture routes (every request is a recorded GET). Gated like the other DOM suites:
// set GIWA_ADMIN_DOM_RUNTIME (or GIWA_HOST_DOM_RUNTIME) to an existing jsdom package.json.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const runtime = process.env.GIWA_ADMIN_DOM_RUNTIME ?? process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// Focus is compared by identity with assert.ok: an AssertionError that carries two jsdom nodes makes the test reporter
// inspect the whole window and never finish.

test("operator console focus after Open detail and access checks (set GIWA_ADMIN_DOM_RUNTIME)", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body><button id=\"outside\">Host control</button></body></html>", { url: "https://admin-focus.test", pretendToBeVisual: true })
  const w = dom.window
  let walletTouches = 0
  Object.defineProperty(w, "ethereum", { configurable: true, get() { walletTouches++; return undefined } })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

  const F = (await import("./fixtures")) as typeof import("./fixtures")
  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { GiwaStocksAdminFeature } = (await import("./GiwaStocksAdminFeature")) as AnyModule
  const { act, createElement: h, StrictMode } = React
  const ID = F.FIXTURE_IDS

  // ---- transport: fixture routes with a switchable access scenario; a pause holds every answer until released
  let scenario: import("./fixtures").FixtureScenario = {}
  type Pause = { seen: number; release: () => void; waiting: Promise<void> }
  let paused: Pause | null = null
  function pause(): Pause {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const entry: Pause = { seen: 0, release: () => { paused = null; release() }, waiting }
    paused = entry
    return entry
  }
  const transport = F.createFixtureTransport(async (path) => {
    const held = paused
    if (held) { held.seen += 1; await held.waiting }
    return F.fixtureRoute(scenario)(path)
  })
  const calls = () => transport.calls
  const methods = () => new Set(calls().map((call) => String(call.init.method ?? "GET").toUpperCase()))

  // ---- rendering and input helpers
  const container = w.document.createElement("div")
  w.document.body.appendChild(container)
  const doc = w.document
  let root: AnyModule | null = null
  const props = (extra: AnyModule = {}) => ({ apiBase: "https://api-a.invalid", session: { id: "session-a", accessToken: "fake-a" }, deploymentKey: "deployment-a", initialSection: "overview", fetch: transport.fetch, now: () => F.FIXTURE_NOW, ...extra })
  const open = async (extra: AnyModule = {}) => {
    root = createRoot(container)
    await act(async () => root!.render(h(StrictMode, null, h(GiwaStocksAdminFeature, props(extra)))))
  }
  const text = () => container.textContent ?? ""
  async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 600; i++) {
      if (predicate()) return
      await act(async () => { await sleep(2) })
    }
    throw new Error(`timed out waiting for: ${label}\n${text().slice(0, 600)}`)
  }
  const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await act(async () => { await sleep(1) }) }
  const focus = async (element: Element | null, label: string) => {
    assert.ok(element, `missing: ${label}`)
    await act(async () => { (element as HTMLElement).focus() })
    assert.ok(doc.activeElement === element, `${label} took focus`)
  }
  // Keyboard activation of the focused element as a browser does it: Enter clicks on keydown, Space on keyup, and a
  // disabled button does not click.
  const press = async (key: "Enter" | " " | "ArrowRight") => {
    await act(async () => {
      const target = doc.activeElement as HTMLElement
      const activate = () => { if (target.tagName === "BUTTON" && !(target as HTMLButtonElement).disabled) target.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })) }
      if (target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })) && key === "Enter") activate()
      if (target.dispatchEvent(new w.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true })) && key === " ") activate()
    })
  }
  const tab = (label: string) => [...container.querySelectorAll('[role="tab"]')].find((element) => element.textContent === label) ?? null
  const openDetail = (id: string) => container.querySelector(`button[aria-label="Open order ${id}"]`)
  // Found by text too, so that the focus assertions (not a missing attribute) are what fails on a regression.
  const headings = () => [...container.querySelectorAll("h1, h2, h3")]
  const detailHeading = () => container.querySelector("[data-order-detail-heading]") ?? headings().find((element) => element.textContent?.startsWith("Order detail")) ?? null
  const accessHeading = () => container.querySelector("section[role=alert] h2, section[role=status] h2, section[role=alert] h3, section[role=status] h3")
  const title = () => headings().find((element) => element.textContent === "Stocks operations") ?? null
  const reset = async () => {
    if (root) await act(async () => root!.unmount())
    root = null
    scenario = {}
    paused?.release()
    transport.calls.length = 0
    await act(async () => { (doc.activeElement as HTMLElement | null)?.blur?.() })
  }
  const assertReadOnly = (label: string) => {
    assert.ok(calls().length > 0, label)
    assert.deepEqual([...methods()], ["GET"], `${label}: GET only`)
    assert.equal(walletTouches, 0, `${label}: no wallet`)
  }

  try {
    await t.test("A3: Enter or Space on Open detail puts focus on the Order detail heading of that order", async () => {
      for (const key of ["Enter", " "] as const) {
        await reset()
        await open()
        await until(() => openDetail(ID.buyFinality) !== null, "unfinished orders")
        await focus(openDetail(ID.buyFinality), "Open detail")
        await press(key)
        await until(() => tab("Orders")?.getAttribute("aria-selected") === "true", `${JSON.stringify(key)}: Orders section`)
        const heading = detailHeading()
        assert.ok(heading, "the Order detail heading is rendered")
        assert.ok(doc.activeElement !== doc.body, `${JSON.stringify(key)}: focus fell to <body> when Open detail unmounted`)
        assert.ok(doc.activeElement === heading, `${JSON.stringify(key)}: focus is on the Order detail heading, not ${doc.activeElement?.tagName}`)
        assert.ok(heading!.hasAttribute("data-order-detail-heading"))
        assert.equal(heading!.tagName, "H2")
        assert.equal(heading!.getAttribute("tabindex"), "-1", "focusable by script only, not a tab stop")
        assert.ok(heading!.textContent!.startsWith("Order detail") && heading!.textContent!.includes(ID.buyFinality), "the heading names the opened order")
        await until(() => text().includes("Funding (BUY)"), "detail loaded")
        assert.ok(doc.activeElement === heading, "focus stays on the heading after the detail loads")
      }
      assertReadOnly("open detail")
    })

    await t.test("A3: a plain tab switch and a list selection never move focus to the detail heading", async () => {
      await reset()
      await open()
      await until(() => openDetail(ID.buyFinality) !== null, "unfinished orders")
      // Tab switch by click and by arrow key: focus stays on the tab.
      await focus(tab("Operations overview"), "overview tab")
      await press("ArrowRight")
      await until(() => tab("Orders")?.getAttribute("aria-selected") === "true", "Orders by arrow key")
      assert.ok(doc.activeElement === tab("Orders"), "the arrow key keeps focus on the tabs")
      await until(() => container.querySelector(`button[aria-label="Show detail for BUY order ${ID.buyFinality}"]`) !== null, "orders list")
      // List selection: focus stays on the row button.
      const row = container.querySelector(`button[aria-label="Show detail for BUY order ${ID.buyFinality}"]`)
      await focus(row, "row")
      await press("Enter")
      await until(() => text().includes("Funding (BUY)"), "detail loaded")
      await settle()
      assert.ok(doc.activeElement === row, "a list selection keeps focus on the row")
      // Back to Overview and to Orders again by click: still no jump to the heading.
      await focus(tab("Operations overview"), "overview tab")
      await press("Enter")
      await until(() => openDetail(ID.buyFinality) !== null, "overview again")
      await focus(tab("Orders"), "orders tab")
      await press("Enter")
      await until(() => detailHeading() !== null, "orders again")
      await settle()
      assert.ok(doc.activeElement === tab("Orders"), "a tab click keeps focus on the tab")
    })

    await t.test("S3: nothing moves on the first load; a repeated 403 after Check access again puts focus on the access heading", async () => {
      for (const key of ["Enter", " "] as const) {
        await reset()
        scenario = { access: "forbidden" }
        await open()
        await until(() => text().includes("No Stocks read permission (403)"), "first 403")
        assert.ok(doc.activeElement === doc.body, "no focus move on the first load")
        const retry = [...container.querySelectorAll("button")].find((element) => element.textContent === "Check access again") ?? null
        await focus(retry, "Check access again")
        const before = calls().length
        await press(key)
        await until(() => calls().length > before && accessHeading() !== null && container.querySelector('[role="tablist"]') === null, `${JSON.stringify(key)}: repeated 403`)
        await settle()
        const heading = accessHeading()
        assert.equal(heading?.textContent, "No Stocks read permission (403)")
        assert.ok(doc.activeElement === heading, `${JSON.stringify(key)}: focus is on the access heading, not ${doc.activeElement?.tagName}`)
        assert.equal(heading!.getAttribute("tabindex"), "-1")
        assert.notEqual(doc.activeElement?.tagName, "BUTTON", "a button is never focused by the console")
      }
      assertReadOnly("repeated 403")
    })

    await t.test("S3: a granted retry puts focus on the console title; a denial while working in a panel puts it on the access heading", async () => {
      await reset()
      scenario = { access: "forbidden" }
      await open()
      await until(() => text().includes("No Stocks read permission (403)"), "first 403")
      await focus([...container.querySelectorAll("button")].find((element) => element.textContent === "Check access again") ?? null, "Check access again")
      scenario = {}
      await press("Enter")
      await until(() => openDetail(ID.buyFinality) !== null, "granted")
      await settle()
      assert.ok(doc.activeElement === title(), `focus is on the h1, not ${doc.activeElement?.tagName}`)
      assert.equal(title()?.textContent, "Stocks operations")
      assert.equal(title()?.getAttribute("tabindex"), "-1")

      // The permission is revoked while the operator refreshes a panel: the focused Refresh unmounts with the panel.
      await focus(container.querySelector('button[aria-label="Refresh overview"]'), "Refresh overview")
      scenario = { access: "forbidden" }
      await press("Enter")
      await until(() => accessHeading() !== null, "403 while working")
      await settle()
      assert.ok(doc.activeElement === accessHeading(), `focus is on the access heading, not ${doc.activeElement?.tagName}`)
      assertReadOnly("granted retry and revocation")
    })

    await t.test("S3: focus the operator moved outside the console, or never placed inside it, is not taken", async () => {
      // Focus on a host control while the first answer (403) arrives.
      await reset()
      scenario = { access: "forbidden" }
      const first = pause()
      await open()
      await until(() => first.seen > 0, "first read in flight")
      await focus(doc.getElementById("outside"), "host control")
      first.release()
      await until(() => text().includes("No Stocks read permission (403)"), "403")
      await settle()
      assert.ok(doc.activeElement === doc.getElementById("outside"), "the host control keeps focus")

      // The operator started a refresh inside, then clicked outside (focus falls to <body>) before the 403 arrived.
      await reset()
      await open()
      await until(() => openDetail(ID.buyFinality) !== null, "console")
      await focus(container.querySelector('button[aria-label="Refresh overview"]'), "Refresh overview")
      const late = pause()
      scenario = { access: "forbidden" }
      await press("Enter")
      await until(() => late.seen === 2, "overview and orders refresh in flight")
      await act(async () => {
        doc.body.dispatchEvent(new w.Event("pointerdown", { bubbles: true }))
        ;(doc.activeElement as HTMLElement).blur()
      })
      late.release()
      await until(() => accessHeading() !== null, "403")
      await settle()
      assert.ok(doc.activeElement === doc.body, "focus is not pulled back into the console")
    })
  } finally {
    await reset()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
