import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import {
  FIXTURE_AUDIT,
  FIXTURE_BUY_COMPLETED_DETAIL,
  FIXTURE_BUY_DETAIL,
  FIXTURE_IDS,
  FIXTURE_NOW,
  FIXTURE_ORDERS,
  FIXTURE_OVERVIEW,
  FIXTURE_RECONCILIATIONS,
  FIXTURE_SELL_DETAIL,
  fixtureEnvelope,
} from "./fixtures"
import { GiwaStocksAdminFeature, SECTIONS, StocksAdminView, latestMeta, nextSectionIndex } from "./GiwaStocksAdminFeature"
import { filterOrders, DEFAULT_FILTERS } from "./OrdersPanel"
import { auditRange } from "./AuditPanel"
import { parseAudit, parseEnvelope, parseOrderDetail, parseOrders, parseOverview, parseReconciliation } from "./parse"
import type {
  AccessState,
  Loaded,
  ReconciliationStatus,
  ResourceState,
  StocksAdminError,
  StocksAdminSection,
  StocksAdminSnapshot,
} from "./types"

const META = parseEnvelope(fixtureEnvelope(null)).meta
const IDLE = { phase: "idle", value: null, error: null } as const

function loaded<T>(data: T, ageMs = 5_000): ResourceState<T> {
  const value: Loaded<T> = { data, meta: META, loadedAt: FIXTURE_NOW - ageMs }
  return { phase: "ready", value, error: null }
}

function failed(kind: StocksAdminError["kind"], status: number | null = null): ResourceState<never> {
  return { phase: "error", value: null, error: { kind, status, code: null } }
}

function snapshot(patch: Partial<StocksAdminSnapshot> = {}, access: AccessState = "ok"): StocksAdminSnapshot {
  return {
    scopeKey: "scope",
    access,
    overview: IDLE,
    orders: IDLE,
    reconciliation: IDLE,
    audit: IDLE,
    detail: { ...IDLE, orderId: null },
    ...patch,
  }
}

const noop = () => {}

function render(state: StocksAdminSnapshot, section: StocksAdminSection = "overview", onSignInRequired?: () => void) {
  return renderToStaticMarkup(
    <StocksAdminView
      snapshot={state}
      section={section}
      now={FIXTURE_NOW}
      onSectionChange={noop}
      onLoad={noop}
      onSelectOrder={noop}
      onOpenOrder={noop}
      onRefreshDetail={noop}
      onRetryAccess={noop}
      onSignInRequired={onSignInRequired}
    />,
  )
}

/** Visible text with tags removed and entities decoded, for readable assertions. */
function text(html: string): string {
  return html
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
}

const full = () =>
  snapshot({
    overview: loaded(parseOverview(FIXTURE_OVERVIEW)),
    orders: loaded(parseOrders(FIXTURE_ORDERS)),
    audit: loaded(parseAudit(FIXTURE_AUDIT)),
    reconciliation: loaded(parseReconciliation(FIXTURE_RECONCILIATIONS.MATCHED_AT_CUTOFF)),
  })

test("overview shows BUY/SELL state counts, unfinished orders and the server-reported environment", () => {
  const html = render(full())
  const t = text(html)
  assert.match(t, /BUY orders by state/)
  assert.match(t, /SELL orders by state/)
  assert.match(t, /4 orders · 3 not finished/)
  assert.match(t, /3 orders · 2 not finished/)
  assert.match(t, /BROKER_UNKNOWN .*Outcome unknown/)
  assert.match(t, /Unfinished orders/)
  assert.match(t, /From the latest 7 orders the server returned \(limit 200\)/)
  for (const label of ["DEMO_TESTNET", "MOCK_BROKER", "TEST_VALUE_ONLY", "FIXED_MOCK_PRICE", "Chain 91342"]) assert.ok(t.includes(label), label)
  assert.match(t, /the response time, not a claim that chain data is current/)
  assert.match(t, /Deployment \(from loaded orders\): giwa-stocks-testnet-v2/)
})

