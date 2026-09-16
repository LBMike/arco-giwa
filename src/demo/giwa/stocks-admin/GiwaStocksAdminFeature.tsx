import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { KeyRound, ShieldOff, PlugZap } from "lucide-react"
import { AuditPanel } from "./AuditPanel"
import { formatUtc } from "./format"
import { OrdersPanel } from "./OrdersPanel"
import { OverviewPanel } from "./OverviewPanel"
import { ReconciliationPanel } from "./ReconciliationPanel"
import { StocksAdminStore } from "./store"
import type {
  AccessState,
  GiwaStocksAdminFeatureProps,
  ListResourceKey,
  StocksAdminSection,
  StocksAdminSnapshot,
  StocksEnvelopeMeta,
} from "./types"
import { Button, FOCUS_RING, Mono } from "./ui"

export const SECTIONS: readonly { id: StocksAdminSection; label: string }[] = [
  { id: "overview", label: "Operations overview" },
  { id: "orders", label: "Orders" },
  { id: "reconciliation", label: "Balance reconciliation" },
  { id: "audit", label: "Audit history" },
]

export const SECTION_RESOURCES: Record<StocksAdminSection, readonly ListResourceKey[]> = {
  overview: ["overview", "orders"],
  orders: ["orders"],
  reconciliation: ["reconciliation"],
  audit: ["audit"],
}

/** Roving-tab keyboard model: arrows move and activate, Home/End jump. */
export function nextSectionIndex(current: number, key: string, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return null
}

function useTicker(now: () => number, intervalMs: number): number {
  const [value, setValue] = useState(now)
  useEffect(() => {
    setValue(now())
    const id = setInterval(() => setValue(now()), intervalMs)
    return () => clearInterval(id)
  }, [now, intervalMs])
  return value
}

/** Most recent envelope metadata among the loaded resources (environment comes from the server). */
export function latestMeta(snapshot: StocksAdminSnapshot): StocksEnvelopeMeta | null {
  const loaded = [snapshot.overview.value, snapshot.orders.value, snapshot.reconciliation.value, snapshot.audit.value, snapshot.detail.value]
  let best: { meta: StocksEnvelopeMeta; loadedAt: number } | null = null
  for (const value of loaded) if (value && (!best || value.loadedAt > best.loadedAt)) best = value
  return best?.meta ?? null
}

export function GiwaStocksAdminFeature(props: GiwaStocksAdminFeatureProps) {
  const now = props.now ?? Date.now
  const [store] = useState(() => new StocksAdminStore({ ...props, now }))
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [section, setSection] = useState<StocksAdminSection>(props.initialSection ?? "overview")
  const clock = useTicker(now, 15_000)

  useEffect(() => {
    store.configure({ apiBase: props.apiBase, session: props.session, deploymentKey: props.deploymentKey, fetch: props.fetch, now })
  }, [store, props.apiBase, props.session, props.deploymentKey, props.fetch, now])

  useEffect(() => {
    store.activate()
    return () => store.deactivate()
  }, [store])

  useEffect(() => {
    if (snapshot.access !== "ok") return
    for (const key of SECTION_RESOURCES[section]) if (snapshot[key].phase === "idle") store.load(key)
  }, [store, section, snapshot])

  const openOrder = useCallback(
    (orderId: string) => {
      setSection("orders")
      store.selectOrder(orderId)
    },
    [store],
  )

  return (
    <StocksAdminView
      snapshot={snapshot}
      section={section}
      now={clock}
      onSectionChange={setSection}
      onLoad={(key) => store.load(key)}
      onSelectOrder={(orderId) => store.selectOrder(orderId)}
      onOpenOrder={openOrder}
      onRefreshDetail={() => store.refreshDetail()}
      onRetryAccess={() => store.retryAccess()}
      onSignInRequired={props.onSignInRequired}
    />
  )
}

export type StocksAdminViewProps = {
  snapshot: StocksAdminSnapshot
  section: StocksAdminSection
  now: number
  onSectionChange: (section: StocksAdminSection) => void
  onLoad: (key: ListResourceKey) => void
  onSelectOrder: (orderId: string) => void
  onOpenOrder: (orderId: string) => void
  onRefreshDetail: () => void
  onRetryAccess: () => void
  onSignInRequired?: () => void
}

