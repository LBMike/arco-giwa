// VERIFICATION SCREEN ONLY — MOCK DATA. Not the app: not referenced by index.html, src/main.tsx, the router or the
// Vite config, and never imported by product code.
//
// Mounts the REAL /admin/stocks page (StocksHostProvider > StocksPageEnvironment > stocksRoutes) in StrictMode with
// every response answered in this page: the host sign-in routes return an unsigned mock token (no key, no signature
// check), and the admin reads come from ../fixtures.ts. The fixture bar switches the operator account, the next
// session's lifetime, the server's access answer, the data set and the next order-detail and wallet-submission reads, and lists every
// request this page sent. There is no API, database, chain, wallet provider or wallet request behind this page.

import { StrictMode, useState, useSyncExternalStore, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom"

import "../../../../index.css"
import "../../../theme.css"
import type { HostDependencies } from "../../stocks-host/session"
import { StocksHostProvider } from "../../stocks-host/StocksHostProvider"
import { stocksRoutes } from "../../stocks-market/routes"
import { StocksPageEnvironment } from "../../stocks-market/StocksPages"
import { FIXTURE_IDS, FIXTURE_PROFILE, FIXTURE_RECONCILIATIONS, fixtureRoute, type FixtureReply } from "../fixtures"
import type { ReconciliationStatus } from "../types"

type Account = "A" | "B"
type Access = "ok" | "unauthorized" | "forbidden" | "disabled"
type Data = "default" | "long" | "empty"
type DiagnosticsMode = "normal" | "server" | "network" | "invalid" | "not_found" | "route_missing" | "hold"
type DetailMode = "normal" | "server" | "network" | "not_found"
type LoggedRequest = { key: number; n: number; method: string; path: string; result: string }
type Controls = {
  account: Account | null
  wrongNetwork: boolean
  lifetimeSeconds: 900 | 30
  access: Access
  data: Data
  reconciliation: ReconciliationStatus
  diagnostics: DiagnosticsMode
  detail: DetailMode
  held: number
  log: readonly LoggedRequest[]
  nonGet: number
}

const ORIGIN = window.location.origin
const ADDRESSES: Readonly<Record<Account, string>> = Object.freeze({
  A: "0x1111111111111111111111111111111111111111",
  B: "0x2222222222222222222222222222222222222222",
})
/** MOCK: nothing verifies this value. There is no key. */
const MOCK_SIGNATURE = `0x${"ab".repeat(65)}`
const RECONCILIATIONS = Object.keys(FIXTURE_RECONCILIATIONS) as ReconciliationStatus[]
const DIAGNOSTICS_MODES: readonly { id: DiagnosticsMode; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "server", label: "500" },
  { id: "network", label: "Network error" },
  { id: "invalid", label: "Invalid body" },
  { id: "not_found", label: "404 order" },
  { id: "route_missing", label: "404 route" },
  { id: "hold", label: "Hold" },
]
const DETAIL_MODES: readonly { id: DetailMode; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "server", label: "500" },
  { id: "network", label: "Network error" },
  { id: "not_found", label: "404 order" },
]

/** "Long state names": valid reviewed states whose labels are the widest in the state tables. */
const LONG_STATE_BY_ID: Readonly<Record<string, string>> = {
  [FIXTURE_IDS.sellLiquidity]: "ESCROW_REVIEW_REQUIRED",
  [FIXTURE_IDS.buyLarge]: "FUNDING_REVIEW_REQUIRED",
  [FIXTURE_IDS.sellSettlement]: "SELL_BROKER_UNKNOWN",
  [FIXTURE_IDS.buyUnknown]: "FUNDED_QUOTE_EXPIRED",
}
const LONG_STATE_BY_STATE: Readonly<Record<string, string>> = {
  "SELL:LIQUIDITY_PENDING": "ESCROW_REVIEW_REQUIRED",
  "BUY:AWAITING_FUNDING": "FUNDING_REVIEW_REQUIRED",
  "SELL:SETTLEMENT_PENDING": "SELL_BROKER_UNKNOWN",
  "BUY:BROKER_UNKNOWN": "FUNDED_QUOTE_EXPIRED",
}

// ── page-local mock state ───────────────────────────────────────────────────────────────────────────