test("overview flags unfinished orders that the 200-row list cannot show", () => {
  const overview = parseOverview([...FIXTURE_OVERVIEW, { side: "BUY", state: "MINT_UNKNOWN", count: "40", cashAmount: "4800000000" }])
  const t = text(render(snapshot({ overview: loaded(overview), orders: loaded(parseOrders(FIXTURE_ORDERS)) })))
  assert.match(t, /40 unfinished orders are not in the loaded list/)
})

test("large amounts are shown exactly with unit and raw base units", () => {
  const t = text(render(full()))
  assert.ok(t.includes("123,456,789,012,345,678,901,234,567.890123456 NVDA"))
  assert.ok(t.includes("987,654,321,098,765,432,109,876,543,210.987654 TEST_CASH"))
  assert.ok(t.includes("987654321098765432109876543210987654 base units · scale 6"))
  assert.ok(!/USDC|RLUSD/.test(t), "admin responses carry no cash symbol; nothing claims USDC/RLUSD")
})

test("BUY detail shows funding, mint holding, operations with hashes and the ordered audit trail", () => {
  const detail = { ...loaded(parseOrderDetail(FIXTURE_BUY_DETAIL)), orderId: FIXTURE_IDS.buyFinality }
  const t = text(render(snapshot({ orders: loaded(parseOrders(FIXTURE_ORDERS)), detail }), "orders"))
  assert.match(t, /Funding \(BUY\)/)
  assert.match(t, /Accepted for this order · reason EXACT_ORDER_FUNDING/)
  assert.match(t, /No finalized mint holding recorded for this order/)
  assert.ok(!t.includes("Escrow custody"))
  assert.ok(!t.includes("Cash reservations"))
  assert.ok(t.includes(FIXTURE_BUY_DETAIL.funding[0].txHash))
  assert.ok(t.includes(FIXTURE_BUY_DETAIL.operations[1].txHash as string))
  assert.match(t, /Submitted — waiting for finality/)
  assert.match(t, /No transaction \(off-chain step or not yet submitted\)/)
  assert.match(t, /Worker lease until/)
  const actions = FIXTURE_BUY_DETAIL.audit.map((row) => row.action)
  const positions = actions.map((action) => t.indexOf(`${action} 2026-`))
  assert.ok(positions.every((position, i) => position > 0 && (i === 0 || position > positions[i - 1])), "audit is shown oldest first")

  const completed = { ...loaded(parseOrderDetail(FIXTURE_BUY_COMPLETED_DETAIL)), orderId: FIXTURE_IDS.buyCompleted }
  const done = text(render(snapshot({ detail: completed }), "orders"))
  assert.match(done, /Mint holding .*Finalized block 19834211|Finalized block 19830042/)
  assert.ok(done.includes(FIXTURE_BUY_COMPLETED_DETAIL.holdings[0].blockHash))
})

test("a detail whose order id differs from the selected order is never rendered", () => {
  const mismatched = { ...loaded(parseOrderDetail(FIXTURE_SELL_DETAIL)), orderId: FIXTURE_IDS.buyFinality }
  const t = text(render(snapshot({ detail: mismatched }), "orders"))
  assert.ok(!t.includes("Escrow custody"))
  assert.ok(!t.includes(FIXTURE_SELL_DETAIL.custody[0].escrowId))
})

test("SELL detail shows escrow custody and cash reservations instead of funding", () => {
  const detail = { ...loaded(parseOrderDetail(FIXTURE_SELL_DETAIL)), orderId: FIXTURE_IDS.sellSettlement }
  const t = text(render(snapshot({ detail }), "orders"))
  assert.match(t, /Escrow custody \(SELL\)/)
  assert.match(t, /REDEEM_PENDING Redemption pending · reason EXACT_ESCROW/)
  assert.match(t, /Cash reservations \(SELL\)/)
  assert.match(t, /RESERVED Reserved/)
  assert.ok(t.includes(FIXTURE_SELL_DETAIL.custody[0].escrowId))
  assert.ok(!t.includes("Funding (BUY)"))
  assert.ok(!t.includes("Mint holding"))
  assert.ok(!t.includes("Worker lease until"), "SELL operations carry no lease column")
  assert.match(t, /Cash payout/)
})

