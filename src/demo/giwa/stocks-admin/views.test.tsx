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
  FIXTURE_OBSERVED_AT,
  FIXTURE_SELL_DETAIL,
  fixtureAttempt,
  fixtureDiagnostics,
  fixtureEnvelope,
  fixtureHash,
} from "./fixtures"
import { GiwaStocksAdminFeature, SECTIONS, StocksAdminView, latestMeta, nextSectionIndex } from "./GiwaStocksAdminFeature"
import { filterOrders, DEFAULT_FILTERS } from "./OrdersPanel"
import { auditRange } from "./AuditPanel"
import { parseAudit, parseEnvelope, parseOrderDetail, parseOrders, parseOverview, parseReconciliation, parseSubmissionDiagnostics } from "./parse"
import type {
  AccessState,
  DiagnosticsState,
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
    diagnostics: { ...IDLE, orderId: null, side: null },
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
      onRefreshDiagnostics={noop}
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
  const buyDetail = { ...loaded(parseOrderDetail(FIXTURE_BUY_DETAIL)), orderId: FIXTURE_IDS.buyFinality }
  const htmls = [
    render({ ...full(), detail }, "overview"),
    render({ ...full(), detail }, "orders"),
    // 003E: every diagnostics status, a hashless UNKNOWN and a failed refresh add only the one Refresh button.
    render({ ...full(), detail, diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement, { approval: fixtureAttempt("APPROVAL", "REQUEST_MAY_START"), transfer: fixtureAttempt("TRANSFER", "REVERTED") }) }, "orders"),
    render({ ...full(), detail: buyDetail, diagnostics: diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "UNKNOWN"), transfer: null }) }, "orders"),
    render({ ...full(), detail: buyDetail, diagnostics: { ...diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "SUBMITTED") }), phase: "error", error: { kind: "server", status: 503, code: "SUBMISSION_DIAGNOSTICS_UNAVAILABLE" } } }, "orders"),
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

// ---------------------------------------------------------------- 003E wallet submission diagnostics card

function diag(side: "BUY" | "SELL", orderId: string, options: Parameters<typeof fixtureDiagnostics>[1] = {}, ageMs = 5_000): DiagnosticsState {
  const data = parseSubmissionDiagnostics(fixtureDiagnostics(orderId, options), { side, orderId, observedAt: FIXTURE_OBSERVED_AT })
  return { ...loaded(data, ageMs), orderId, side }
}
const BUY_DETAIL = () => ({ ...loaded(parseOrderDetail(FIXTURE_BUY_DETAIL)), orderId: FIXTURE_IDS.buyFinality })
const SELL_DETAIL = () => ({ ...loaded(parseOrderDetail(FIXTURE_SELL_DETAIL)), orderId: FIXTURE_IDS.sellSettlement })
function card(html: string): string {
  const start = html.indexOf('data-testid="stocks-admin-diagnostics"')
  assert.ok(start > 0, "the diagnostics card is rendered")
  return text(html.slice(start))
}

test("BUY diagnostics: approval and deposit wording, a hashless UNKNOWN reads 'No recorded hash', CONFIRMED is not issuance", () => {
  const unknown = render(snapshot({ detail: BUY_DETAIL(), diagnostics: diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "UNKNOWN"), transfer: null }) }), "orders")
  const t = card(unknown)
  assert.match(text(unknown), /Wallet submissions \(read only\) The server's wallet submission journal for this order at one database snapshot\. This view cannot claim, record, reconcile, sign, send again or change any state\. Refresh/)
  assert.match(t, new RegExp(`Server snapshot ${FIXTURE_OBSERVED_AT}`), "observedAt exactly as the server sent it")
  assert.match(unknown, new RegExp(`<time dateTime="${FIXTURE_OBSERVED_AT}"`))
  assert.match(t, /Approval APPROVAL UNKNOWN Wallet result unknown/)
  assert.match(t, /Transaction hash No recorded hash/)
  assert.match(t, /No hash was recorded for this request\. It is not entered, guessed or searched here\. Do not send the approval again\./)
  assert.match(t, /Receipt check Not verified by the server/)
  assert.match(t, /Claim id claim-approval-1 Transaction digest/, "the claim id in full, for matching server records")
  assert.match(t, /Deposit TRANSFER No wallet request is recorded for the deposit\./)
  assert.ok(!t.includes("Escrow"), "BUY has no escrow stage")
  assert.match(unknown, /data-stage="APPROVAL" data-status="UNKNOWN"/)
  assert.match(unknown, /data-stage="TRANSFER" data-status="NONE"/)

  const confirmed = card(render(snapshot({ detail: BUY_DETAIL(), diagnostics: diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "CONFIRMED") }) }), "orders"))
  assert.match(confirmed, /Deposit TRANSFER CONFIRMED Receipt verified: confirmed/)
  assert.match(confirmed, /The server verified this transaction's receipt\. That is not issuance of the shares; the order state shows that\./)
  assert.ok(confirmed.includes(fixtureHash("d7")), "the recorded hash, in full")
  assert.match(confirmed, /Receipt block 19834100/)
  assert.ok(confirmed.includes(fixtureHash("e7")), "receipt block hash")
  assert.match(confirmed, /Receipt verification recorded 2026-09-17 02:13:50/)
  assert.match(confirmed, /Order state at snapshot MINT_FINALITY_PENDING/)
  assert.match(confirmed, /Quote deadline .* Passed as of the snapshot/)
})

