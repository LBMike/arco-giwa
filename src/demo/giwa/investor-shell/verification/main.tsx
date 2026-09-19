// VERIFICATION SCREEN ONLY — FIXTURE PREVIEW. Not the app: not referenced by index.html, src/main.tsx, the router or
// the Vite config, and never imported by product code.
//
// Mounts the REAL investor shell and pages (GiwaPreprodProviders > StocksPageEnvironment > the investor route tree of
// src/main.tsx, in a hash router) so the shell, Home, Funds, Savings, Portfolio and the Stocks table can be clicked
// through without a GIWA API or a chain. A window.fetch guard is installed before any product page module loads:
//   - same-origin requests pass through (Vite assets, /logos, and /api/v1/stocks/* to the in-process harness of serve.ts),
//   - the legacy GIWA API reads the pages need are answered from ./fixtures.ts,
//   - every other off-origin request (public RPC included) gets a 503 JSON error and is logged as BLOCKED.
// Market data comes from the synthetic stocks-market fixtures through StocksPageEnvironment.fetch.
// This page sends no wallet request itself; window.ethereum is whatever the browser provides.

import { StrictMode, Suspense, lazy, useState, useSyncExternalStore, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { createHashRouter, Navigate, RouterProvider } from "react-router-dom"

import "../../../../index.css"
import "../../../theme.css"
import { ARCO_API_BASE, GIWA_PUBLIC_RPC } from "../../config"
import { GIWA_PREPROD_ROUTE } from "../../routes"
import type { MarketFetch } from "../../stocks-market/contracts"
import { StocksPageEnvironment } from "../../stocks-market/environment"
import { fixtureMarketFetch, fixtureTop40MarketFetch } from "../../stocks-market/fixtures"
import { stocksRoutes } from "../../stocks-market/routes"
import { previewLegacyReply } from "./fixtures"

type AnsweredBy = "fixture" | "harness" | "BLOCKED"
type LogEntry = { n: number; method: string; target: string; answeredBy: AnsweredBy; status: number | null; note: string }
type LogState = { entries: readonly LogEntry[]; total: number; counts: Readonly<Record<AnsweredBy, number>> }
type MarketMode = "top40" | "pilot" | "unconfigured"

const ORIGIN = window.location.origin
const MAX_ENTRIES = 300
const MODE_KEY = "giwa-investor-shell-preview:market-mode"

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}
function baseOf(value: string): string | null {
  try {
    return new URL(value).href.replace(/\/+$/, "")
  } catch {
    return null
  }
}
/** The legacy GIWA API base the pages call (config.ts; http://localhost:8080 when no env is read). */
const LEGACY_BASE = baseOf(ARCO_API_BASE)
const RPC_ORIGIN = originOf(GIWA_PUBLIC_RPC)

// ── request log (page-local store) ──────────────────────────────────────────────────────────────────

const EMPTY_LOG: LogState = { entries: [], total: 0, counts: { fixture: 0, harness: 0, BLOCKED: 0 } }
let log = EMPTY_LOG
const listeners = new Set<() => void>()
let notifyQueued = false

function notify() {
  if (notifyQueued) return
  notifyQueued = true
  queueMicrotask(() => {
    notifyQueued = false
    listeners.forEach((listener) => listener())
  })
}
function record(method: string, target: string, answeredBy: AnsweredBy, status: number | null, note = "") {
  const n = log.total + 1
  log = { entries: [{ n, method, target, answeredBy, status, note }, ...log.entries].slice(0, MAX_ENTRIES), total: n, counts: { ...log.counts, [answeredBy]: log.counts[answeredBy] + 1 } }
  notify()
}
function clearLog() {
  log = EMPTY_LOG
  notify()
}
function useLog(): LogState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => log,
  )
}

// ── fetch guard (installed before any product page module loads) ────────────────────────────────────

const nativeFetch = window.fetch.bind(window)

function hrefOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
}
function display(url: URL): string {
  return url.origin === ORIGIN ? `${url.pathname}${url.search}` : `${url.host}${url.pathname}${url.search}`
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
/** Names the JSON-RPC method of a blocked RPC call, e.g. "JSON-RPC eth_call". */
function rpcNote(init?: RequestInit): string {
  if (typeof init?.body !== "string") return "GIWA RPC"
  try {
    const body = JSON.parse(init.body) as unknown
    const calls = (Array.isArray(body) ? body : [body]) as { method?: unknown }[]
    const methods = calls.map((call) => (typeof call?.method === "string" ? call.method : "?"))
    return `JSON-RPC ${methods.join(", ")}`
  } catch {
    return "GIWA RPC"
  }
}
function aborted(init?: RequestInit): boolean {
  return init?.signal?.aborted === true
}

function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(hrefOf(input), window.location.href)
  const method = methodOf(input, init)
  if (aborted(init)) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
  if (LEGACY_BASE && (url.href === LEGACY_BASE || url.href.startsWith(`${LEGACY_BASE}/`))) {
    const reply = previewLegacyReply(method, url.href.slice(LEGACY_BASE.length) || "/", Date.now())
    if (reply) {
      record(method, display(url), "fixture", reply.status)
      return Promise.resolve(json(reply.status, reply.body))
    }
  }
  if (url.origin === ORIGIN) {
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init)
    return nativeFetch(input, init).then(
      (response) => {
        record(method, display(url), "harness", response.status)
        return response
      },
      (error: unknown) => {
        record(method, display(url), "harness", null, error instanceof DOMException && error.name === "AbortError" ? "aborted" : "network error")
        throw error
      },
    )
  }
  record(method, display(url), "BLOCKED", 503, url.origin === RPC_ORIGIN ? rpcNote(init) : "")
  return Promise.resolve(json(503, { error: "PREVIEW_BLOCKED", message: "Off-origin request blocked by the investor shell preview." }))
}

window.fetch = guardedFetch

// ── Stocks market data (StocksPageEnvironment.fetch) ────────────────────────────────────────────────

const MARKET_MODES: readonly { id: MarketMode; label: string; create: () => MarketFetch }[] = [
  { id: "top40", label: "40-symbol fixture", create: () => fixtureTop40MarketFetch() },
  { id: "pilot", label: "NVDA pilot", create: () => fixtureMarketFetch("ready", ["NVDA"]) },
  { id: "unconfigured", label: "Unconfigured", create: () => fixtureMarketFetch("keyless") },
]

/** /api/v1/stocks/market/* goes to the chosen synthetic market; every other Stocks request goes through the guard. */
function stocksFetch(mode: MarketMode) {
  const market = (MARKET_MODES.find((entry) => entry.id === mode) ?? MARKET_MODES[0]!).create()
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(hrefOf(input), window.location.href)
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/api/v1/stocks/market/")) return guardedFetch(input, init)
    const method = methodOf(input, init)
    return market(url.href, init ?? {}).then((response) => {
      record(method, display(url), "fixture", response.status, `synthetic market · ${mode}`)
      return response
    })
  }
}

function readMode(): MarketMode {
  try {
    const stored = window.sessionStorage.getItem(MODE_KEY)
    return MARKET_MODES.some((entry) => entry.id === stored) ? (stored as MarketMode) : "top40"
  } catch {
    return "top40"
  }
}
function writeMode(mode: MarketMode) {
  try {
    window.sessionStorage.setItem(MODE_KEY, mode)
  } catch {
    // Storage unavailable: the choice lasts until reload.
  }
}

// ── the app: real providers, shell and pages (lazy, as in src/main.tsx) ─────────────────────────────

const GiwaPreprodApp = lazy(() => import("../../GiwaPreprodApp").then((mod) => ({ default: mod.GiwaPreprodApp })))
const GiwaPreprodProviders = lazy(() => import("../../providers").then((mod) => ({ default: mod.GiwaPreprodProviders })))
const GiwaHomePage = lazy(() => import("../../HomePage"))
const GiwaInvestorPage = lazy(() => import("../../Investor"))
const GiwaPortfolioPage = lazy(() => import("../../PortfolioPage"))
const GiwaProductDetailPage = lazy(() => import("../../ProductDetailPage"))
const GiwaSavingsPage = lazy(() => import("../../SavingsPage"))

function giwaRoute(element: ReactNode) {
  return <Suspense fallback={null}>{element}</Suspense>
}

// The investor tree of src/main.tsx (fixtures.test.tsx compares the two). Hash routing is preview-only: this page is
// one static file under Vite's MPA mode. Omitted: the /app/* legacy redirect and the allowlisted /admin console.
const router = createHashRouter([
  ...stocksRoutes(giwaRoute(<GiwaPreprodApp />)),
  {
    path: GIWA_PREPROD_ROUTE,
    element: giwaRoute(<GiwaPreprodApp />),
    children: [
      { index: true, element: giwaRoute(<GiwaHomePage />) },
      { path: "funds", element: giwaRoute(<GiwaInvestorPage />) },
      { path: "savings", element: giwaRoute(<GiwaSavingsPage />) },
      { path: "portfolio", element: giwaRoute(<GiwaPortfolioPage />) },
      { path: "product/:id", element: giwaRoute(<GiwaProductDetailPage />) },
    ],
  },
  { path: "*", element: <Navigate to={GIWA_PREPROD_ROUTE} replace /> },
])