test("empty successful responses say none; they are the only place zero is shown", () => {
  const empty = snapshot({ overview: loaded([]), orders: loaded([]), audit: loaded([]) })
  assert.match(text(render(empty)), /No BUY orders recorded\..*No SELL orders recorded\..*No unfinished orders in the loaded list/)
  assert.match(text(render(empty, "orders")), /The server returned no orders for this deployment/)
  assert.match(text(render(empty, "audit")), /The server returned no audit entries for this deployment/)
})

test("failed or invalid loads never render as zero, empty or healthy", () => {
  const state = snapshot({ overview: failed("invalid", 200), orders: failed("network"), audit: failed("server", 500) })
  const overview = text(render(state))
  assert.match(overview, /Response did not match the Stocks admin contract/)
  assert.match(overview, /Unfinished orders cannot be listed\. This is not a zero count\./)
  assert.ok(!/No BUY orders|No unfinished orders|0 orders/.test(overview))
  const orders = text(render(state, "orders"))
  assert.match(orders, /Could not reach the API/)
  assert.ok(!/returned no orders|Showing 0/.test(orders))
  const audit = text(render(state, "audit"))
  assert.match(audit, /Server error \(500\)/)
  assert.ok(!/no audit entries/.test(audit))
})

test("a failed refresh keeps the last data labelled with its load time; old data is flagged", () => {
  const stale: ResourceState<ReturnType<typeof parseOrders>> = {
    phase: "error",
    value: { data: parseOrders(FIXTURE_ORDERS), meta: META, loadedAt: FIXTURE_NOW - 120_000 },
    error: { kind: "server", status: 503, code: null },
  }
  assert.match(text(render(snapshot({ orders: stale }), "orders")), /The data below is from the last successful load at 2026-09-17 02:58:30 UTC/)
  const old = text(render(snapshot({ audit: loaded(parseAudit(FIXTURE_AUDIT), 61_000) }), "audit"))
  assert.match(old, /Loaded more than 60 seconds ago/)
})

test("API disabled, 401, 403 and signed-out states show no data, environment or tabs", () => {
  const cases: [AccessState, RegExp][] = [
    ["disabled", /Stocks admin API is not enabled on this server/],
    ["unauthorized", /Session missing or expired \(401\).*previously loaded Stocks data has been cleared/],
    ["forbidden", /No Stocks read permission \(403\).*also answers 403 when it cannot verify the session.*cleared/],
    ["signed_out", /Operator session required.*the legacy operator token is not used/],
  ]
  for (const [access, pattern] of cases) {
    const html = render(snapshot({}, access), "overview", noop)
    const t = text(html)
    assert.match(t, pattern, access)
    assert.ok(!html.includes('role="tablist"'), access)
    assert.ok(!t.includes("DEMO_TESTNET"), access)
    assert.equal(t.includes("Sign in with operator wallet"), access === "signed_out" || access === "unauthorized", access)
    assert.equal(t.includes("Check access again"), access !== "signed_out", access)
  }
})

const RECONCILIATION_EXPECTATIONS: Record<ReconciliationStatus, { must: RegExp[]; mustNot: RegExp[] }> = {
  MATCHED_AT_CUTOFF: {
    must: [/Matched at the finalized cutoff block/, /through finalized block 19,834,211/, /does not say current balances match or that the vault is solvent now/, /Current ledger liabilities.*not at the cutoff block/],
    mustNot: [/Differences at the cutoff/, /all balances match/i, /fully reconciled/i],
  },
  MISMATCH: {
    must: [/Mismatch at the finalized cutoff block/, /differ for 2 values/, /Differences at the cutoff \(2\)/, /480 TEST_CASH.*479 TEST_CASH/, /STOCK_WALLET/, /no correction, mint or balance-edit command/],
    mustNot: [/Matched at/],
  },
  UNAVAILABLE: {
    must: [/Reconciliation unavailable — no comparison was made/, /not a zero difference and not a match/, /NO_FINALIZED_OBSERVER_COVERAGE — No trusted finalized observer coverage/, /In-flight attention items \(5\)/],
    mustNot: [/Finalized chain values/, /Current ledger liabilities/, /Matched at/, /Differences at the cutoff/],
  },
  INCOMPLETE: {
    must: [/Reconciliation incomplete — no comparison was made/, /STALE_OR_INVALID_OBSERVER_COVERAGE/, /Observer coverage reported \(not used for a comparison\)/, /2m 20s — older than the 60 s coverage window/],
    mustNot: [/Finalized chain values/, /Matched at/, /Differences at the cutoff/],
  },
}