test("SELL diagnostics: escrow wording; REVERTED and REQUEST_MAY_START are historical; CONFIRMED is not the burn or payout", () => {
  const html = render(snapshot({ detail: SELL_DETAIL(), diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "REVERTED") }) }), "orders")
  const t = card(html)
  assert.match(t, /Escrow TRANSFER REVERTED Receipt verified: reverted/)
  assert.ok(!t.includes("Deposit"), "SELL has no deposit stage")
  assert.match(t, /That is not the burn or the cash payout; the order state shows that\./)
  assert.match(html, /data-stage="TRANSFER" data-status="REVERTED"/)

  const reserved = card(render(snapshot({ detail: SELL_DETAIL(), diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement, { approval: fixtureAttempt("APPROVAL", "REQUEST_MAY_START"), transfer: null }) }), "orders"))
  assert.match(reserved, /Approval APPROVAL REQUEST_MAY_START Request reserved, no wallet answer recorded/)
  assert.match(reserved, /No recorded hash/)
  assert.match(reserved, /A reserved request is a historical record\. It is not permission to send\./)
  assert.match(reserved, /Escrow TRANSFER No wallet request is recorded for the escrow\./)

  const submitted = card(render(snapshot({ detail: SELL_DETAIL(), diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "SUBMITTED") }) }), "orders"))
  assert.match(submitted, /Escrow TRANSFER SUBMITTED Hash recorded, receipt not verified/)
  assert.match(submitted, /Escrow TRANSFER [^]*Receipt check Not verified by the server/)

  const known = card(render(snapshot({ detail: SELL_DETAIL(), diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "UNKNOWN", { txHash: fixtureHash("c9") }) }) }), "orders"))
  assert.match(known, /The result was reported unknown with this recorded hash\. Do not send the escrow again\./)
  assert.ok(known.includes(fixtureHash("c9")))
})

test("diagnostics: NOT_ENROLLED and both stages absent are records, never permission; the footer says nothing can execute", () => {
  const t = card(render(snapshot({ detail: SELL_DETAIL(), diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement, { enrollment: "NOT_ENROLLED" }) }), "orders"))
  assert.match(t, /Not enrolled: this order has no wallet submission journal\. Nothing was recorded, and this is not permission to send\./)
  assert.match(t, /No wallet request is recorded for the approval\./)
  assert.match(t, /No wallet request is recorded for the escrow\./)
  assert.match(t, /Historical record only/)
  assert.match(t, /Nothing here can be executed, recorded again or resent/)
  for (const word of ["Send", "Resend", "Retry", "Claim", "Reconcile", "Record hash", "Sign"]) assert.ok(!new RegExp(`<button[^>]*>[^<]*${word}`).test(t), word)
})