let controls: Controls = {
  account: "A",
  wrongNetwork: false,
  lifetimeSeconds: 900,
  access: "ok",
  data: "default",
  reconciliation: "MATCHED_AT_CUTOFF",
  diagnostics: "normal",
  detail: "normal",
  held: 0,
  log: [],
  nonGet: 0,
}
const subscribers = new Set<() => void>()
let requestCount = 0
let logKey = 0
const heldReleases = new Set<() => void>()

function update(change: Partial<Controls>) {
  controls = { ...controls, ...change }
  subscribers.forEach((listener) => listener())
}
function useControls(): Controls {
  return useSyncExternalStore(
    (listener) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    () => controls,
  )
}
/** One log line per request; a held read that is later released adds a second line with the same request number. */
function record(method: string, path: string, result: string, request?: number): number {
  const n = request ?? ++requestCount
  logKey += 1
  update({ log: [{ key: logKey, n, method, path, result }, ...controls.log].slice(0, 12), nonGet: controls.nonGet + (method === "GET" || request !== undefined ? 0 : 1) })
  return n
}

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** MOCK sign-in routes for the real host session: an unsigned token with the claims the host checks. */
const HOST_DEPENDENCIES: HostDependencies = {
  async fetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "")
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
    const now = Date.now()
    if (path === "/api/v1/auth/nonce") {
      record("POST", path, "200 mock nonce")
      return json(200, { walletAddress: body.walletAddress, domain: body.domain, nonce: `mocknonce${now}`, expiresAt: new Date(now + 300_000).toISOString() })
    }
    if (path === "/api/v1/auth/verify") {
      const wallet = controls.account ? ADDRESSES[controls.account] : ""
      const iat = Math.floor(now / 1000)
      const token = `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url({ sub: wallet, chainId: 91342, domain: window.location.host, iat, exp: iat + controls.lifetimeSeconds })}.mock`
      record("POST", path, `200 mock token (${controls.lifetimeSeconds} s)`)
      return json(200, { walletAddress: wallet, chainId: 91342, token, expiresIn: controls.lifetimeSeconds })
    }
    record(init?.method ?? "GET", path, "404")
    return json(404, { error: "Not Found" })
  },
  async signMessage() {
    return MOCK_SIGNATURE
  },
  now: () => Date.now(),
}

function patchLong(body: unknown): unknown {
  if (controls.data !== "long" || body === null || typeof body !== "object") return body
  const copy = JSON.parse(JSON.stringify(body)) as { data?: unknown }
  const data = copy.data
  if (Array.isArray(data)) {
    for (const row of data as Record<string, unknown>[]) {
      const byId = typeof row.id === "string" ? LONG_STATE_BY_ID[row.id] : undefined
      const byState = LONG_STATE_BY_STATE[`${String(row.side)}:${String(row.state)}`]
      if (byId) row.state = byId
      else if (row.id === undefined && byState) row.state = byState
    }
  } else if (data && typeof data === "object" && "order" in data) {
    const order = (data as { order: Record<string, unknown> }).order
    const long = typeof order.id === "string" ? LONG_STATE_BY_ID[order.id] : undefined
    if (long) order.state = long
  }
  return copy
}

function diagnosticsOverride(path: string): FixtureReply | "network" | "hold" | null {
  switch (controls.diagnostics) {
    case "server":
      return { status: 500, body: { error: "DIAGNOSTICS_UNAVAILABLE", ...FIXTURE_PROFILE } }
    case "network":
      return "network"
    case "invalid":
      return { status: 200, raw: "{\"data\":{\"unexpected\":true}}" }
    case "not_found":
      return { status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } }
    case "route_missing":
      return { status: 404, body: { message: `Route GET:${path} not found`, error: "Not Found", statusCode: 404 } }
    case "hold":
      return "hold"
    default:
      return null
  }
}

function detailOverride(): FixtureReply | "network" | null {
  if (controls.detail === "server") return { status: 500, body: { error: "INTERNAL", ...FIXTURE_PROFILE } }
  if (controls.detail === "not_found") return { status: 404, body: { error: "ORDER_NOT_FOUND", ...FIXTURE_PROFILE } }
  return controls.detail === "network" ? "network" : null
}

