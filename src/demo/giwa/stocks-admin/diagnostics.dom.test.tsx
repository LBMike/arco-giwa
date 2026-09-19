// 003E: the operator console's wallet submission diagnostics in React DOM + StrictMode, against the REAL server route.
//
// The diagnostics route is the real `stocksSubmissionDiagnosticsPlugin` (real onRequest authorization, publicSnapshot,
// PROFILE envelope and 403/404/503 mapping) behind the real `stocksSessionResolvers` (HS256 SIWE session JWT + operator
// directory), served in-process with `app.inject`. Its reader is a fake that returns raw snapshots, because the real
// reader needs PostgreSQL (Codex's integration). The other admin routes answer from the existing fixtures behind the same
// real operator decision (403 without `stocks:read`, like stocksPlugin's admin routes). Everything the page sends is
// recorded: the request log, not a code grep, proves 0 non-GET requests and 0 wallet access.
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
const TEST_ONLY_SECRET = "test-only-admin-diagnostics-dom"
const DOMAIN = "admin-diagnostics.test"
const OPERATOR_A = "0x000000000000000000000000000000000000a11a"
const OPERATOR_B = "0x000000000000000000000000000000000000b22b"
const READ_ROUTE = /^\/api\/v1\/admin\/stocks\/(overview|orders|orders\/[0-9a-f-]{36}|audit|reconciliations|wallet-submissions\/(BUY|SELL)\/[0-9a-f-]{36})$/

type Logged = { origin: string; method: string; path: string; bearer: string | null; hasBody: boolean; status: number | null; cacheControl: string | null }
type Reply = { status: number; body: unknown }
type Hold = { match: (path: string) => boolean; seen: boolean; release: () => void; waiting: Promise<void>; reply?: Reply }

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16)

