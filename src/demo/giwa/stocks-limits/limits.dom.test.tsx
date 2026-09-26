// The trading limits panel in React DOM + StrictMode against the REAL limits routes.
//
// Real: stocksTradingLimitsPlugin (authorization, input checks, whitelists, error mapping, PUT consistency), served
// in-process with app.inject. Simulated: the limits port is an in-memory mirror of StocksTradingLimitService (idempotency
// first, then the version check, event and state in one step) because the real service needs PostgreSQL. Every request the
// page sends is recorded; the log proves the PUT bodies, the replayed retry and the read-only operator's GET-only reads.
//
// Gated like the other DOM suites: set GIWA_ADMIN_DOM_RUNTIME (or GIWA_HOST_DOM_RUNTIME) to an existing jsdom package.json.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const runtime = process.env.GIWA_ADMIN_DOM_RUNTIME ?? process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("trading limits panel against the real routes (set GIWA_ADMIN_DOM_RUNTIME)", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://limits.test", pretendToBeVisual: true })
  const w = dom.window
  let walletTouches = 0
  Object.defineProperty(w, "ethereum", { configurable: true, get() { walletTouches++; return undefined } })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { default: Fastify } = (await import("fastify")) as AnyModule
  const { stocksTradingLimitsPlugin } = (await import("../../../../server/src/stocks-trading-limits/plugin")) as AnyModule
  const { StocksError } = (await import("../../../../server/src/stocks/contracts")) as AnyModule
  const { StocksLimitsPanel } = (await import("./LimitsPanel")) as AnyModule
  const F = (await import("./fixtures")) as typeof import("./fixtures")
  const { act, createElement: h, StrictMode } = React

  // ---- the in-memory limits port behind the real plugin
  const operators: Record<string, { operatorId: string; permissions: string[] }> = {
    "control-token": { operatorId: "ops-limits-a", permissions: ["stocks:read", "stocks:control"] },
    "other-control-token": { operatorId: "ops-limits-b", permissions: ["stocks:read", "stocks:control"] },
    "reader-token": { operatorId: "ops-reader", permissions: ["stocks:read"] },
  }
  type State = { deploymentDigest: string; symbol: string; side: string; enabled: boolean; dailyCashLimit: string | null; version: number; updatedAt: string | null; operatorId: string | null; reason: string | null }
  const rows = new Map<string, State>()
  const events: AnyModule[] = []
  const byKey = new Map<string, { event: AnyModule; command: AnyModule; symbol: string; side: string; operatorId: string }>()
  let clock = Date.parse("2026-09-26T02:00:00.000Z")
  const usage: Record<string, string> = { BUY: "12500000", SELL: "0" }
  const stateOf = (symbol: string, side: string): State => rows.get(`${symbol}:${side}`) ?? { deploymentDigest: F.LIM_DIGEST, symbol, side, enabled: true, dailyCashLimit: null, version: 0, updatedAt: null, operatorId: null, reason: null }
  const port = {
    symbols: ["NVDA"],
    async read() {
      return { items: ["BUY", "SELL"].map((side) => ({ ...stateOf("NVDA", side), usedToday: usage[side] })), window: { ...F.LIM_WINDOW } }
    },
    async change(operator: AnyModule, symbol: string, side: string, command: AnyModule) {
      if (!operator.permissions.includes("stocks:control")) throw new StocksError("OPERATOR_FORBIDDEN", 403)
      const prior = byKey.get(command.idempotencyKey)
      if (prior) {
        const same = prior.symbol === symbol && prior.side === side && prior.operatorId === operator.operatorId && JSON.stringify(prior.command) === JSON.stringify(command)
        if (!same) throw new StocksError("LIMIT_IDEMPOTENCY_CONFLICT", 409)
        return { state: stateOf(symbol, side), change: prior.event, replayed: true }
      }
      const current = stateOf(symbol, side)
      if (current.version !== command.expectedVersion) throw new StocksError("LIMIT_VERSION_CONFLICT", 409)
      clock += 60_000
      const createdAt = new Date(clock).toISOString()
      const event = { id: `limit-event-${events.length + 1}`, deploymentDigest: F.LIM_DIGEST, symbol, side, version: current.version + 1, previousEnabled: current.enabled, previousDailyCashLimit: current.dailyCashLimit, enabled: command.enabled, dailyCashLimit: command.dailyCashLimit, operatorId: operator.operatorId, reason: command.reason, createdAt }
      events.unshift(event)
      byKey.set(command.idempotencyKey, { event, command: { ...command }, symbol, side, operatorId: operator.operatorId })
      const state = { deploymentDigest: F.LIM_DIGEST, symbol, side, enabled: command.enabled, dailyCashLimit: command.dailyCashLimit, version: event.version, updatedAt: createdAt, operatorId: operator.operatorId, reason: command.reason }
      rows.set(`${symbol}:${side}`, state)
      return { state, change: event, replayed: false }
    },
    async history(limit = 50) {
      return { items: events.slice(0, limit) }
    },
  }
  const server = Fastify({ logger: false })
  await server.register(stocksTradingLimitsPlugin, { service: port, resolveOperator: async (request: AnyModule) => operators[String(request.headers.authorization ?? "").replace(/^Bearer /, "")] ?? null })
  await server.ready()

  // ---- transport: every request recorded; one PUT answer can be lost after the server processed it
  const log: Array<{ method: string; path: string; body: string | undefined; bearer: string | undefined }> = []
  let loseNextPutAnswer = false
  const fetch = async (url: string, init: RequestInit) => {
    const target = new URL(url)
    const path = `${target.pathname}${target.search}`
    const method = String(init.method ?? "GET").toUpperCase()
    const headers = { ...(init.headers as Record<string, string>) }
    const body = typeof init.body === "string" ? init.body : undefined
    log.push({ method, path, body, bearer: headers.authorization })
    const response = await server.inject({ method, url: path, headers, ...(body === undefined ? {} : { payload: body }) })
    if (method === "PUT" && loseNextPutAnswer) {
      loseNextPutAnswer = false
      throw new TypeError("connection reset after the server answered")
    }
    return { status: response.statusCode, text: async () => response.body }
  }

  // ---- rendering and input helpers
  const container = w.document.createElement("div")
  w.document.body.appendChild(container)
  const root = createRoot(container)
  let keys = 0
  const render = async (props: AnyModule) => {
    await act(async () => root.render(h(StrictMode, null, h(StocksLimitsPanel, { apiBase: "https://api.limits.test", fetch, now: () => F.LIM_NOW, newIdempotencyKey: () => `limit-key-${String(++keys).padStart(4, "0")}`, ...props }))))
  }
  t.after(async () => {
    await act(async () => root.unmount())
    await server.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  })
  // Text nodes joined by spaces, as a reader hears them (textContent runs neighbouring cells together).
  const text = () => {
    const walker = w.document.createTreeWalker(container, 4)
    const parts: string[] = []
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue ?? "")
    return parts.join(" ").replace(/\s+/g, " ")
  }
  async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 600; i++) {
      if (predicate()) return
      await act(async () => { await sleep(2) })
    }
    throw new Error(`timed out waiting for: ${label}\n${text().slice(0, 1200)}`)
  }
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label)
    assert.ok(found, `button: ${label}`)
    return found as HTMLButtonElement
  }
  const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click() }) }
  const type = async (element: Element | null, value: string) => {
    assert.ok(element, "input")
    const proto = element instanceof w.HTMLTextAreaElement ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value)
      element.dispatchEvent(new w.Event("input", { bubbles: true }))
    })
  }
  const puts = () => log.filter((entry) => entry.method === "PUT")

  // 1. A control operator reads the limits and history, turns Buy off, reviews and confirms. There is no reason to type:
  //    the console sends its fixed text.
  await render({ session: { id: "session-control", accessToken: "control-token" }, canControl: true })
  await until(() => text().includes("NVDA") && text().includes("No change has been recorded yet"), "first read")
  assert.match(text(), /Status On Today 12\.5 tUSDC used · no cap/)
  await click(button("Change the NVDA Buy limit"))
  await click(container.querySelector('input[role="switch"]')!)
  assert.equal(container.querySelector("textarea"), null, "no reason to type")
  await click(button("Review change"))
  await until(() => text().includes("Review the NVDA Buy change"), "review")
  assert.match(text(), /Now \(version 0\) On · No cap.*After saving \(version 1\) Off · No cap/)
  await click(button("Confirm change"))
  await until(() => text().includes("Saved: NVDA Buy"), "saved")
  await until(() => /Side Buy Status Off/.test(text()) && text().includes("On → Off"), "read again after saving")
  assert.deepEqual(puts().map((entry) => [entry.path, entry.body]), [
    ["/api/v1/admin/stocks/limits/NVDA/BUY", '{"enabled":false,"dailyCashLimit":null,"expectedVersion":0,"idempotencyKey":"limit-key-0001","reason":"Changed in the admin console"}'],
  ])
  assert.equal(stateOf("NVDA", "BUY").version, 1)

  // 2. Someone else changes Sell while this operator edits it: the server refuses the stale change; the page reads again.
  await click(button("Close"))
  await click(button("Change the NVDA Sell limit"))
  await click(container.querySelector('input[type="checkbox"]:not([role="switch"])')!)
  await type(container.querySelector('input[type="text"]'), "10,000")
  await click(button("Review change"))
  await until(() => text().includes("Review the NVDA Sell change"), "sell review")
  const direct = await server.inject({ method: "PUT", url: "/api/v1/admin/stocks/limits/NVDA/SELL", headers: { authorization: "Bearer other-control-token", "content-type": "application/json" }, payload: { enabled: false, dailyCashLimit: null, expectedVersion: 0, idempotencyKey: "other-key-0001", reason: "Sells off" } })
  assert.equal(direct.statusCode, 200, direct.body)
  await click(button("Confirm change"))
  await until(() => text().includes("NVDA Sell was changed by someone else first"), "conflict")
  await until(() => /Side Sell Status Off/.test(text()) && text().includes("ops-limits-b"), "the other change is read")
  assert.equal(stateOf("NVDA", "SELL").operatorId, "ops-limits-b")
  assert.equal(events.length, 2)

  // 3. A change whose answer is lost is retried with the same key: the server replays it instead of recording it twice.
  await click(button("Close"))
  await click(button("Change the NVDA Buy limit"))
  await click(container.querySelector('input[role="switch"]')!)
  await click(container.querySelector('input[type="checkbox"]:not([role="switch"])')!)
  await type(container.querySelector('input[type="text"]'), "25000")
  await click(button("Review change"))
  await until(() => text().includes("After saving (version 2) On · 25,000 tUSDC"), "buy review")
  loseNextPutAnswer = true
  await click(button("Confirm change"))
  await until(() => text().includes("The NVDA Buy change was not confirmed"), "unknown result")
  assert.equal(events.length, 3, "the server did record it")
  assert.equal(container.querySelector('button[aria-label="Change the NVDA Sell limit"]')?.hasAttribute("disabled"), true, "nothing else starts meanwhile")
  await click(button("Retry"))
  await until(() => text().includes("Already saved earlier: NVDA Buy"), "replayed")
  assert.equal(events.length, 3, "recorded once")
  const [, , lost, retried] = puts()
  assert.equal(lost.body, retried.body)
  assert.match(retried.body!, /"idempotencyKey":"limit-key-0003"/)
  await until(() => /Side Buy Status On Today 12\.5 tUSDC used of 25,000 tUSDC \(0\.0%\)/.test(text()), "read again after the replay")

  // 4. A read-only operator (a new session) sees everything and can change nothing.
  const before = log.length
  await render({ session: { id: "session-reader", accessToken: "reader-token" }, canControl: false })
  await until(() => text().includes("Read only for this operator") && text().includes("Changed in the admin console"), "reader view")
  assert.equal(container.querySelector('button[aria-label^="Change the"]'), null)
  assert.deepEqual(new Set(log.slice(before).map((entry) => entry.method)), new Set(["GET"]))
  assert.ok(log.slice(before).every((entry) => entry.bearer === "Bearer reader-token"))

  // 5. Signed out: nothing is sent.
  const signedOut = log.length
  await render({ session: null, canControl: false })
  await until(() => text().includes("Operator session required"), "signed out")
  assert.equal(log.length, signedOut)
  assert.equal(walletTouches, 0, "the limits panel never touches a wallet")
})