test("diagnostics: loading, each error, and a failed refresh that keeps the earlier snapshot labelled as not current", () => {
  const detail = BUY_DETAIL()
  const before = card(render(snapshot({ detail, diagnostics: { ...IDLE, orderId: FIXTURE_IDS.buyFinality, side: null } }), "orders"))
  assert.match(before, /Loading wallet submissions…/)
  const loading = card(render(snapshot({ detail, diagnostics: { ...IDLE, phase: "loading", orderId: FIXTURE_IDS.buyFinality, side: "BUY" } }), "orders"))
  assert.match(loading, /Loading…/)
  assert.ok(!loading.includes("Approval APPROVAL"))

  const copies: [StocksAdminError, RegExp][] = [
    [{ kind: "not_found", status: 404, code: "ORDER_NOT_FOUND" }, /Order not found in the current deployment \(404\)/],
    [{ kind: "disabled", status: 404, code: null }, /Wallet submission diagnostics are not available on this server \(404\)/],
    [{ kind: "server", status: 503, code: "SUBMISSION_DIAGNOSTICS_UNAVAILABLE" }, /Diagnostics unavailable \(503\)/],
    [{ kind: "network", status: null, code: null }, /Could not reach the API/],
    [{ kind: "invalid", status: 200, code: null }, /Response did not match the diagnostics contract/],
    [{ kind: "request", status: 400, code: "INVALID_SUBMISSION_DIAGNOSTICS_INPUT" }, /Request rejected \(400\)/],
  ]
  for (const [error, copy] of copies) {
    const t = card(render(snapshot({ detail, diagnostics: { phase: "error", value: null, error, orderId: FIXTURE_IDS.buyFinality, side: "BUY" } }), "orders"))
    assert.match(t, copy)
    assert.ok(!t.includes("Approval APPROVAL") && !t.includes("Server snapshot"), `${error.kind}: nothing from before is shown`)
    assert.ok(!t.includes("SUBMISSION_DIAGNOSTICS_UNAVAILABLE") && !t.includes("INVALID_SUBMISSION"), "no internal codes")
  }

  const earlier = diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "SUBMITTED") })
  const failed = card(render(snapshot({ detail, diagnostics: { ...earlier, phase: "error", error: { kind: "network", status: null, code: null } } }), "orders"))
  assert.match(failed, new RegExp(`The record below is from the earlier snapshot ${FIXTURE_OBSERVED_AT}, not a current one\\.`))
  assert.ok(!failed.includes("Loaded more than 60 seconds ago"))

  const stale = card(render(snapshot({ detail, diagnostics: diag("BUY", FIXTURE_IDS.buyFinality, {}, 61_000) }), "orders"))
  assert.match(stale, /Loaded more than 60 seconds ago/)
})

test("diagnostics of another order or side are never rendered, even for one render", () => {
  const detail = BUY_DETAIL()
  const other = diag("BUY", FIXTURE_IDS.buyUnknown, { approval: fixtureAttempt("APPROVAL", "UNKNOWN"), transfer: null })
  const t = text(render(snapshot({ detail, diagnostics: other }), "orders"))
  assert.ok(!t.includes("Wallet submissions (read only)"), "a record keyed to another order has no card")
  // A value that does not belong to the keyed order and side is dropped inside the card.
  const sell = diag("SELL", FIXTURE_IDS.sellSettlement)
  const inside = card(render(snapshot({ detail, diagnostics: { ...sell, orderId: FIXTURE_IDS.buyFinality, side: "BUY" } }), "orders"))
  assert.ok(!inside.includes("Escrow") && !inside.includes("Server snapshot"))
  const sideSwap = card(render(snapshot({ detail: SELL_DETAIL(), diagnostics: { ...sell, side: "BUY" } }), "orders"))
  assert.ok(!sideSwap.includes("Escrow") && !sideSwap.includes("Server snapshot"))
})

// 003E-1 (DIAG-UI-003E-P3-01): a 404 refresh after a successful read keeps the earlier record, so the notice must not say
// that nothing is shown; a first 404 (nothing kept) still says so.
const EARLIER_LABEL = `The record below is from the earlier snapshot ${FIXTURE_OBSERVED_AT}, not a current one.`
const NOT_FOUND: StocksAdminError = { kind: "not_found", status: 404, code: "ORDER_NOT_FOUND" }
const ROUTE_ABSENT: StocksAdminError = { kind: "disabled", status: 404, code: null }