test("operator wallet submission diagnostics against the real route (set GIWA_ADMIN_DOM_RUNTIME)", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://${DOMAIN}`, pretendToBeVisual: true })
  const w = dom.window
  // A wallet provider the console must never touch: any read of window.ethereum is counted.
  let walletTouches = 0
  const provider = { request: async () => { throw new Error("the operator console must not call a wallet") }, on() {}, removeListener() {} }
  Object.defineProperty(w, "ethereum", { configurable: true, get() { walletTouches++; return provider } })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

  const Fastify = ((await import("fastify")) as AnyModule).default
  const jwt = (await import("jsonwebtoken")) as AnyModule
  const { stocksSubmissionDiagnosticsPlugin } = (await import("../../../../server/src/stocks-submission-diagnostics/plugin")) as AnyModule
  const { stocksSessionResolvers } = (await import("../../../../server/src/stocks-runtime/session")) as AnyModule
  const { StocksError } = (await import("../../../../server/src/stocks/contracts")) as AnyModule
  const F = (await import("./fixtures")) as typeof import("./fixtures")
  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { GiwaStocksAdminFeature } = (await import("./GiwaStocksAdminFeature")) as AnyModule
  const { act, createElement: h, StrictMode, useLayoutEffect } = React
  const { FIXTURE_IDS: ID, fixtureAttempt: attempt, fixtureHash: hash } = F

  // ---- journal rows per order (distinct hashes and claim ids, so any cross-order leak is visible)
  const rows: Record<string, { approval: unknown; transfer: unknown; enrollment?: "NOT_ENROLLED" }> = {
    [ID.buyFinality]: { approval: attempt("APPROVAL", "CONFIRMED", { txHash: hash("3b"), claimId: "claim-bf-a" }), transfer: attempt("TRANSFER", "SUBMITTED", { txHash: hash("3c"), claimId: "claim-bf-t" }) },
    [ID.buyLarge]: { approval: attempt("APPROVAL", "UNKNOWN", { claimId: "claim-bl-a" }), transfer: null },
    [ID.buyUnknown]: { approval: attempt("APPROVAL", "CONFIRMED", { txHash: hash("c1"), claimId: "claim-bu-a" }), transfer: attempt("TRANSFER", "REQUEST_MAY_START", { claimId: "claim-bu-t" }) },
    [ID.buyCompleted]: { approval: attempt("APPROVAL", "CONFIRMED", { txHash: hash("d1"), claimId: "claim-bc-a" }), transfer: attempt("TRANSFER", "CONFIRMED", { txHash: hash("d2"), claimId: "claim-bc-t" }) },
    [ID.sellLiquidity]: { approval: attempt("APPROVAL", "CONFIRMED", { txHash: hash("e1"), claimId: "claim-sl-a" }), transfer: attempt("TRANSFER", "REVERTED", { txHash: hash("e2"), claimId: "claim-sl-t" }) },
    [ID.sellSettlement]: { approval: attempt("APPROVAL", "CONFIRMED", { txHash: hash("f1"), claimId: "claim-ss-a" }), transfer: attempt("TRANSFER", "CONFIRMED", { txHash: hash("f2"), claimId: "claim-ss-t" }) },
    [ID.sellCompleted]: { approval: null, transfer: null, enrollment: "NOT_ENROLLED" },
  }
  const sideOf = (id: string) => F.FIXTURE_ORDERS.find((order) => order.id === id)!.side as "BUY" | "SELL"
  const marks = (id: string) => [rows[id].approval, rows[id].transfer].flatMap((row) => (row ? [(row as AnyModule).claimId as string, ...((row as AnyModule).txHash ? [(row as AnyModule).txHash as string] : [])] : []))

  // ---- the real diagnostics route, the real session resolver, a fake reader
  type Reader = (side: "BUY" | "SELL", id: string) => Promise<unknown>
  const defaultReader: Reader = async (side, id) => {
    if (!rows[id] || sideOf(id) !== side) throw new StocksError("ORDER_NOT_FOUND", 404)
    return { observedAt: F.FIXTURE_OBSERVED_AT, data: F.fixtureDiagnostics(id, rows[id]) }
  }
  let reader: Reader = defaultReader
  let readerCalls = 0
  const real = stocksSessionResolvers(TEST_ONLY_SECRET, [DOMAIN], [
    { wallet: OPERATOR_A, operatorId: "ops-reader-a", permissions: ["stocks:read"] },
    { wallet: OPERATOR_B, operatorId: "ops-reader-b", permissions: ["stocks:read"] },
  ])
  const revoked = new Set<string>()
  const resolveOperator = async (request: AnyModule) => {
    const operator = await real.resolveOperator(request)
    return operator && !revoked.has(operator.operatorId) ? operator : null
  }
  const app = Fastify({ logger: false })
  await app.register(stocksSubmissionDiagnosticsPlugin, { service: { inspect: (side: "BUY" | "SELL", id: string) => { readerCalls++; return reader(side, id) } }, resolveOperator })
  await app.ready()
  // A server without the diagnostics plugin: its real Fastify 404 is what "route absent" looks like (003E-1).
  const bare = Fastify({ logger: false })
  await bare.ready()
  let routeAbsent = false

  const sign = (jwt.default ?? jwt).sign
  const mint = (wallet: string, lifetimeSeconds = 900) => {
    const iat = Math.floor(Date.now() / 1000)
    return sign({ sub: wallet, domain: DOMAIN, chainId: 91342, iat, exp: iat + lifetimeSeconds }, TEST_ONLY_SECRET, { algorithm: "HS256" }) as string
  }

  // ---- the page's transport: records everything, routes diagnostics to the real plugin
  const log: Logged[] = []
  const holds: Hold[] = []
  let tamper: ((path: string, reply: Reply) => Reply) | null = null
  let offline: ((path: string) => boolean) | null = null
  const fixtures = F.fixtureRoute()
  function hold(match: (path: string) => boolean, reply?: Reply): Hold {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const entry: Hold = { match, seen: false, release: () => release(), waiting, reply }
    holds.push(entry)
    return entry
  }
  // Like a transport that answers late: an aborted request still resolves, so only the client and store can drop it.
  const fetch = async (url: string, init: RequestInit) => {
    const target = new URL(url)
    const path = `${target.pathname}${target.search}`
    const headers = { ...(init.headers as Record<string, string>) }
    const entry: Logged = { origin: target.origin, method: String(init.method ?? "GET").toUpperCase(), path, bearer: headers.authorization ? fingerprint(headers.authorization.slice(7)) : null, hasBody: init.body !== undefined && init.body !== null, status: null, cacheControl: null }
    log.push(entry)
    const held = holds.find((item) => !item.seen && item.match(path))
    if (held) { held.seen = true; await held.waiting }
    if (offline?.(path)) throw new TypeError("network down")
    let reply: Reply
    if (held?.reply) reply = held.reply
    else if (path.startsWith("/api/v1/admin/stocks/wallet-submissions/")) {
      const response = await (routeAbsent ? bare : app).inject({ method: entry.method, url: path, headers })
      entry.cacheControl = String(response.headers["cache-control"] ?? "")
      reply = { status: response.statusCode, body: JSON.parse(response.body) }
    } else {
      const operator = await resolveOperator({ headers })
      reply = operator && operator.permissions.includes("stocks:read") ? (fixtures(path) as Reply) : { status: 403, body: { error: "OPERATOR_FORBIDDEN", ...F.FIXTURE_PROFILE } }
    }
    if (tamper) reply = tamper(path, reply)
    entry.status = reply.status
    const text = JSON.stringify(reply.body)
    return { status: reply.status, text: async () => text }
  }

  // ---- rendering helpers
  const container = w.document.createElement("div")
  w.document.body.appendChild(container)
  const now = () => F.FIXTURE_NOW
  function Host({ props, observe }: { props: AnyModule; observe?: (text: string) => void }) {
    useLayoutEffect(() => { observe?.(container.textContent ?? "") })
    return h(GiwaStocksAdminFeature, props)
  }
  let root: AnyModule | null = null
  const render = async (props: AnyModule, observe?: (text: string) => void) => { await act(async () => root!.render(h(StrictMode, null, h(Host, { props, observe })))) }
  const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await act(async () => { await sleep(1) }) }
  async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 600; i++) {
      if (predicate()) return
      await act(async () => { await sleep(2) })
    }
    throw new Error(`timed out waiting for: ${label}\n${container.textContent?.slice(0, 600)}`)
  }
  const click = async (element: Element | null, label: string) => {
    assert.ok(element, `missing: ${label}`)
    await act(async () => { element!.dispatchEvent(new w.MouseEvent("click", { bubbles: true })) })
  }
  const card = () => container.querySelector('[data-testid="stocks-admin-diagnostics"]')
  const phase = () => card()?.getAttribute("data-phase") ?? null
  const stages = () => [...container.querySelectorAll('[data-testid="stocks-admin-diagnostics-stage"]')].map((element) => `${element.getAttribute("data-stage")}:${element.getAttribute("data-status")}`)
  const text = () => container.textContent ?? ""
  const select = async (id: string) => {
    await click(container.querySelector(`button[aria-label="Show detail for ${sideOf(id)} order ${id}"]`), `row ${id}`)
  }
  const refresh = () => container.querySelector('button[aria-label="Refresh wallet submissions"]')
  const diagnosticsRequests = () => log.filter((entry) => entry.path.startsWith("/api/v1/admin/stocks/wallet-submissions/"))
  const baseProps = (token: string, extra: AnyModule = {}) => ({ apiBase: "https://api-a.invalid", session: { id: "session-a", accessToken: token }, deploymentKey: "deployment-a", initialSection: "orders", fetch, now, ...extra })
  async function openConsole(props: AnyModule) {
    root = createRoot(container)
    await render(props)
    await until(() => text().includes(ID.sellCompleted), "orders list")
  }
  async function showRecord(id: string) {
    await select(id)
    await until(() => phase() === "ready" && stages().length === 2 && text().includes(`Server snapshot ${F.FIXTURE_OBSERVED_AT}`), `record of ${id}`)
  }
  const reset = async () => {
    if (root) await act(async () => root!.unmount())
    root = null
    log.length = 0
    holds.length = 0
    tamper = null
    offline = null
    reader = defaultReader
    revoked.clear()
    routeAbsent = false
  }
  const assertReadOnly = (label: string) => {
    assert.ok(log.length > 0, label)
    for (const entry of log) {
      assert.equal(entry.method, "GET", `${label}: ${entry.path}`)
      assert.equal(entry.hasBody, false, `${label}: ${entry.path}`)
      assert.match(entry.path, READ_ROUTE, label)
    }
    assert.equal(walletTouches, 0, `${label}: the wallet provider was never read`)
  }

  try {
    await t.test("the real route: the signed operator is allowed; a regular user, a missing, forged or expired session is 403; a query is 400", async () => {
      const path = `/api/v1/admin/stocks/wallet-submissions/BUY/${ID.buyFinality}`
      const call = async (authorization?: string, url = path) => app.inject({ method: "GET", url, headers: authorization ? { authorization } : {} })
      const allowed = await call(`Bearer ${mint(OPERATOR_A)}`)
      assert.equal(allowed.statusCode, 200)
      assert.equal(allowed.headers["cache-control"], "no-store")
      const body = JSON.parse(allowed.body)
      assert.deepEqual(Object.keys(body).sort(), ["brokerMode", "chainId", "data", "observedAt", "priceSource", "profile", "valuePolicy"])
      assert.deepEqual([body.data.readOnly, body.data.executionAuthorization, body.data.resubmissionAllowed], [true, false, false])
      const before = readerCalls
      for (const authorization of [`Bearer ${mint(F.FIXTURE_BUYER)}`, undefined, `Bearer ${mint(OPERATOR_A)}x`, `Bearer ${sign({ sub: OPERATOR_A, domain: DOMAIN, chainId: 91342, iat: 1, exp: 2 }, TEST_ONLY_SECRET, { algorithm: "HS256" })}`, `Bearer ${sign({ sub: OPERATOR_A, domain: "other.test", chainId: 91342, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }, TEST_ONLY_SECRET, { algorithm: "HS256" })}`]) {
        const denied = await call(authorization)
        assert.equal(denied.statusCode, 403)
        assert.deepEqual(JSON.parse(denied.body), { error: "OPERATOR_FORBIDDEN", ...F.FIXTURE_PROFILE })
      }
      assert.equal(readerCalls, before, "a denied request never reaches the reader")
      assert.equal((await call(`Bearer ${mint(OPERATOR_A)}`, `${path}?refresh=1`)).statusCode, 400)
    })

    await t.test("signed operator: BUY and SELL records of every status render with the right stage words; only read GETs; no wallet", async () => {
      await reset()
      const token = mint(OPERATOR_A)
      await openConsole(baseProps(token))
      assert.equal(diagnosticsRequests().length, 0, "nothing before an order is selected")
      const expected: [string, string[], RegExp[]][] = [
        [ID.buyFinality, ["APPROVAL:CONFIRMED", "TRANSFER:SUBMITTED"], [/Deposit TRANSFER/, /Hash recorded, receipt not verified/, /not issuance of the shares/]],
        [ID.buyLarge, ["APPROVAL:UNKNOWN", "TRANSFER:NONE"], [/Transaction hash\s*No recorded hash/, /It is not entered, guessed or searched here\. Do not send the approval again\./, /No wallet request is recorded for the deposit\./]],
        [ID.buyUnknown, ["APPROVAL:CONFIRMED", "TRANSFER:REQUEST_MAY_START"], [/A reserved request is a historical record\. It is not permission to send\./]],
        [ID.buyCompleted, ["APPROVAL:CONFIRMED", "TRANSFER:CONFIRMED"], [/Deposit TRANSFER\s*CONFIRMED/, /not issuance of the shares; the order state shows that/]],
        [ID.sellLiquidity, ["APPROVAL:CONFIRMED", "TRANSFER:REVERTED"], [/Escrow TRANSFER\s*REVERTED\s*Receipt verified: reverted/]],
        [ID.sellSettlement, ["APPROVAL:CONFIRMED", "TRANSFER:CONFIRMED"], [/Escrow TRANSFER\s*CONFIRMED/, /not the burn or the cash payout/]],
        [ID.sellCompleted, ["APPROVAL:NONE", "TRANSFER:NONE"], [/Not enrolled: this order has no wallet submission journal\. Nothing was recorded, and this is not permission to send\./, /recorded for the escrow/]],
      ]
      for (const [id, statuses, copies] of expected) {
        await showRecord(id)
        assert.deepEqual(stages(), statuses, id)
        // The card only: the order detail above it has its own (funding evidence) fields.
        const shown = card()?.textContent ?? ""
        for (const copy of copies) assert.match(shown, copy, id)
        for (const mark of marks(id)) assert.ok(shown.includes(mark), `${id} shows its own ${mark}`)
        for (const other of Object.keys(rows).filter((key) => key !== id)) for (const mark of marks(other)) assert.ok(!text().includes(mark), `${id}: the page never shows ${other}'s ${mark}`)
        assert.match(shown, /Quote deadline[^]*Passed as of the snapshot/, "expired orders stay readable")
        assert.ok(!/0x095ea7b3|0xa9059cbb|evidence|calldata/i.test(shown))
      }
      const requests = diagnosticsRequests()
      assert.deepEqual(requests.map((entry) => entry.path), expected.map(([id]) => `/api/v1/admin/stocks/wallet-submissions/${sideOf(id)}/${id}`), "exactly one read per selection, with the detail's side")
      for (const entry of requests) {
        assert.equal(entry.status, 200)
        assert.equal(entry.cacheControl, "no-store")
        assert.equal(entry.bearer, fingerprint(token), "the signed session Bearer only")
        const detailAt = log.findIndex((item) => item.path === `/api/v1/admin/stocks/orders/${entry.path.split("/").pop()}`)
        assert.ok(detailAt >= 0 && detailAt < log.indexOf(entry), "the side comes from the loaded detail")
      }
      assertReadOnly("operator walk-through")
      await settle()
      assert.equal(diagnosticsRequests().length, expected.length, "no background polling")
    })

    await t.test("a regular signed user is refused by the server; a permission revoked mid-session hides everything on the next answer", async () => {
      await reset()
      root = createRoot(container)
      await render(baseProps(mint(F.FIXTURE_BUYER)))
      await until(() => text().includes("No Stocks read permission (403)"), "forbidden")
      assert.ok(!text().includes(ID.buyFinality))
      assert.equal(diagnosticsRequests().length, 0)
      await reset()
      await openConsole(baseProps(mint(OPERATOR_A)))
      const gate = hold((path) => path.includes("/wallet-submissions/"))
      await select(ID.buyFinality)
      await until(() => gate.seen && text().includes("Funding (BUY)"), "detail loaded, diagnostics in flight")
      revoked.add("ops-reader-a")
      gate.release()
      await until(() => text().includes("No Stocks read permission (403)"), "the real route's 403")
      assert.equal(diagnosticsRequests()[0].status, 403)
      assert.ok(!text().includes(ID.buyFinality) && !text().includes("Wallet submissions"), "no order, detail or record remains")
      assertReadOnly("revocation")
    })

    await t.test("401 (a stand-in: the real route answers 403 for any unverified session) clears the console", async () => {
      await reset()
      await openConsole(baseProps(mint(OPERATOR_A)))
      tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { status: 401, body: { error: "Invalid bearer session token" } } : reply)
      await select(ID.buyFinality)
      await until(() => text().includes("Session missing or expired (401)"), "401")
      assert.ok(!text().includes(ID.buyFinality))
    })

    await t.test("404, 503, an invalid answer and a network failure stay on the card; retry and a failed refresh are labelled", async () => {
      await reset()
      await openConsole(baseProps(mint(OPERATOR_A)))
      const cases: [string, () => void, RegExp][] = [
        ["reader failure → 503", () => { reader = async () => { throw new Error("pg: connection terminated host=db.internal password=hunter2") } }, /Diagnostics unavailable \(503\)/],
        ["invalid raw snapshot → 503 by publicSnapshot", () => { reader = async (_side, id) => ({ observedAt: F.FIXTURE_OBSERVED_AT, data: { ...F.fixtureDiagnostics(id, rows[id]), resubmissionAllowed: true } }) }, /Diagnostics unavailable \(503\)/],
        ["order not in this deployment → 404", () => { reader = async () => { throw new StocksError("ORDER_NOT_FOUND", 404) } }, /Order not found in the current deployment \(404\)/],
        ["wrong PROFILE", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as object), profile: "PRODUCTION" } } : reply) }, /Response did not match the diagnostics contract/],
        ["other side in the answer", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as AnyModule), data: { ...(reply.body as AnyModule).data, order: { ...(reply.body as AnyModule).data.order, side: "SELL", state: "SETTLEMENT_PENDING" } } } } : reply) }, /Response did not match the diagnostics contract/],
        ["other order in the answer", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as AnyModule), data: { ...(reply.body as AnyModule).data, order: { ...(reply.body as AnyModule).data.order, id: ID.buyUnknown } } } } : reply) }, /Response did not match the diagnostics contract/],
        ["execution authorization", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as AnyModule), data: { ...(reply.body as AnyModule).data, executionAuthorization: true } } } : reply) }, /Response did not match the diagnostics contract/],
        ["resubmission allowed", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as AnyModule), data: { ...(reply.body as AnyModule).data, resubmissionAllowed: true } } } : reply) }, /Response did not match the diagnostics contract/],
        ["read only false", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as AnyModule), data: { ...(reply.body as AnyModule).data, readOnly: false } } } : reply) }, /Response did not match the diagnostics contract/],
        ["raw calldata field", () => { tamper = (path, reply) => (path.includes("/wallet-submissions/") ? { ...reply, body: { ...(reply.body as AnyModule), data: { ...(reply.body as AnyModule).data, calldata: "0xa9059cbb" } } } : reply) }, /Response did not match the diagnostics contract/],
        ["network", () => { offline = (path) => path.includes("/wallet-submissions/") }, /Could not reach the API/],
      ]
      // First read of the selected order fails; each explicit Refresh re-reads under the next failure.
      reader = async () => { throw new Error("warm-up failure") }
      await select(ID.buyFinality)
      await until(() => phase() === "error", "first failure")
      for (const [name, arrange, copy] of cases) {
        reader = defaultReader
        tamper = null
        offline = null
        arrange()
        const before = diagnosticsRequests().length
        await click(refresh(), "refresh")
        await until(() => diagnosticsRequests().length === before + 1 && phase() === "error" && copy.test(text()), name)
        assert.deepEqual(stages(), [], `${name}: nothing of the answer is shown`)
        assert.ok(!text().includes("Server snapshot"), name)
        assert.ok(!/hunter2|db\.internal|pg:|SUBMISSION_DIAGNOSTICS_UNAVAILABLE|calldata/.test(text()), `${name}: no internal error text`)
        assert.ok(text().includes("Funding (BUY)") && text().includes(ID.sellCompleted), `${name}: the rest of the console stays`)
        assert.ok(card()?.querySelector('[role="alert"]'), `${name}: the error is announced`)
      }
      // Retry after a failure.
      reader = defaultReader
      tamper = null
      offline = null
      await click(refresh(), "retry")
      await until(() => phase() === "ready" && stages().join() === "APPROVAL:CONFIRMED,TRANSFER:SUBMITTED", "retry succeeds")
      assert.ok(!/Diagnostics unavailable|Could not reach/.test(text()))
      // A failed refresh keeps the earlier record, never as current.
      reader = async () => { throw new Error("later failure") }
      await click(refresh(), "failed refresh")
      await until(() => phase() === "error", "failed refresh")
      assert.match(text(), new RegExp(`The record below is from the earlier snapshot ${F.FIXTURE_OBSERVED_AT}, not a current one\\.`))
      assert.deepEqual(stages(), ["APPROVAL:CONFIRMED", "TRANSFER:SUBMITTED"])
      assertReadOnly("errors")
    })

    await t.test("first commit after logout, another operator, API base or deployment shows no record; a token rotation keeps it", async () => {
      for (const change of ["logout", "operator-B", "api-base", "deployment", "token"] as const) {
        await reset()
        const tokenA = mint(OPERATOR_A)
        const props = baseProps(tokenA)
        await openConsole(props)
        await showRecord(ID.buyFinality)
        let first: string | undefined
        const next: AnyModule = { ...props }
        const rotated = mint(OPERATOR_A, 899)
        if (change === "logout") next.session = null
        if (change === "operator-B") next.session = { id: "session-b", accessToken: mint(OPERATOR_B) }
        if (change === "api-base") next.apiBase = "https://api-b.invalid"
        if (change === "deployment") next.deploymentKey = "deployment-b"
        if (change === "token") next.session = { id: "session-a", accessToken: rotated }
        await render(next, (value) => { first ??= value })
        assert.ok(first !== undefined)
        if (change === "token") {
          assert.ok(first.includes(hash("3c")), "a token-only change keeps the record")
          const before = diagnosticsRequests().length
          await click(refresh(), "refresh after rotation")
          await until(() => diagnosticsRequests().length === before + 1 && phase() === "ready", "refresh with the new token")
          assert.equal(diagnosticsRequests()[diagnosticsRequests().length - 1].bearer, fingerprint(rotated))
          assert.notEqual(fingerprint(rotated), fingerprint(tokenA))
        } else {
          for (const mark of [...marks(ID.buyFinality), "Wallet submissions", "Server snapshot", F.FIXTURE_OBSERVED_AT]) assert.ok(!first.includes(mark), `${change}: first commit shows ${mark}`)
          await settle()
          for (const mark of marks(ID.buyFinality)) assert.ok(!text().includes(mark), `${change}: later commits too`)
          if (change === "logout") assert.match(text(), /Operator session required/)
        }
      }
      assertReadOnly("scope changes")
    })

    await t.test("selecting another order hides the record at once; the old order's late answer and an old session's late 403 never land", async () => {
      await reset()
      await openConsole(baseProps(mint(OPERATOR_A)))
      await showRecord(ID.buyFinality)
      // Selection change while the new order's diagnostics are still in flight.
      const gate = hold((path) => path.endsWith(`/SELL/${ID.sellSettlement}`))
      await select(ID.sellSettlement)
      for (const mark of marks(ID.buyFinality)) assert.ok(!text().includes(mark), `first commit after selection: ${mark}`)
      await until(() => gate.seen, "SELL diagnostics in flight")
      assert.deepEqual(stages(), [])
      gate.release()
      await until(() => phase() === "ready" && stages().join() === "APPROVAL:CONFIRMED,TRANSFER:CONFIRMED", "SELL record")

      // Late answer for the previous order.
      const late = hold((path) => path.endsWith(`/BUY/${ID.buyLarge}`))
      await select(ID.buyLarge)
      await until(() => late.seen, "BUY large in flight")
      await select(ID.sellLiquidity)
      await until(() => phase() === "ready" && stages().join() === "APPROVAL:CONFIRMED,TRANSFER:REVERTED", "SELL liquidity record")
      late.release()
      await settle()
      assert.deepEqual(stages(), ["APPROVAL:CONFIRMED", "TRANSFER:REVERTED"], "the late answer never replaced the current order")
      for (const mark of marks(ID.buyLarge)) assert.ok(!text().includes(mark))

      // An old session's late answers (a record and a 403) after operator B took over.
      const oldRecord = hold((path) => path.endsWith(`/BUY/${ID.buyCompleted}`))
      await select(ID.buyCompleted)
      await until(() => oldRecord.seen, "A's read in flight")
      await render(baseProps(mint(OPERATOR_B), { session: { id: "session-b", accessToken: mint(OPERATOR_B) } }))
      await until(() => text().includes(ID.sellCompleted) && !text().includes("Wallet submissions"), "B's console")
      oldRecord.release()
      await settle()
      for (const mark of marks(ID.buyCompleted)) assert.ok(!text().includes(mark), `B never sees A's ${mark}`)
      const oldDenied = hold((path) => path.endsWith(`/SELL/${ID.sellSettlement}`), { status: 403, body: { error: "OPERATOR_FORBIDDEN", ...F.FIXTURE_PROFILE } })
      await select(ID.sellSettlement)
      await until(() => oldDenied.seen, "B's read in flight")
      await render(baseProps(mint(OPERATOR_A), { session: { id: "session-a2", accessToken: mint(OPERATOR_A) } }))
      await until(() => text().includes(ID.sellCompleted), "A2's console")
      oldDenied.release()
      await settle()
      assert.ok(!text().includes("No Stocks read permission"), "an old session's 403 never invalidates the new one")
      await showRecord(ID.buyFinality)
      assertReadOnly("late answers")
    })

    await t.test("003E-1: a 404 refresh (order or route) after a successful read keeps the earlier record and never says nothing is shown; a first 404 shows nothing", async () => {
      const cases: [string, () => void, string, string][] = [
        ["not_found", () => { reader = async () => { throw new StocksError("ORDER_NOT_FOUND", 404) } }, "Order not found in the current deployment (404)", "The server has no such order in the deployment it serves now."],
        ["disabled", () => { routeAbsent = true }, "Wallet submission diagnostics are not available on this server (404)", "The diagnostics route is not registered."],
      ]
      for (const [kind, arrange, title, first] of cases) {
        await reset()
        await openConsole(baseProps(mint(OPERATOR_A)))
        await showRecord(ID.buyFinality)
        arrange()
        const count = diagnosticsRequests().length
        await click(refresh(), `${kind} refresh`)
        await until(() => diagnosticsRequests().length === count + 1 && phase() === "error", `${kind}: refresh answered 404`)
        const requests = diagnosticsRequests()
        assert.equal(requests[requests.length - 1].status, 404, `${kind}: a real 404`)
        const kept = card()?.textContent ?? ""
        assert.ok(!/nothing is shown/i.test(kept), `${kind}: contradicts the kept record: ${kept.slice(0, 400)}`)
        assert.ok(kept.includes(title), kind)
        assert.ok(kept.includes(`${first} No new diagnostics were received. The record below is from the earlier snapshot ${F.FIXTURE_OBSERVED_AT}, not a current one.`), `${kind}: ${kept.slice(0, 400)}`)
        assert.ok(card()?.querySelector('[role="alert"]'), `${kind}: announced`)
        // The kept record is the real earlier one: same hashes, claims and snapshot time.
        for (const mark of marks(ID.buyFinality)) assert.ok(kept.includes(mark), `${kind}: kept ${mark}`)
        assert.ok(kept.includes(`Server snapshot ${F.FIXTURE_OBSERVED_AT}`))
        assert.deepEqual(stages(), ["APPROVAL:CONFIRMED", "TRANSFER:SUBMITTED"])

        // A first 404 for another order: nothing is kept, and the card says so.
        await select(ID.sellSettlement)
        await until(() => diagnosticsRequests().length === count + 2 && phase() === "error", `${kind}: first 404`)
        const empty = card()?.textContent ?? ""
        assert.ok(empty.includes(title) && empty.includes(`${first} Nothing is shown.`), `${kind}: ${empty.slice(0, 400)}`)
        assert.ok(!empty.includes("earlier snapshot") && !empty.includes("Server snapshot"), kind)
        assert.deepEqual(stages(), [])
        for (const id of [ID.buyFinality, ID.sellSettlement]) for (const mark of marks(id)) assert.ok(!text().includes(mark), `${kind}: ${mark} not on the page`)
        assert.equal(text().includes("No Stocks read permission"), false, `${kind}: stays on the card`)
        assertReadOnly(`404 ${kind}`)
      }
    })

    await t.test("double clicks: one detail and one diagnostics read per selection; Refresh while loading adds nothing", async () => {
      await reset()
      await openConsole(baseProps(mint(OPERATOR_A)))
      const row = container.querySelector(`button[aria-label="Show detail for BUY order ${ID.buyFinality}"]`)
      await act(async () => {
        row!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }))
        row!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }))
      })
      await until(() => phase() === "ready" && stages().length === 2, "record")
      await settle()
      assert.equal(log.filter((entry) => entry.path === `/api/v1/admin/stocks/orders/${ID.buyFinality}`).length, 1)
      assert.equal(diagnosticsRequests().length, 1)
      const gate = hold((path) => path.includes("/wallet-submissions/"))
      const button = refresh()
      await act(async () => {
        button!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }))
        button!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }))
      })
      await until(() => gate.seen, "refresh in flight")
      assert.equal(refresh()?.hasAttribute("disabled"), true)
      await click(refresh(), "click on the busy button")
      gate.release()
      await until(() => phase() === "ready", "refreshed")
      await settle()
      assert.equal(diagnosticsRequests().length, 2, "one refresh request for three clicks")
      assertReadOnly("double clicks")
    })
  } finally {
    await reset()
    await app.close()
    await bare.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