test("reconciliation distinguishes MATCHED_AT_CUTOFF, MISMATCH, UNAVAILABLE and INCOMPLETE", () => {
  for (const status of Object.keys(RECONCILIATION_EXPECTATIONS) as ReconciliationStatus[]) {
    const state = snapshot({ reconciliation: loaded(parseReconciliation(FIXTURE_RECONCILIATIONS[status])) })
    const t = text(render(state, "reconciliation"))
    assert.ok(t.includes(status), status)
    for (const pattern of RECONCILIATION_EXPECTATIONS[status].must) assert.match(t, pattern, `${status} must ${pattern}`)
    for (const pattern of RECONCILIATION_EXPECTATIONS[status].mustNot) assert.doesNotMatch(t, pattern, `${status} must not ${pattern}`)
  }
})

test("orders and audit state the 200-row server limit; filters work only on loaded rows", () => {
  const rows = parseOrders(Array.from({ length: 200 }, (_, i) => ({ ...FIXTURE_ORDERS[i % FIXTURE_ORDERS.length], id: `order-${i}` })))
  const t = text(render(snapshot({ orders: loaded(rows) }), "orders"))
  assert.match(t, /latest 200 BUY and SELL orders \(newest first, limit 200\)/)
  assert.match(t, /no pagination, total count or server-side filter/)
  assert.match(t, /Limit of 200 reached.*Older orders may exist and are not loaded/)
  assert.match(t, /Showing 200 of 200 loaded orders/)

  const audit = parseAudit(Array.from({ length: 200 }, (_, i) => ({ ...FIXTURE_AUDIT[0], id: `a-${i}`, createdAt: new Date(FIXTURE_NOW - i * 1000).toISOString() })))
  const a = text(render(snapshot({ audit: loaded(audit) }), "audit"))
  assert.match(a, /latest 200 immutable audit entries .*limit 200/)
  assert.match(a, /Returned range: 2026-09-17 02:57:11 UTC to 2026-09-17 03:00:30 UTC/)
  assert.match(a, /Limit of 200 reached/)
  assert.deepEqual(auditRange([]), null)

  const all = parseOrders(FIXTURE_ORDERS)
  assert.equal(filterOrders(all, DEFAULT_FILTERS).length, 7)
  assert.deepEqual(filterOrders(all, { ...DEFAULT_FILTERS, side: "SELL" }).map((row) => row.side), ["SELL", "SELL", "SELL"])
  assert.equal(filterOrders(all, { ...DEFAULT_FILTERS, category: "IN_PROGRESS" }).length, 5)
  assert.deepEqual(filterOrders(all, { ...DEFAULT_FILTERS, category: "unknown" }).map((row) => row.state), ["BROKER_UNKNOWN"])
  assert.deepEqual(filterOrders(all, { ...DEFAULT_FILTERS, query: FIXTURE_IDS.sellSettlement.toUpperCase() }).map((row) => row.id), [FIXTURE_IDS.sellSettlement])
})

test("the console renders no command buttons — only navigation, refresh, selection and access checks", () => {
  const detail = { ...loaded(parseOrderDetail(FIXTURE_SELL_DETAIL)), orderId: FIXTURE_IDS.sellSettlement }
  const htmls = [
    render({ ...full(), detail }, "overview"),
    render({ ...full(), detail }, "orders"),
    render({ ...full(), detail }, "reconciliation"),
    render({ ...full(), detail }, "audit"),
    render(snapshot({ reconciliation: loaded(parseReconciliation(FIXTURE_RECONCILIATIONS.MISMATCH)) }), "reconciliation"),
    render(snapshot({}, "unauthorized"), "overview", noop),
  ]
  const allowed = [/^(Operations overview|Orders|Balance reconciliation|Audit history)$/, /^Refresh(ing…)?$/, /^Open detail$/, /^0x[0-9a-f]{4}…[0-9a-f]{4}|^[0-9a-f]{6}…/, /^Check access again$/, /^Sign in with operator wallet$/]
  for (const html of htmls) {
    for (const match of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
      const label = text(match[1]).trim().replace(/\s+[0-9a-f-]{36}$/, "")
      assert.ok(allowed.some((pattern) => pattern.test(label)), `unexpected button: ${label}`)
    }
    assert.doesNotMatch(html, /<form\b|type="submit"|<input(?![^>]*type="search")/)
  }
})