test("diagnostics 404 (order or route): with no earlier record the card says nothing is shown", () => {
  const detail = BUY_DETAIL()
  const cases: [StocksAdminError, string, string][] = [
    [NOT_FOUND, "Order not found in the current deployment (404)", "The server has no such order in the deployment it serves now. Nothing is shown."],
    [ROUTE_ABSENT, "Wallet submission diagnostics are not available on this server (404)", "The diagnostics route is not registered. Nothing is shown."],
  ]
  for (const [error, title, body] of cases) {
    const t = card(render(snapshot({ detail, diagnostics: { phase: "error", value: null, error, orderId: FIXTURE_IDS.buyFinality, side: "BUY" } }), "orders"))
    assert.ok(t.includes(`${title} ${body}`), `${error.kind}: ${t}`)
    assert.ok(!t.includes("earlier snapshot") && !t.includes("Server snapshot") && !t.includes("Approval APPROVAL"), `${error.kind}: nothing kept, nothing shown`)
  }
})

test("diagnostics 404 (order or route) after a successful read: the kept record is visible and never called 'nothing is shown'", () => {
  const detail = BUY_DETAIL()
  const earlier = diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "CONFIRMED", { txHash: fixtureHash("3b"), claimId: "claim-kept-a" }), transfer: fixtureAttempt("TRANSFER", "SUBMITTED", { txHash: fixtureHash("3c"), claimId: "claim-kept-t" }) })
  const cases: [StocksAdminError, string, string][] = [
    [NOT_FOUND, "Order not found in the current deployment (404)", "The server has no such order in the deployment it serves now. No new diagnostics were received."],
    [ROUTE_ABSENT, "Wallet submission diagnostics are not available on this server (404)", "The diagnostics route is not registered. No new diagnostics were received."],
  ]
  for (const [error, title, body] of cases) {
    const html = render(snapshot({ detail, diagnostics: { ...earlier, phase: "error", error } }), "orders")
    const t = card(html)
    assert.ok(!/nothing is shown/i.test(t), `${error.kind}: contradicts the record kept below: ${t}`)
    assert.ok(t.includes(`${title} ${body} ${EARLIER_LABEL}`), `${error.kind}: ${t}`)
    // The kept record itself: the real earlier hashes, claims and snapshot time, still labelled as earlier.
    for (const kept of [fixtureHash("3b"), fixtureHash("3c"), "claim-kept-a", "claim-kept-t", `Server snapshot ${FIXTURE_OBSERVED_AT}`]) assert.ok(t.includes(kept), `${error.kind}: ${kept}`)
    assert.match(html, /data-stage="APPROVAL" data-status="CONFIRMED"/)
    assert.match(html, /data-stage="TRANSFER" data-status="SUBMITTED"/)
    assert.match(html, /role="alert"/)
  }
})

test("diagnostics: every error kind keeps its own copy, and none says nothing is shown next to a kept record", () => {
  const detail = BUY_DETAIL()
  const earlier = diag("BUY", FIXTURE_IDS.buyFinality)
  const kinds: [StocksAdminError, string][] = [
    [NOT_FOUND, "Order not found in the current deployment (404)"],
    [ROUTE_ABSENT, "Wallet submission diagnostics are not available on this server (404)"],
    [{ kind: "server", status: 503, code: "SUBMISSION_DIAGNOSTICS_UNAVAILABLE" }, "Diagnostics unavailable (503) The server could not read a consistent snapshot. Nothing new is shown."],
    [{ kind: "network", status: null, code: null }, "Could not reach the API The request failed before a response arrived. Nothing new is shown."],
    [{ kind: "invalid", status: 200, code: null }, "Response did not match the diagnostics contract The response was rejected and none of it is shown (wrong profile, order, side, deployment, wallet, fields or permission flags)."],
    [{ kind: "request", status: 400, code: "INVALID_SUBMISSION_DIAGNOSTICS_INPUT" }, "Request rejected (400) The server rejected the request. Nothing new is shown."],
    [{ kind: "aborted", status: null, code: null }, "Request cancelled The request was cancelled before it finished."],
    [{ kind: "configuration", status: null, code: null }, "Stocks admin API is not configured No request was sent."],
  ]
  for (const [error, copy] of kinds) {
    const t = card(render(snapshot({ detail, diagnostics: { ...earlier, phase: "error", error } }), "orders"))
    assert.ok(t.includes(copy), `${error.kind}: ${t}`)
    assert.ok(t.includes(EARLIER_LABEL), `${error.kind}: the kept record is labelled as earlier`)
    assert.ok(!/nothing is shown/i.test(t), `${error.kind}: ${t}`)
    assert.ok(t.includes(fixtureHash("d7")), `${error.kind}: the kept hash stays visible`)
  }
})