/** MOCK admin transport: fixture replies, with the bar's overrides applied at request time. */
async function adminFetch(url: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? "GET"
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "")
  const signal = init.signal ?? null
  const aborted = () => new DOMException("The operation was aborted.", "AbortError")
  if (signal?.aborted) throw aborted()
  const diagnostics = /^\/api\/v1\/admin\/stocks\/wallet-submissions\//.test(path)
  const detail = /^\/api\/v1\/admin\/stocks\/orders\/[^/]+$/.test(path)
  const override = controls.access !== "ok" ? null : diagnostics ? diagnosticsOverride(path) : detail ? detailOverride() : null
  if (override === "network") {
    record(method, path, "network error (mock)")
    throw new TypeError("Failed to fetch")
  }
  let heldRequest: number | undefined
  if (override === "hold") {
    heldRequest = record(method, path, "held — press Release")
    update({ held: controls.held + 1 })
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        heldReleases.delete(release)
        update({ held: Math.max(0, controls.held - 1) })
        reject(aborted())
      }
      heldReleases.add(release)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }
  const reply =
    override && override !== "hold"
      ? override
      : fixtureRoute({ access: controls.access, orders: controls.data === "empty" ? "empty" : "default", reconciliation: controls.reconciliation })(path)
  if (signal?.aborted) throw aborted()
  const text = reply.raw ?? JSON.stringify(patchLong(reply.body ?? null))
  record(method, path, `${reply.status}${override === "hold" ? " (held read released)" : override ? " (override)" : ""}`, heldRequest)
  return new Response(text, { status: reply.status, headers: { "content-type": "application/json" } })
}

function releaseHeld() {
  const pending = [...heldReleases]
  heldReleases.clear()
  update({ held: 0 })
  pending.forEach((release) => release())
}

const PAGE_ENVIRONMENT = { apiBase: ORIGIN, fetch: adminFetch, activeWalletSource: () => null }
const router = createMemoryRouter(stocksRoutes(<Outlet />), { initialEntries: ["/admin/stocks"] })

// ── fixture bar ─────────────────────────────────────────────────────────────────────────────────────

const BUTTON =
  "inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-xs font-medium text-[var(--color-arco-ink)] aria-pressed:border-[var(--color-arco-ink)] aria-pressed:bg-[var(--color-arco-chip)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const SELECT =
  "min-h-9 min-w-0 max-w-full rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 text-xs text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={label}>
      <p className="text-xs font-medium text-[var(--color-arco-text-soft)]">{label}</p>
      <div className="flex min-w-0 flex-wrap gap-2">{children}</div>
    </div>
  )
}