test("keyboard model: one tab stop in the tablist, arrows/Home/End move, panels and scroll regions are labelled", () => {
  const html = render(full(), "reconciliation")
  assert.equal((html.match(/role="tab"/g) ?? []).length, SECTIONS.length)
  assert.equal((html.match(/role="tab"[^>]*tabindex="0"|tabindex="0"[^>]*role="tab"/g) ?? []).length, 1)
  assert.match(html, /aria-selected="true"[^>]*>Balance reconciliation</)
  assert.match(html, /role="tabpanel"[^>]*aria-labelledby="[^"]+-tab-reconciliation"/)
  assert.match(html, /role="table" aria-label="In-flight attention items"/)
  assert.ok(!html.includes("overflow-x-auto"), "no horizontally scrolling tables")
  assert.equal(nextSectionIndex(0, "ArrowRight", 4), 1)
  assert.equal(nextSectionIndex(3, "ArrowRight", 4), 0)
  assert.equal(nextSectionIndex(0, "ArrowLeft", 4), 3)
  assert.equal(nextSectionIndex(1, "ArrowDown", 4), 2)
  assert.equal(nextSectionIndex(2, "Home", 4), 0)
  assert.equal(nextSectionIndex(0, "End", 4), 3)
  assert.equal(nextSectionIndex(1, "Enter", 4), null)

  const orders = render(snapshot({ orders: loaded(parseOrders(FIXTURE_ORDERS)), detail: { ...IDLE, orderId: FIXTURE_IDS.buyUnknown, phase: "loading" } }), "orders")
  assert.match(orders, new RegExp(`role="row" aria-current="true"[^]*?aria-pressed="true" aria-label="Show detail for BUY order ${FIXTURE_IDS.buyUnknown}"`))
  assert.equal((orders.match(/aria-pressed="false"/g) ?? []).length, FIXTURE_ORDERS.length - 1)
  assert.match(orders, /<label[^>]*>Search loaded orders<input type="search"/)
})

test("environment comes from the most recently loaded server response", () => {
  const older = { data: [], meta: { ...META, observedAt: "2026-09-17T02:00:00.000Z" }, loadedAt: 1 }
  const newer = { data: [], meta: { ...META, observedAt: "2026-09-17T03:00:00.000Z" }, loadedAt: 2 }
  const state = snapshot({ overview: { phase: "ready", value: older, error: null }, audit: { phase: "ready", value: newer, error: null } })
  assert.equal(latestMeta(state)?.observedAt, "2026-09-17T03:00:00.000Z")
  assert.equal(latestMeta(snapshot()), null)
  assert.match(text(render(snapshot())), /Environment not yet reported by the server/)
})

test("the root feature without a session renders the signed-out state and requests nothing", () => {
  let calls = 0
  const html = renderToStaticMarkup(
    <GiwaStocksAdminFeature apiBase="https://api.example.test" session={null} fetch={async () => { calls += 1; return { status: 200, text: async () => "" } }} now={() => FIXTURE_NOW} />,
  )
  assert.match(text(html), /Operator session required/)
  assert.equal(calls, 0)
})

test("feature source never uses the legacy operator token, browser allowlist, storage or fixtures", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx$/.test(name) && name !== "fixtures.ts")
  assert.ok(sources.includes("GiwaStocksAdminFeature.tsx"))
  for (const name of sources) {
    // Code only: comments may name what the code deliberately avoids.
    const source = readFileSync(path.join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.doesNotMatch(source, /x-operator-token|operatorToken|localStorage|sessionStorage|admin-access|RequireGiwaAdmin|GIWA_ADMIN_ADDRESSES/, name)
    assert.doesNotMatch(source, /from "\.\/fixtures"/, name)
    assert.doesNotMatch(source, /method: "(POST|PUT|PATCH|DELETE)"/, name)
    assert.doesNotMatch(source, /parseFloat|Number\(value\)|toFixed/, name)
  }
})
