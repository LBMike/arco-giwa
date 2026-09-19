// 003F: the trading control panel in React DOM + StrictMode against the REAL server routes.
//
// Real: stocksTradingControlPlugin (authorization order, input checks, whitelists, error mapping, POST consistency),
// stocksRuntimeStatusPlugin (pause reason derivation) and stocksSessionResolvers (HS256 SIWE session JWT + named
// operator directory with stocks:read / stocks:control), served in-process with app.inject.
// Simulated: the control port is an in-memory mirror of StocksTradingControlService (idempotency first, then the
// version check, event + state in one step, limit+1 history paging) because the real service needs PostgreSQL; the
// runtime snapshot is derived from it. Everything the page sends is recorded; the log, not a grep, proves the POST
// bodies, the GET-only reads and zero wallet access.
//
// Gated like the other DOM suites: set GIWA_ADMIN_DOM_RUNTIME (or GIWA_HOST_DOM_RUNTIME) to an existing jsdom package.json.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const runtime = process.env.GIWA_ADMIN_DOM_RUNTIME ?? process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// TEST-ONLY values: an in-memory HS256 key for this file's own tokens and made-up wallets. Nothing here is a real secret.
const TEST_ONLY_SECRET = "test-only-trading-control-dom"
const DOMAIN = "trading-control.test"
const WALLET = { controlA: "0x000000000000000000000000000000000000c0a1", controlB: "0x000000000000000000000000000000000000c0b2", reader: "0x000000000000000000000000000000000000ead1", stranger: "0x0000000000000000000000000000000000005a11" }
const DIGEST = "5f0c2b7d9e41a3c6b8d0f2e4a6c8b0d2f4e6a8c0b2d4f6e8a0c2e4b6d8f0a2c4"
const CONTROL = "/api/v1/admin/stocks/trading-control"
const READ_ROUTE = /^\/api\/v1\/admin\/stocks\/(trading-control|trading-control\/history\?limit=20(&beforeVersion=[1-9]\d*)?|runtime)$/
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16)

type Logged = { method: string; path: string; body: string | undefined; bearer: string | null; status: number | null }
type Hold = { match: (method: string, path: string) => boolean; seen: boolean; release: () => void; waiting: Promise<void> }