/** Keyed by the market mode, so a mode switch re-mounts providers (new query cache) and pages. */
function PreviewApp({ mode }: { mode: MarketMode }) {
  const [environment] = useState(() => ({ apiBase: ORIGIN, fetch: stocksFetch(mode) }))
  return (
    <Suspense fallback={null}>
      <GiwaPreprodProviders>
        <StocksPageEnvironment.Provider value={environment}>
          <RouterProvider router={router} />
        </StocksPageEnvironment.Provider>
      </GiwaPreprodProviders>
    </Suspense>
  )
}

// ── preview bar ─────────────────────────────────────────────────────────────────────────────────────

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const BUTTON = `inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-xs font-medium text-[var(--color-arco-ink)] aria-pressed:border-[var(--color-arco-ink)] aria-pressed:bg-[var(--color-arco-chip)] ${FOCUS}`
const LINKS: readonly (readonly [string, string])[] = [
  ["#/", "Home"],
  ["#/funds", "Funds"],
  ["#/savings", "Savings"],
  ["#/stocks", "Stocks"],
  ["#/portfolio", "Portfolio"],
]

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={label}>
      <p className="text-xs font-medium text-[var(--color-arco-text-soft)]">{label}</p>
      <div className="flex min-w-0 flex-wrap gap-2">{children}</div>
    </div>
  )
}

function RequestLog() {
  const state = useLog()
  return (
    <details className="w-full min-w-0 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]" data-testid="investor-shell-request-log">
      <summary className={`cursor-pointer rounded-[var(--radius-card)] px-3 py-2 text-xs font-medium text-[var(--color-arco-ink)] ${FOCUS}`} data-testid="investor-shell-request-counts">
        Request log · {state.total} total · fixture {state.counts.fixture} · harness {state.counts.harness} · BLOCKED {state.counts.BLOCKED}
      </summary>
      <div className="border-t border-[var(--color-arco-border)] p-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-arco-text-soft)]">Newest first, last {MAX_ENTRIES} kept. Same-origin static assets are not listed.</p>
          <button type="button" className={BUTTON} onClick={clearLog}>
            Clear log
          </button>
        </div>
        <ol className="mt-2 flex max-h-64 min-w-0 flex-col gap-1 overflow-auto font-mono text-[11px] text-[var(--color-arco-ink)]" aria-label="Requests, newest first">
          {state.entries.length === 0 ? <li>No requests yet.</li> : null}
          {state.entries.map((entry) => (
            <li key={entry.n} className="break-all" data-answered-by={entry.answeredBy}>
              #{entry.n} {entry.method} {entry.target} →{" "}
              <span className={entry.answeredBy === "BLOCKED" ? "font-semibold text-[var(--color-arco-down)]" : ""}>{entry.answeredBy}</span>
              {entry.status === null ? "" : ` ${entry.status}`}
              {entry.note ? ` · ${entry.note}` : ""}
            </li>
          ))}
        </ol>
      </div>
    </details>
  )
}

function PreviewBar({ mode, onMode }: { mode: MarketMode; onMode: (mode: MarketMode) => void }) {
  return (
    <section
      aria-label="Preview controls, not the app"
      className="arco-demo w-full min-w-0 border-b-2 border-dashed border-[var(--color-arco-ink-40)] bg-[var(--color-arco-surface-muted)] px-4 py-3 text-[var(--color-arco-ink)] md:px-8"
      data-testid="investor-shell-preview-bar"
    >
      <div className="mx-auto flex w-full min-w-0 max-w-[1512px] flex-col gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">PREVIEW · fixture data · not the app</p>
          <p className="mt-1 break-words text-xs text-[var(--color-arco-text-soft)]">
            Real shell and pages. GIWA API and market data are in-page fixtures, /api/v1/stocks/* is the in-process harness, and every other off-origin request is blocked. This page sends no wallet request.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-8 gap-y-3">
          <Group label="Market data (re-mounts the app)">
            {MARKET_MODES.map((entry) => (
              <button key={entry.id} type="button" className={BUTTON} aria-pressed={mode === entry.id} data-market-mode={entry.id} onClick={() => onMode(entry.id)}>
                {entry.label}
              </button>
            ))}
          </Group>
          <Group label="Go to">
            {LINKS.map(([href, label]) => (
              <a key={href} href={href} className={BUTTON}>
                {label}
              </a>
            ))}
          </Group>
        </div>
        <RequestLog />
      </div>
    </section>
  )
}

function PreviewPage() {
  const [mode, setMode] = useState<MarketMode>(readMode)
  const choose = (next: MarketMode) => {
    writeMode(next)
    setMode(next)
  }
  return (
    <>
      <PreviewBar mode={mode} onMode={choose} />
      <PreviewApp key={mode} mode={mode} />
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreviewPage />
  </StrictMode>,
)