test("diagnostics 404: whether a record is 'kept' follows the record the card actually shows (this order and side only)", () => {
  // A value of another order or side is never rendered, so the notice must not claim a kept record either.
  const detail = BUY_DETAIL()
  const sell = diag("SELL", FIXTURE_IDS.sellSettlement)
  for (const error of [NOT_FOUND, ROUTE_ABSENT]) {
    for (const foreign of [{ ...sell, orderId: FIXTURE_IDS.buyFinality, side: "BUY" as const }, { ...diag("BUY", FIXTURE_IDS.buyFinality), side: "SELL" as const }]) {
      const html = render(snapshot({ detail, diagnostics: { ...foreign, phase: "error", error } }), "orders")
      const t = card(html)
      assert.ok(t.includes("Nothing is shown."), `${error.kind}: ${t}`)
      assert.ok(!t.includes("No new diagnostics were received") && !t.includes("earlier snapshot") && !t.includes("Server snapshot"), `${error.kind}: ${t}`)
      assert.doesNotMatch(html, /data-testid="stocks-admin-diagnostics-stage"/)
    }
  }
})

// ---------------------------------------------------------------- UI review 2026-09-19 (G4: layout, live region, headings)

/** Heading outline in document order: "<level> <visible text>". */
function outline(html: string): string[] {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map(([, level, inner]) => `${level} ${text(inner).trim()}`)
}

function assertGapless(headings: readonly string[], label: string) {
  const levels = headings.map((heading) => Number(heading[0]))
  assert.equal(levels.filter((level) => level === 1).length, 1, `${label}: exactly one h1 in ${headings.join(" | ")}`)
  assert.equal(levels[0], 1, `${label}: the h1 comes first`)
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `${label}: "${headings[i - 1]}" → "${headings[i]}" skips a level`)
}

test("A1: a Pill's text may shrink inside the pill, so long state names wrap instead of running over the next column", () => {
  const detail = BUY_DETAIL()
  const htmls = [render(full(), "overview"), render({ ...full(), detail, diagnostics: diag("BUY", FIXTURE_IDS.buyFinality) }, "orders")]
  let pills = 0
  for (const html of htmls) {
    for (const [, className, label] of html.matchAll(/radius-pill\)\] border px-2[^"]*"><svg[\s\S]*?<\/svg><span class="([^"]*)">((?:[^<]|<wbr\/>)*)<\/span>/g)) {
      pills += 1
      assert.deepEqual(className.split(" ").sort(), ["break-words", "min-w-0"], `pill ${label}`)
    }
  }
  assert.ok(pills > 10, `every rendered pill was checked (${pills})`)
  // A state name may break after each underscore; its text is unchanged.
  assert.match(htmls[0], /<span class="min-w-0 break-words">MINT_<wbr\/>FINALITY_<wbr\/>PENDING<\/span>/)
  assert.match(text(htmls[0]), /MINT_FINALITY_PENDING/)
})

test("A2: a busy Refresh stays focusable: aria-disabled and aria-busy, never the disabled attribute", () => {
  const detail = { ...BUY_DETAIL(), phase: "loading" as const }
  const html = render({ ...full(), detail, diagnostics: { ...diag("BUY", FIXTURE_IDS.buyFinality), phase: "loading" } }, "orders")
  for (const what of ["orders", "order detail", "wallet submissions"]) {
    const button = new RegExp(`<button type="button" aria-label="Refresh ${what}"([^>]*)>([\\s\\S]*?)</button>`).exec(html)
    assert.ok(button, what)
    const busy = what !== "orders"
    assert.doesNotMatch(button[1], /\bdisabled=""/, `${what}: never natively disabled`)
    assert.equal(/aria-disabled="true"/.test(button[1]), busy, `${what}: aria-disabled only while busy`)
    assert.equal(/aria-busy="true"/.test(button[1]), busy, `${what}: aria-busy only while busy`)
    assert.equal(text(button[2]).trim(), busy ? "Refreshing…" : "Refresh", what)
    assert.match(button[1], /aria-disabled:cursor-not-allowed/)
  }
})