function Toggle({ pressed, onClick, children, disabled }: { pressed?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={BUTTON} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

function FixtureBar({ onAccount }: { onAccount: (account: Account | null) => void }) {
  const state = useControls()
  return (
    <section
      aria-label="Mock admin fixture controls"
      className="w-full min-w-0 rounded-[var(--radius-strategy)] border-2 border-dashed border-[var(--color-arco-ink-40)] bg-[var(--color-arco-surface-muted)] p-4"
      data-testid="verification-fixture-bar"
    >
      <p className="text-sm font-semibold text-[var(--color-arco-ink)]">Mock data — not the app. No API, database, chain or wallet; responses come from stocks-admin/fixtures.ts</p>
      <p className="mt-1 break-words text-xs text-[var(--color-arco-text-soft)]">
        Host view: {state.account ? `operator ${state.account} ${ADDRESSES[state.account]}` : "disconnected"} · chain {state.wrongNetwork ? 1 : 91342} · sign-in uses an unsigned mock
        token; this page proves nothing about SIWE or server permissions.
      </p>
      <div className="mt-3 grid w-full gap-4 md:grid-cols-2">
        <Group label="Operator wallet">
          <Toggle pressed={state.account === "A"} onClick={() => onAccount("A")}>Operator A</Toggle>
          <Toggle pressed={state.account === "B"} onClick={() => onAccount("B")}>Operator B</Toggle>
          <Toggle pressed={state.account === null} onClick={() => onAccount(null)}>Disconnect</Toggle>
          <Toggle pressed={state.wrongNetwork} onClick={() => update({ wrongNetwork: !state.wrongNetwork })}>Wrong network (chain 1)</Toggle>
        </Group>
        <Group label="Next sign-in lifetime">
          <Toggle pressed={state.lifetimeSeconds === 900} onClick={() => update({ lifetimeSeconds: 900 })}>900 s</Toggle>
          <Toggle pressed={state.lifetimeSeconds === 30} onClick={() => update({ lifetimeSeconds: 30 })}>30 s (expiry demo)</Toggle>
        </Group>
        <Group label="Server access answer (all admin reads)">
          <Toggle pressed={state.access === "ok"} onClick={() => update({ access: "ok" })}>200 OK</Toggle>
          <Toggle pressed={state.access === "unauthorized"} onClick={() => update({ access: "unauthorized" })}>401</Toggle>
          <Toggle pressed={state.access === "forbidden"} onClick={() => update({ access: "forbidden" })}>403</Toggle>
          <Toggle pressed={state.access === "disabled"} onClick={() => update({ access: "disabled" })}>404 (routes off)</Toggle>
        </Group>
        <Group label="Data">
          <Toggle pressed={state.data === "default"} onClick={() => update({ data: "default" })}>Fixture orders</Toggle>
          <Toggle pressed={state.data === "long"} onClick={() => update({ data: "long" })}>Long state names</Toggle>
          <Toggle pressed={state.data === "empty"} onClick={() => update({ data: "empty" })}>Empty</Toggle>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-[var(--color-arco-text-soft)]">
            Reconciliation
            <select className={SELECT} value={state.reconciliation} onChange={(event) => update({ reconciliation: event.target.value as ReconciliationStatus })}>
              {RECONCILIATIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </Group>
        <Group label="Next wallet-submission reads">
          {DIAGNOSTICS_MODES.map((mode) => (
            <Toggle key={mode.id} pressed={state.diagnostics === mode.id} onClick={() => update({ diagnostics: mode.id })}>
              {mode.label}
            </Toggle>
          ))}
          <Toggle disabled={state.held === 0} onClick={releaseHeld}>Release held ({state.held})</Toggle>
        </Group>
        <Group label="Next order-detail reads">
          {DETAIL_MODES.map((mode) => (
            <Toggle key={mode.id} pressed={state.detail === mode.id} onClick={() => update({ detail: mode.id })}>
              {mode.label}
            </Toggle>
          ))}
        </Group>
        <Group label="Requests from this page">
          <p className="text-xs text-[var(--color-arco-ink)]" data-testid="verification-request-counts">
            {requestCount} total · {state.nonGet} not GET (mock sign-in POSTs only) · 0 wallet calls (no wallet provider)
          </p>
        </Group>
      </div>
      <ol className="mt-3 flex max-h-40 min-w-0 flex-col gap-1 overflow-auto rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-3 font-mono text-[11px] text-[var(--color-arco-ink)]" aria-label="Latest requests" data-testid="verification-request-log">
        {state.log.length === 0 ? <li>No requests yet.</li> : null}
        {state.log.map((entry) => (
          <li key={entry.key} className="break-all">
            #{entry.n} {entry.method} {entry.path} → {entry.result}
          </li>
        ))}
      </ol>
    </section>
  )
}

// ── page ────────────────────────────────────────────────────────────────────────────────────────────

function VerificationPage() {
  const state = useControls()
  const [epoch, setEpoch] = useState(0)
  const walletAddress = state.account ? ADDRESSES[state.account] : null
  const context = {
    walletAddress,
    chainId: walletAddress ? (state.wrongNetwork ? 1 : 91342) : null,
    frontendOrigin: ORIGIN,
    apiBase: ORIGIN,
    walletEpoch: `mock:${epoch}:${state.wrongNetwork ? "chain1" : "giwa"}`,
  }
  const onAccount = (account: Account | null) => {
    update({ account })
    setEpoch((value) => value + 1)
  }
  return (
    // The app shell (GiwaPreprodApp) scopes the theme tokens with .arco-demo and pads the page 32px; this page does the same.
    <main className="arco-demo mx-auto flex min-h-screen w-full max-w-[var(--container-page)] min-w-0 flex-col gap-6 bg-[var(--color-arco-page)] px-8 py-8 text-[var(--color-arco-ink)]">
      <FixtureBar onAccount={onAccount} />
      <StocksHostProvider context={context} dependencies={HOST_DEPENDENCIES}>
        <StocksPageEnvironment.Provider value={PAGE_ENVIRONMENT}>
          <RouterProvider router={router} />
        </StocksPageEnvironment.Provider>
      </StocksHostProvider>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VerificationPage />
  </StrictMode>,
)