/** Pure view of a store snapshot (rendered directly by SSR tests). */
export function StocksAdminView(props: StocksAdminViewProps) {
  const { snapshot, section, now } = props
  const ids = useId()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const activeIndex = SECTIONS.findIndex((item) => item.id === section)

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextSectionIndex(activeIndex, event.key, SECTIONS.length)
    if (next === null) return
    event.preventDefault()
    props.onSectionChange(SECTIONS[next].id)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      <Header snapshot={snapshot} />
      {snapshot.access !== "ok" ? (
        <AccessPanel access={snapshot.access} onRetry={props.onRetryAccess} onSignInRequired={props.onSignInRequired} />
      ) : (
        <div className="grid w-full min-w-0 gap-4 lg:grid-cols-[208px_minmax(0,1fr)]">
          <div
            role="tablist"
            aria-label="Stocks admin sections"
            className="grid min-w-0 grid-cols-2 gap-1 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-1 shadow-[var(--shadow-control)] sm:flex sm:flex-wrap lg:flex-col lg:self-start"
          >
            {SECTIONS.map((item, index) => {
              const selected = item.id === section
              return (
                <button
                  key={item.id}
                  ref={(node) => {
                    tabRefs.current[index] = node
                  }}
                  type="button"
                  role="tab"
                  id={`${ids}-tab-${item.id}`}
                  aria-selected={selected}
                  aria-controls={`${ids}-panel-${item.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => props.onSectionChange(item.id)}
                  onKeyDown={onTabKeyDown}
                  className={`min-w-0 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm ${FOCUS_RING} ${
                    selected
                      ? "bg-[var(--color-arco-ink)] font-medium text-[var(--color-arco-on-dark)]"
                      : "text-[var(--color-arco-text)]"
                  }`}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
          <div
            role="tabpanel"
            id={`${ids}-panel-${section}`}
            aria-labelledby={`${ids}-tab-${section}`}
            tabIndex={0}
            className={`min-w-0 rounded-[var(--radius-card)] ${FOCUS_RING}`}
          >
            {section === "overview" && (
              <OverviewPanel
                overview={snapshot.overview}
                orders={snapshot.orders}
                now={now}
                onRefresh={() => {
                  props.onLoad("overview")
                  props.onLoad("orders")
                }}
                onOpenOrder={props.onOpenOrder}
              />
            )}
            {section === "orders" && (
              <OrdersPanel
                orders={snapshot.orders}
                detail={snapshot.detail}
                now={now}
                onRefresh={() => props.onLoad("orders")}
                onSelect={props.onSelectOrder}
                onRefreshDetail={props.onRefreshDetail}
              />
            )}
            {section === "reconciliation" && (
              <ReconciliationPanel reconciliation={snapshot.reconciliation} now={now} onRefresh={() => props.onLoad("reconciliation")} />
            )}
            {section === "audit" && <AuditPanel audit={snapshot.audit} now={now} onRefresh={() => props.onLoad("audit")} />}
          </div>
        </div>
      )}
    </div>
  )
}

function Header({ snapshot }: { snapshot: StocksAdminSnapshot }) {
  const meta = snapshot.access === "ok" ? latestMeta(snapshot) : null
  const deployments = snapshot.orders.value ? [...new Set(snapshot.orders.value.data.map((row) => row.deploymentId))] : []
  return (
    <header className="w-full min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
      <p className="text-xs text-[var(--color-arco-text-soft)]">Admin · Stocks · read only</p>
      <h2 className="mt-1 text-xl font-semibold text-[var(--color-arco-ink)]">Stocks operations</h2>
      {meta ? (
        <div className="mt-3 flex min-w-0 flex-col gap-2">
          <ul aria-label="Environment reported by the server" className="flex flex-wrap gap-1.5">
            {[meta.profile, meta.brokerMode, meta.valuePolicy, meta.priceSource, `Chain ${meta.chainId}`].map((label) => (
              <li
                key={label}
                className="rounded-[var(--radius-pill)] border border-[var(--color-arco-border)] bg-[var(--color-arco-chip)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-arco-ink)]"
              >
                {label}
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-4 text-[var(--color-arco-text-soft)]">
            Latest server response <span className="font-mono">{formatUtc(meta.observedAt)}</span> — the response time, not a claim that chain
            data is current.{" "}
            {deployments.length === 1 ? (
              <>
                Deployment (from loaded orders): <Mono value={deployments[0]} />
              </>
            ) : deployments.length > 1 ? (
              <span className="font-semibold text-[var(--color-arco-down)]">Loaded orders report {deployments.length} different deployments.</span>
            ) : (
              "Deployment id is only reported on order rows; none are loaded."
            )}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--color-arco-text-soft)]">
          {snapshot.access === "ok" ? "Environment not yet reported by the server." : "No environment is shown without an authorized server response."}
        </p>
      )}
    </header>
  )
}

const ACCESS_COPY: Record<Exclude<AccessState, "ok">, { title: string; body: string }> = {
  signed_out: {
    title: "Operator session required",
    body: "Sign in with an operator wallet. Stocks admin data is read with that session's Bearer token and the server's named stocks:read permission; the legacy operator token is not used.",
  },
  unauthorized: {
    title: "Session missing or expired (401)",
    body: "The server did not accept the session. All previously loaded Stocks data has been cleared. Sign in again, then check access.",
  },
  forbidden: {
    title: "No Stocks read permission (403)",
    body: "The server did not grant stocks:read to this session. It also answers 403 when it cannot verify the session. All previously loaded Stocks data has been cleared.",
  },
  disabled: {
    title: "Stocks admin API is not enabled on this server",
    body: "The Stocks routes are not registered (the Stocks runtime is not connected). There is no Stocks data to show.",
  },
}

function AccessPanel({ access, onRetry, onSignInRequired }: { access: Exclude<AccessState, "ok">; onRetry: () => void; onSignInRequired?: () => void }) {
  const copy = ACCESS_COPY[access]
  const Icon = access === "disabled" ? PlugZap : access === "forbidden" ? ShieldOff : KeyRound
  return (
    <section
      role={access === "signed_out" ? "status" : "alert"}
      className="w-full rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] p-6"
    >
      <Icon aria-hidden="true" className="size-5 text-[var(--color-arco-ink)]" />
      <h3 className="mt-2 text-sm font-semibold text-[var(--color-arco-ink)]">{copy.title}</h3>
      <p className="mt-1 max-w-[640px] text-xs leading-5 text-[var(--color-arco-text-soft)]">{copy.body}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {onSignInRequired && (access === "signed_out" || access === "unauthorized") && (
          <Button onClick={onSignInRequired}>Sign in with operator wallet</Button>
        )}
        {access !== "signed_out" && <Button onClick={onRetry}>Check access again</Button>}
      </div>
    </section>
  )
}