test("operator trading control against the real routes (set GIWA_ADMIN_DOM_RUNTIME)", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://${DOMAIN}`, pretendToBeVisual: true })
  const w = dom.window
  let walletTouches = 0
  const provider = { request: async () => { throw new Error("the trading control panel must not call a wallet") }, on() {}, removeListener() {} }
  Object.defineProperty(w, "ethereum", { configurable: true, get() { walletTouches++; return provider } })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

  const Fastify = ((await import("fastify")) as AnyModule).default
  const jwt = (await import("jsonwebtoken")) as AnyModule
  const { stocksTradingControlPlugin } = (await import("../../../../server/src/stocks-trading-control/plugin")) as AnyModule
  const { stocksRuntimeStatusPlugin } = (await import("../../../../server/src/stocks-runtime-status/plugin")) as AnyModule
  const { stocksSessionResolvers } = (await import("../../../../server/src/stocks-runtime/session")) as AnyModule
  const { StocksError } = (await import("../../../../server/src/stocks/contracts")) as AnyModule
  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { GiwaStocksTradingControlFeature } = (await import("./GiwaStocksTradingControlFeature")) as AnyModule
  const { act, createElement: h, StrictMode, useLayoutEffect } = React

  // ---- in-memory mirror of StocksTradingControlService
  type Event = { id: string; deploymentDigest: string; version: number; previousPaused: boolean; paused: boolean; operatorId: string; reason: string; createdAt: string; expectedVersion: number; idempotencyKey: string }
  const memory = {
    row: null as null | { paused: boolean; version: number; updatedAt: string; operatorId: string; reason: string },
    events: [] as Event[],
    clock: Date.parse("2026-09-19T08:00:00.000Z"),
    failRead: false,
    failChangeAfterCommit: false,
    reset() {
      this.row = null
      this.events = []
      this.failRead = false
      this.failChangeAfterCommit = false
    },
    state() {
      return this.row ? { deploymentDigest: DIGEST, ...this.row } : { deploymentDigest: DIGEST, paused: true, version: 0, updatedAt: null, operatorId: null, reason: null }
    },
    publicEvent(event: Event) {
      const { expectedVersion: _expected, idempotencyKey: _key, ...rest } = event
      return rest
    },
    apply(operatorId: string, command: { paused: boolean; expectedVersion: number; idempotencyKey: string; reason: string }) {
      const previous = this.events.find((event) => event.idempotencyKey === command.idempotencyKey)
      if (previous) {
        if (previous.operatorId !== operatorId || previous.paused !== command.paused || previous.expectedVersion !== command.expectedVersion || previous.reason !== command.reason) throw new StocksError("CONTROL_IDEMPOTENCY_CONFLICT", 409)
        return { state: this.state(), change: this.publicEvent(previous), replayed: true }
      }
      const current = this.state()
      if (current.version !== command.expectedVersion) throw new StocksError("CONTROL_VERSION_CONFLICT", 409)
      this.clock += 1000
      const event: Event = { id: `evt-${current.version + 1}`, deploymentDigest: DIGEST, version: current.version + 1, previousPaused: current.paused, paused: command.paused, operatorId, reason: command.reason, createdAt: new Date(this.clock).toISOString(), expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey }
      this.events.push(event)
      this.row = { paused: event.paused, version: event.version, updatedAt: event.createdAt, operatorId, reason: event.reason }
      return { state: this.state(), change: this.publicEvent(event), replayed: false }
    },
  }
  const port = {
    read: async () => {
      if (memory.failRead) throw new Error("pg: connection terminated host=db.internal")
      return memory.state()
    },
    change: async (operator: { operatorId: string }, command: never) => {
      const result = memory.apply(operator.operatorId, command)
      if (memory.failChangeAfterCommit) throw new Error("serialization failure after commit")
      return result
    },
    history: async (limit = 50, beforeVersion?: number) => {
      const rows = memory.events.filter((event) => beforeVersion === undefined || event.version < beforeVersion).sort((a, b) => b.version - a.version).slice(0, limit + 1)
      const items = rows.slice(0, limit).map((event) => memory.publicEvent(event))
      return { items, nextBeforeVersion: rows.length > limit ? items[items.length - 1].version : null }
    },
  }
  const gates = { configuredPause: false, observerCurrent: true }
  const snapshot = () => {
    const observedAt = new Date().toISOString()
    const state = memory.state()
    const operatorControl = { status: state.paused ? "PAUSED" : "RESUMED", version: state.version }
    const current = gates.observerCurrent
    const reasons = [...(gates.configuredPause ? ["CONFIGURED_PAUSE"] : []), ...(state.paused ? ["OPERATOR_PAUSE"] : []), ...(current ? [] : ["OBSERVER_NOT_CURRENT"])]
    return {
      enabled: true, runtimeState: "RUNNING", deploymentId: "giwa-stocks-testnet-v2", deploymentDigest: DIGEST, autodispatch: true, configuredPause: gates.configuredPause, operatorControl,
      observerStatus: current ? "CURRENT" : "STALE", lastObservationAt: current ? new Date(Date.parse(observedAt) - 500).toISOString() : null, lastCurrentAt: current ? new Date(Date.parse(observedAt) - 1000).toISOString() : null,
      lastCurrentAgeMs: current ? 1000 : null, freshnessLimitMs: 60000, tickInFlight: false, newOrdersPaused: reasons.length > 0, pauseReasons: reasons, executionAuthorization: false, observedAt,
    }
  }
  const resolvers = stocksSessionResolvers(TEST_ONLY_SECRET, [DOMAIN], [
    { wallet: WALLET.controlA, operatorId: "ops-control-a", permissions: ["stocks:read", "stocks:control"] },
    { wallet: WALLET.controlB, operatorId: "ops-control-b", permissions: ["stocks:read", "stocks:control"] },
    { wallet: WALLET.reader, operatorId: "ops-reader", permissions: ["stocks:read"] },
  ])
  // The real resolver; a test can make it refuse the next POST (a session or permission that ends between attempts).
  let denyNextPost = false
  const resolveOperator = async (request: AnyModule) => {
    if (request.method === "POST" && denyNextPost) {
      denyNextPost = false
      return null
    }
    return resolvers.resolveOperator(request)
  }
  const full = Fastify({ logger: false })
  await full.register(stocksTradingControlPlugin, { service: port, resolveOperator })
  await full.register(stocksRuntimeStatusPlugin, { getSnapshot: snapshot, resolveOperator: resolvers.resolveOperator })
  await full.ready()
  // A server without operator controls: the control routes are absent, runtime status stays.
  const legacy = Fastify({ logger: false })
  await legacy.register(stocksRuntimeStatusPlugin, { getSnapshot: () => { const { operatorControl: _c, ...rest } = snapshot(); const reasons = rest.pauseReasons.filter((r: string) => r !== "OPERATOR_PAUSE"); return { ...rest, pauseReasons: reasons, newOrdersPaused: reasons.length > 0 } }, resolveOperator: resolvers.resolveOperator })
  await legacy.ready()
  let server = full

  const sign = (jwt.default ?? jwt).sign
  const mint = (wallet: string, lifetimeSeconds = 900) => {
    const iat = Math.floor(Date.now() / 1000)
    return sign({ sub: wallet, domain: DOMAIN, chainId: 91342, iat, exp: iat + lifetimeSeconds }, TEST_ONLY_SECRET, { algorithm: "HS256" }) as string
  }
  const directChange = async (wallet: string, command: object) => full.inject({ method: "POST", url: CONTROL, headers: { authorization: `Bearer ${mint(wallet)}`, "content-type": "application/json" }, payload: command })

  // ---- the page's transport: like fetch, an abort rejects at once; a request that already left still reaches the server.
  const log: Logged[] = []
  const holds: Hold[] = []
  let loseNextPostResponse = false
  function hold(match: Hold["match"]): Hold {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const entry: Hold = { match, seen: false, release: () => release(), waiting }
    holds.push(entry)
    return entry
  }
  const fetch = async (url: string, init: RequestInit) => {
    const target = new URL(url)
    const path = `${target.pathname}${target.search}`
    const headers = { ...(init.headers as Record<string, string>) }
    const method = String(init.method ?? "GET").toUpperCase()
    const body = typeof init.body === "string" ? init.body : undefined
    const entry: Logged = { method, path, body, bearer: headers.authorization ? fingerprint(headers.authorization.slice(7)) : null, status: null }
    log.push(entry)
    const target_ = server
    const deliver = () => target_.inject({ method, url: path, headers, ...(body === undefined ? {} : { payload: body }) })
    const held = holds.find((item) => !item.seen && item.match(method, path))
    const signal = init.signal
    if (held) {
      held.seen = true
      const aborted = new Promise<"aborted">((resolve) => {
        if (signal?.aborted) resolve("aborted")
        signal?.addEventListener("abort", () => resolve("aborted"), { once: true })
      })
      if ((await Promise.race([held.waiting.then(() => "released" as const), aborted])) === "aborted") {
        // The request had already left: the server still processes it once released; the page gave up on it.
        void held.waiting.then(deliver)
        throw new DOMException("The operation was aborted.", "AbortError")
      }
    }
    const response = await deliver()
    entry.status = response.statusCode
    if (method === "POST" && loseNextPostResponse) {
      loseNextPostResponse = false
      throw new TypeError("connection reset after the request was processed")
    }
    const text = response.body
    return { status: response.statusCode, text: async () => text }
  }

  // ---- rendering helpers
  const container = w.document.createElement("div")
  w.document.body.appendChild(container)
  function Host({ props, observe }: { props: AnyModule; observe?: (text: string) => void }) {
    useLayoutEffect(() => { observe?.(container.textContent ?? "") })
    return h(GiwaStocksTradingControlFeature, props)
  }
  let root: AnyModule | null = null
  const render = async (props: AnyModule, observe?: (text: string) => void) => { await act(async () => root!.render(h(StrictMode, null, h(Host, { props, observe })))) }
  const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await act(async () => { await sleep(1) }) }
  async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 800; i++) {
      if (predicate()) return
      await act(async () => { await sleep(2) })
    }
    throw new Error(`timed out waiting for: ${label}\n${container.textContent?.slice(0, 1500)}`)
  }
  const text = () => container.textContent ?? ""
  const q = (testid: string) => container.querySelector(`[data-testid="${testid}"]`)
  const button = (label: string) => [...container.querySelectorAll("button")].find((element) => (element.textContent ?? "").trim() === label) ?? null
  const click = async (label: string) => {
    const element = button(label)
    assert.ok(element, `missing button: ${label}\n${text().slice(0, 800)}`)
    await act(async () => { element!.dispatchEvent(new w.MouseEvent("click", { bubbles: true })) })
  }
  const typeReason = async (value: string) => {
    const area = container.querySelector("textarea") as HTMLTextAreaElement | null
    assert.ok(area, "reason field")
    const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(area, value)
      area!.dispatchEvent(new w.Event("input", { bubbles: true }))
    })
  }
  const gatePhase = () => q("stocks-trading-control-gate")?.getAttribute("data-phase") ?? null
  const outcome = () => q("stocks-trading-control-outcome")?.getAttribute("data-outcome") ?? null
  const postsLogged = () => log.filter((entry) => entry.method === "POST")
  const props = (token: string, extra: AnyModule = {}) => ({ apiBase: "https://api-a.invalid", session: { id: "session-a", accessToken: token }, fetch, ...extra })
  const ready = async () => until(() => gatePhase() === "ready" && q("stocks-trading-control-admission")?.getAttribute("data-phase") === "ready" && q("stocks-trading-control-history")?.getAttribute("data-phase") === "ready", "first reads")
  async function open(token: string, extra: AnyModule = {}) {
    root = createRoot(container)
    await render(props(token, extra))
    await ready()
  }
  async function command(action: "Review resume" | "Review pause", reason: string) {
    await typeReason(reason)
    await click(action)
    await until(() => q("stocks-trading-control-review") !== null, "review")
  }
  // After an unknown outcome the page offers no retry until the state has been read again successfully.
  async function readThenRetry() {
    assert.equal(button("Retry the same command"), null, "no retry before a fresh read")
    assert.match(q("stocks-trading-control-outcome")!.textContent!, /Read the state and history first/)
    await click("Read state and history")
    await until(() => button("Retry the same command") !== null, "retry offered after the read")
    await click("Retry the same command")
    assert.equal(w.document.activeElement, q("stocks-trading-control-outcome"), "focus stays on the outcome")
  }
  const reset = async () => {
    if (root) await act(async () => root!.unmount())
    root = null
    log.length = 0
    holds.length = 0
    loseNextPostResponse = false
    denyNextPost = false
    memory.reset()
    gates.configuredPause = false
    gates.observerCurrent = true
    server = full
  }
  const assertTraffic = (label: string) => {
    for (const entry of log) {
      if (entry.method === "POST") {
        assert.equal(entry.path, CONTROL, label)
        assert.deepEqual(Object.keys(JSON.parse(entry.body ?? "{}")), ["paused", "expectedVersion", "idempotencyKey", "reason"], label)
      } else {
        assert.equal(entry.method, "GET", label)
        assert.equal(entry.body, undefined, label)
        assert.match(entry.path, READ_ROUTE, label)
      }
    }
    assert.equal(walletTouches, 0, `${label}: the wallet provider was never read`)
  }

  try {
    await t.test("initial paused v0; a control operator reviews and resumes; other runtime reasons stay visible", async () => {
      await reset()
      gates.configuredPause = true
      const token = mint(WALLET.controlA)
      await open(token)
      assert.match(text(), /Manual gate: Paused/)
      assert.match(text(), /version 0/)
      assert.match(text(), /No change recorded yet/)
      assert.equal(postsLogged().length, 0, "reads only until the operator confirms")
      assert.equal(memory.events.length, 0)
      await command("Review resume", "  Verified local reconciliation  ")
      assert.match(q("stocks-trading-control-review")!.textContent!, /Resume the manual gate\. The server records it as version 1 only if the state is still version 0/)
      assert.match(q("stocks-trading-control-review")!.textContent!, /Configured pause/)
      assert.equal(postsLogged().length, 0, "the review sends nothing")
      await click("Confirm resume")
      await until(() => outcome() === "accepted", "accepted")
      const post = postsLogged()[0]
      assert.deepEqual(JSON.parse(post.body!), { paused: false, expectedVersion: 0, idempotencyKey: JSON.parse(post.body!).idempotencyKey, reason: "Verified local reconciliation" })
      assert.match(JSON.parse(post.body!).idempotencyKey, /^tc-[0-9a-f-]{36}$/)
      assert.equal(post.bearer, fingerprint(token))
      assert.equal(post.status, 200)
      await until(() => /Version 1 · was paused/.test(q("stocks-trading-control-history")?.textContent ?? ""), "history re-read")
      assert.match(text(), /Manual gate: Resumed/)
      assert.match(text(), /The manual gate is resumed; that alone does not resume trading/)
      assert.match(text(), /still paused by: Configured pause/)
      assert.doesNotMatch(text(), /trading (is )?(open|resumed)\b|trading has resumed/i)
      assert.deepEqual([memory.events.length, memory.state().paused], [1, false])
      assertTraffic("resume")
    })

    await t.test("a read-only operator reads but the server refuses the change (403); a stranger's session reads nothing", async () => {
      await reset()
      await open(mint(WALLET.reader))
      await command("Review resume", "Trying without control permission")
      await click("Confirm resume")
      await until(() => outcome() === "rejected", "refused")
      assert.match(text(), /The server refused the change \(403\)/)
      assert.match(text(), /Manual gate: Paused/, "reads still work")
      assert.deepEqual([postsLogged().length, postsLogged()[0].status, memory.events.length], [1, 403, 0])
      assertTraffic("reader")
      await reset()
      root = createRoot(container)
      await render(props(mint(WALLET.stranger)))
      await until(() => /No access to trading control \(403\)/.test(text()), "stranger denied")
      assert.doesNotMatch(text(), /Manual gate:|version 0/)
      assert.equal(postsLogged().length, 0)
      assertTraffic("stranger")
    })

    await t.test("an invalid reason never reaches the review or the server; Back returns without sending", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      const area = () => container.querySelector("textarea")!
      for (const [value, message] of [
        ["   ", /Enter a reason\. It is recorded with the change\./],
        ["two\nlines", /Line breaks, tabs and other control characters are not allowed\./],
        ["x".repeat(501), /The reason is 501 characters; the limit is 500\./],
      ] as const) {
        await typeReason(value)
        await click("Review resume")
        assert.equal(q("stocks-trading-control-review"), null, JSON.stringify(value.slice(0, 10)))
        assert.equal(area().getAttribute("aria-invalid"), "true")
        // The textarea is described by the help text and by the (live) validation message.
        const described = area().getAttribute("aria-describedby")!.split(" ").map((id: string) => w.document.getElementById(id)?.textContent ?? "").join(" ")
        assert.match(described, message)
        assert.equal(w.document.activeElement, area(), "focus stays on the reason")
      }
      await command("Review resume", "A valid reason")
      await click("Back")
      assert.equal(q("stocks-trading-control-review"), null)
      assert.equal(postsLogged().length, 0, "nothing sent without Confirm")
      assert.equal(memory.events.length, 0)
    })

    await t.test("the review is frozen: a refresh that finds another operator's change never turns it into the opposite command", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume after my review")
      assert.equal(w.document.activeElement, q("stocks-trading-control-review"), "focus moves to the review")
      assert.equal((await directChange(WALLET.controlB, { paused: false, expectedVersion: 0, idempotencyKey: "other-operator-3", reason: "Operator B resumed first" })).statusCode, 200)
      await click("Refresh")
      await until(() => /Manual gate: Resumed/.test(q("stocks-trading-control-gate")?.textContent ?? ""), "refreshed gate")
      const review = q("stocks-trading-control-review")!.textContent!
      assert.match(review, /Resume the manual gate/, "the review still says what was reviewed")
      assert.match(review, /The state was read again while you were reviewing/)
      assert.equal(button("Confirm resume"), null)
      assert.equal(button("Confirm pause"), null, "never the opposite action")
      await click("Back")
      assert.equal(w.document.activeElement, container.querySelector("textarea"), "focus returns to the reason")
      assert.match(text(), /Possible change: pause new orders/)
      assert.equal(postsLogged().length, 0)
    })

    await t.test("a retry refused by the server after a lost answer stays unknown and re-reads; the change is visible as recorded", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume with an ending session")
      loseNextPostResponse = true
      await click("Confirm resume")
      await until(() => outcome() === "unknown", "unknown")
      assert.equal(w.document.activeElement, q("stocks-trading-control-outcome"), "focus moves to the outcome")
      denyNextPost = true
      await readThenRetry()
      await until(() => outcome() === "unknown" && /the retry was refused \(403 OPERATOR_FORBIDDEN\)/.test(text()), "retry refused")
      await until(() => /Manual gate: Resumed/.test(q("stocks-trading-control-gate")?.textContent ?? ""), "re-read shows the recorded change")
      assert.doesNotMatch(q("stocks-trading-control-outcome")!.textContent!, /Nothing was changed|Not applied/)
      assert.deepEqual([postsLogged().map((entry) => entry.status), memory.events.length], [[200, 403], 1])
      assertTraffic("retry refused")
    })

    await t.test("double click on Confirm sends one command", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "One command only")
      const confirm = button("Confirm resume")!
      await act(async () => {
        confirm.dispatchEvent(new w.MouseEvent("click", { bubbles: true }))
        confirm.dispatchEvent(new w.MouseEvent("click", { bubbles: true }))
      })
      await until(() => outcome() === "accepted", "accepted")
      await settle()
      assert.deepEqual([postsLogged().length, memory.events.length], [1, 1])
      assert.doesNotMatch(text(), /Not sent/)
    })

    await t.test("CAS conflict: another operator changes the state first; 409, re-read, nothing resent; a new command uses the new version", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume after my review")
      assert.equal((await directChange(WALLET.controlB, { paused: false, expectedVersion: 0, idempotencyKey: "other-operator-1", reason: "Operator B resumed first" })).statusCode, 200)
      await click("Confirm resume")
      await until(() => outcome() === "conflict", "conflict")
      await until(() => /Operator B resumed first/.test(q("stocks-trading-control-gate")?.textContent ?? ""), "re-read shows B's change")
      await settle()
      assert.deepEqual([postsLogged().length, postsLogged()[0].status], [1, 409], "never resent")
      assert.match(text(), /Not applied: the state changed first \(409\)/)
      await command("Review pause", "Pause after reviewing B's change")
      await click("Confirm pause")
      await until(() => outcome() === "accepted", "new command")
      const second = JSON.parse(postsLogged()[1].body!)
      assert.equal(second.expectedVersion, 1)
      assert.notEqual(second.idempotencyKey, JSON.parse(postsLogged()[0].body!).idempotencyKey)
      assert.deepEqual([memory.events.length, memory.state().paused], [2, true])
      assertTraffic("conflict")
    })

    await t.test("a lost response after the server recorded the change: unknown, then the same key replays; one event", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume with a flaky network")
      loseNextPostResponse = true
      await click("Confirm resume")
      await until(() => outcome() === "unknown", "unknown")
      assert.match(text(), /Result unknown: the resume may or may not have been recorded/)
      assert.match(text(), /Manual gate: Paused/, "not assumed applied")
      assert.equal(memory.events.length, 1, "the server did record it")
      await readThenRetry()
      await until(() => outcome() === "replayed", "replayed")
      const [first, second] = postsLogged()
      assert.equal(second.body, first.body, "identical command and key")
      assert.deepEqual([memory.events.length, memory.state().version], [1, 1], "no second change")
      assert.match(text(), /Already recorded earlier: the resume command \(replayed\)/)
      assert.match(text(), /Manual gate: Resumed/)
      assertTraffic("lost response")
    })

    await t.test("discarding an unknown command keeps an unresolved note, reads again, and lets the operator check the history", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume that is then discarded")
      loseNextPostResponse = true
      await click("Confirm resume")
      await until(() => outcome() === "unknown", "unknown")
      assert.match(q("stocks-trading-control-gate")!.textContent!, /Read before a command whose result is unknown/)
      await click("Discard this command")
      await until(() => /Manual gate: Resumed/.test(q("stocks-trading-control-gate")?.textContent ?? ""), "read again after the discard")
      const card = q("stocks-trading-control-command")!.textContent!
      assert.match(card, /An earlier command has no verified result/)
      assert.match(card, /a version 1 resume with the reason “Resume that is then discarded” means it was recorded; any other change at version 1 means it was not/)
      assert.doesNotMatch(q("stocks-trading-control-gate")!.textContent!, /Read before a command whose result is unknown/, "the fresh read is not flagged")
      await until(() => /Version 1 · was paused/.test(q("stocks-trading-control-history")?.textContent ?? ""), "history shows it")
      assert.equal(outcome(), null)
      assert.ok(button("Review pause"), "a new command from the fresh read")
      await click("Close")
      assert.equal(w.document.activeElement, container.querySelector("textarea"), "focus goes to the reason after closing the note")
      assert.deepEqual([postsLogged().length, memory.events.length], [1, 1], "never resent")
      assertTraffic("discard unknown")
    })

    await t.test("an old resume replayed after a later pause shows the old event and the current paused state", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume that loses its answer")
      loseNextPostResponse = true
      await click("Confirm resume")
      await until(() => outcome() === "unknown", "unknown")
      assert.equal((await directChange(WALLET.controlB, { paused: true, expectedVersion: 1, idempotencyKey: "other-operator-2", reason: "Operator B paused again" })).statusCode, 200)
      await readThenRetry()
      await until(() => outcome() === "replayed", "replayed")
      const outcomeText = q("stocks-trading-control-outcome")!.textContent!
      assert.match(outcomeText, /Version 1: Paused → Resumed/)
      assert.match(outcomeText, /Paused · version 2\. It differs from this request's event: a later change \(version 2\) had been recorded by then\./)
      assert.doesNotMatch(outcomeText, /not a full trading resume/)
      assert.match(q("stocks-trading-control-gate")!.textContent!, /Manual gate: Paused/)
      assert.deepEqual([memory.events.length, memory.state().paused], [2, true], "the replay resumed nothing")
    })

    await t.test("503 after the change was recorded and a client timeout are unknown; a retry replays", async () => {
      await reset()
      await open(mint(WALLET.controlA))
      await command("Review resume", "Resume while the store is flaky")
      memory.failChangeAfterCommit = true
      await click("Confirm resume")
      await until(() => outcome() === "unknown", "503 unknown")
      assert.match(text(), /the server reported that the control result is unavailable \(503\)/)
      memory.failChangeAfterCommit = false
      await readThenRetry()
      await until(() => outcome() === "replayed", "replayed after 503")
      assert.equal(memory.events.length, 1)

      await reset()
      await open(mint(WALLET.controlA), { commandTimeoutMs: 150 })
      await command("Review resume", "Resume with a slow answer")
      const slow = hold((method) => method === "POST")
      await click("Confirm resume")
      await until(() => outcome() === "unknown", "timed out")
      assert.match(text(), /no answer arrived in time/)
      slow.release()
      await settle()
      assert.equal(outcome(), "unknown", "the late answer changes nothing on the page")
      assert.equal(memory.events.length, 1, "the request that left was processed by the server")
      await readThenRetry()
      await until(() => outcome() === "replayed", "replayed after timeout")
      assert.equal(memory.events.length, 1)
      assertTraffic("unknowns")
    })

    await t.test("first commit after an account change or logout shows nothing of the old session; its late answer never lands or resends", async () => {
      for (const change of ["account", "logout", "api"] as const) {
        await reset()
        await open(mint(WALLET.controlA))
        await command("Review resume", `Resume before ${change}`)
        const slow = hold((method) => method === "POST")
        await click("Confirm resume")
        await until(() => outcome() === "sending", "sending")
        let first: string | undefined
        const next = change === "account" ? { session: { id: "session-b", accessToken: mint(WALLET.controlB) } } : change === "logout" ? { session: null } : { apiBase: "https://api-b.invalid" }
        await render({ ...props(mint(WALLET.controlA)), ...next }, (value) => { first ??= value })
        assert.ok(first !== undefined)
        for (const mark of ["Sending the resume command", `Resume before ${change}`, "Manual gate:", "version 0"]) assert.ok(!first.includes(mark), `${change}: first commit shows ${mark}`)
        if (change === "logout") assert.match(first, /Operator session required/)
        slow.release()
        await settle(40)
        assert.equal(outcome(), null, `${change}: the old command's answer is never shown`)
        assert.equal(postsLogged().length, 1, `${change}: never resent`)
        if (change !== "logout") await ready()
        assert.equal(button("Retry the same command"), null)
      }
    })

    await t.test("history pages to the end", async () => {
      await reset()
      const token = mint(WALLET.controlA)
      for (let version = 0; version < 45; version++) memory.apply("ops-control-a", { paused: version % 2 === 1, expectedVersion: version, idempotencyKey: `seed-${String(version).padStart(4, "0")}`, reason: `Seeded change ${version + 1}` })
      await open(token)
      const events = () => container.querySelectorAll('[data-testid="stocks-trading-control-event"]').length
      assert.equal(events(), 20)
      await click("Load older changes")
      await until(() => events() === 40, "second page")
      await click("Load older changes")
      await until(() => events() === 45, "last page")
      assert.match(text(), /End of history: no older changes\./)
      assert.equal(button("Load older changes"), null)
      const versions = [...container.querySelectorAll('[data-testid="stocks-trading-control-event"]')].map((element) => Number(element.getAttribute("data-version")))
      assert.deepEqual(versions, Array.from({ length: 45 }, (_, i) => 45 - i))
      // StrictMode's first mount reads the newest page and is retired, so that page can appear twice; older pages once each.
      const paths = log.filter((entry) => entry.path.includes("/history")).map((entry) => entry.path)
      const newest = paths.filter((path) => path === `${CONTROL}/history?limit=20`).length
      assert.ok(newest >= 1 && newest <= 2, JSON.stringify(paths))
      assert.deepEqual(paths.slice(newest), [`${CONTROL}/history?limit=20&beforeVersion=26`, `${CONTROL}/history?limit=20&beforeVersion=6`])
      assertTraffic("history")
    })

    await t.test("404 (controls not enabled), 503 on read: no change is offered; nothing from an earlier read is presented as current", async () => {
      await reset()
      server = legacy
      root = createRoot(container)
      await render(props(mint(WALLET.controlA)))
      await until(() => /Trading control is not enabled on this server \(404\)/.test(text()), "404")
      await until(() => q("stocks-trading-control-admission")?.getAttribute("data-phase") === "ready", "runtime still shown")
      assert.match(text(), /Not available: trading control is not enabled on this server\./)
      assert.equal(button("Review resume"), null)
      assert.doesNotMatch(text(), /Change history/)

      await reset()
      await open(mint(WALLET.controlA))
      memory.failRead = true
      await click("Refresh")
      await until(() => gatePhase() === "error", "503")
      assert.match(text(), /Trading control state unavailable \(503\)/)
      assert.match(text(), /The state below is from an earlier read at .*; it may no longer be current\. Read it again before changing it\./)
      assert.match(text(), /Read the current state successfully before changing it\./)
      assert.equal(button("Review resume"), null)
      assert.doesNotMatch(text(), /db\.internal|pg:/)
      assertTraffic("errors")
    })
  } finally {
    await reset()
    await full.close()
    await legacy.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