test("A4: the diagnostics snapshot line is a status region, so a successful refresh is announced; the clock-driven loaded-at line is not", () => {
  const html = render(snapshot({ detail: BUY_DETAIL(), diagnostics: diag("BUY", FIXTURE_IDS.buyFinality) }), "orders")
  const inCard = html.slice(html.indexOf('data-testid="stocks-admin-diagnostics"'))
  const status = /<p role="status"[^>]*>([\s\S]*?)<\/p>/.exec(inCard)
  assert.ok(status, "the snapshot line is a status region")
  assert.match(text(status[1]).trim(), new RegExp(`^Server snapshot ${FIXTURE_OBSERVED_AT} · loaded 2026-09-17 03:00:25 UTC$`))
  const loading = render(snapshot({ detail: BUY_DETAIL(), diagnostics: { ...IDLE, phase: "loading", orderId: FIXTURE_IDS.buyFinality, side: "BUY" } }), "orders")
  assert.match(loading, /<p role="status"[^>]*>Loading…<\/p>/)
  // ResourceMeta's "Loaded … (Ns ago)" line changes every 15 s and must stay silent.
  assert.doesNotMatch(html, /role="status"[^>]*>Loaded /)
})

test("A5: one h1 and a gapless heading outline on every section, the selected order and the access states", () => {
  const selected = render({ ...full(), detail: BUY_DETAIL(), diagnostics: diag("BUY", FIXTURE_IDS.buyFinality, { approval: fixtureAttempt("APPROVAL", "CONFIRMED"), transfer: fixtureAttempt("TRANSFER", "SUBMITTED") }) }, "orders")
  assert.deepEqual(outline(render(full(), "overview")), ["1 Stocks operations", "2 BUY orders by state", "2 SELL orders by state", "2 Unfinished orders"])
  const buy = outline(selected)
  assert.deepEqual(buy.map((heading) => heading.replace(/^(2 Order detail).*$/, "$1")), [
    "1 Stocks operations",
    "2 Orders",
    "2 Order detail",
    "3 Funding (BUY)",
    "3 Mint holding",
    "3 Operations",
    "3 Audit trail",
    "3 Wallet submissions (read only)",
    "4 Approval APPROVAL",
    "4 Deposit TRANSFER",
  ])
  const sell = outline(render({ ...full(), detail: SELL_DETAIL(), diagnostics: diag("SELL", FIXTURE_IDS.sellSettlement) }, "orders"))
  assert.deepEqual(sell.slice(3), ["3 Escrow custody (SELL)", "3 Cash reservations (SELL)", "3 Operations", "3 Audit trail", "3 Wallet submissions (read only)", "4 Approval APPROVAL", "4 Escrow TRANSFER"])
  const matched = outline(render(full(), "reconciliation"))
  assert.ok(matched.some((heading) => /^3 Known wallet balances \(\d+\)$/.test(heading)), matched.join(" | "))
  const cases: [string, string[]][] = [
    ["overview", outline(render(full(), "overview"))],
    ["orders (no selection)", outline(render(full(), "orders"))],
    ["BUY detail", buy],
    ["SELL detail", sell],
    ["audit", outline(render(full(), "audit"))],
    ...(Object.keys(FIXTURE_RECONCILIATIONS) as ReconciliationStatus[]).map((status): [string, string[]] => [
      `reconciliation ${status}`,
      outline(render(snapshot({ reconciliation: loaded(parseReconciliation(FIXTURE_RECONCILIATIONS[status])) }), "reconciliation")),
    ]),
    ...(["signed_out", "unauthorized", "forbidden", "disabled"] as const).map((access): [string, string[]] => [`access ${access}`, outline(render(snapshot({}, access), "overview", noop))]),
  ]
  for (const [label, headings] of cases) assertGapless(headings, label)
  assert.deepEqual(outline(render(snapshot({}, "forbidden"), "overview")), ["1 Stocks operations", "2 No Stocks read permission (403)"])
})
