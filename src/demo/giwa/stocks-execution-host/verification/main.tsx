// VERIFICATION SCREEN ONLY. Not the app: not referenced by index.html, src/main.tsx, the router or the Vite config.
//
// Mounts the REAL /stocks page (StocksHostProvider > StocksPageEnvironment > stocksRoutes) in StrictMode against
// the offline loopback fixture served by ./serve.ts: the real in-process Stocks server harness answers /api/v1/*,
// and an in-page EIP-1193 object forwards each request to one fake wallet per fixture account. The fixture bar
// scripts accounts, networks, held/rejected wallet requests, chain outcomes and server state, and shows counters.
// No real wallet, key, signature, public network or asset. window.ethereum is never read or assigned.

import { StrictMode, useCallback, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom"

import "../../../../index.css"
import "../../../theme.css"
import type { HostDependencies } from "../../stocks-host/session"
import { StocksHostProvider } from "../../stocks-host/StocksHostProvider"
import { stocksRoutes } from "../../stocks-market/routes"
import { StocksPageEnvironment } from "../../stocks-market/StocksPages"
import type { ActiveWalletSource, Eip1193Provider } from "../../stocks-wallet-source/types"

type Account = "A" | "B"
type Network = "reviewed" | "other-checkpoint" | "other-chain" | "missing-checkpoint"
type Listener = (...args: unknown[]) => void
type FixtureOrder = { side: "BUY" | "SELL"; id: string; state: string; wallet: string; createdAt: string }
type FixtureState = {
  network: Network
  finalizeImmediately: boolean
  paused: boolean
  evidenceAvailable: boolean
  wallet: Record<"A" | "B" | "disconnected", Record<string, number>>
  routes: Record<string, number>
  held: Record<Account, { armed: boolean; waiting: boolean }>
  orders: FixtureOrder[]
  orderStates: Record<"BUY" | "SELL", string[]>
  chain: { transactions: number; latestBlock: string; finalizedBlock: string }
}

const ADDRESSES: Readonly<Record<Account, string>> = Object.freeze({
  A: "0x1111111111111111111111111111111111111111",
  B: "0x2222222222222222222222222222222222222222",
})
/** FIXTURE: the loopback auth route does not verify signatures. There is no key. */
const FIXTURE_SIGNATURE = `0x${"ab".repeat(65)}`
/** 10 NVDA at quantityScale 9. */
const SEED_STOCK_UNITS = "10000000000"
const ORIGIN = window.location.origin
const NETWORKS: readonly Network[] = ["reviewed", "other-checkpoint", "other-chain", "missing-checkpoint"]

// ── in-page fixture wallet (module scope, synchronous) ───────────────────────────────────────────────

let currentAccount: Account | null = "A"
const listeners = new Map<string, Set<Listener>>()

function emit(event: string, ...args: unknown[]) {
  for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
}

/** One EIP-1193 object for the page's lifetime, like an injected wallet. Each request issues one POST. */
const fixtureProvider: Eip1193Provider = {
  request({ method, params }) {
    const account = currentAccount
    return window
      .fetch("/__fixture/wallet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account, method, params }) })
      .then((response) => response.json() as Promise<{ result?: unknown; error?: { code: number | string } }>)
      .then((payload) => {
        if (payload.error) throw Object.assign(new Error("Fixture wallet error"), { code: payload.error.code })
        return payload.result
      })
  },
  on(event, listener) {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(listener)
    return fixtureProvider
  },
  removeListener(event, listener) {
    listeners.get(event)?.delete(listener)
    return fixtureProvider
  },
}

const INJECTED_SOURCE: ActiveWalletSource = Object.freeze({ mode: "injected", provider: fixtureProvider })
const DYNAMIC_SOURCE: ActiveWalletSource = Object.freeze({ mode: "dynamic", client: Object.freeze({}) })
let activeSource: ActiveWalletSource = INJECTED_SOURCE
const readActiveSource = () => activeSource

const HOST_DEPENDENCIES: HostDependencies = {
  fetch: window.fetch.bind(window),
  async signMessage() { return FIXTURE_SIGNATURE },
  now: () => Date.now(),
}
const PAGE_ENVIRONMENT = { apiBase: ORIGIN, activeWalletSource: readActiveSource }
const router = createMemoryRouter(stocksRoutes(<Outlet />), { initialEntries: ["/stocks"] })

async function postControl(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await window.fetch("/__fixture/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const payload = (await response.json()) as Record<string, unknown> & { error?: { code: string } }
  if (!response.ok || payload.error) throw new Error(payload.error?.code ?? `FIXTURE_HTTP_${response.status}`)
  return payload
}

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

const sum = (state: FixtureState | null, method: string) =>
  state ? (state.wallet.A[method] ?? 0) + (state.wallet.B[method] ?? 0) + (state.wallet.disconnected[method] ?? 0) : 0
const route = (state: FixtureState | null, key: string) => (state ? state.routes[key] ?? 0 : 0)

type FixtureView = { account: Account | null; epoch: number; chainId: number; pinChain: boolean; dynamic: boolean }

function FixtureBar({ view, setView }: { view: FixtureView; setView: (update: (current: FixtureView) => FixtureView) => void }) {
  const [state, setState] = useState<FixtureState | null>(null)
  const [message, setMessage] = useState("Fixture ready.")
  const [orderKey, setOrderKey] = useState("")
  const [orderState, setOrderState] = useState("")

  const refresh = useCallback(async () => {
    try {
      const response = await window.fetch("/__fixture/state", { cache: "no-store" })
      if (response.ok) setState((await response.json()) as FixtureState)
    } catch {
      setMessage("Fixture state unavailable (is serve.ts running?).")
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const run = async (label: string, body: Record<string, unknown>) => {
    try {
      const result = await postControl(body)
      setMessage(`${label}: done.`)
      await refresh()
      return result
    } catch (error) {
      setMessage(`${label}: ${error instanceof Error ? error.message : "FIXTURE_ERROR"}`)
      return null
    }
  }

  const selectAccount = (next: Account | null) => {
    currentAccount = next
    emit("accountsChanged", next === null ? [] : [ADDRESSES[next]])
    setView((current) => ({ ...current, account: next, epoch: current.epoch + 1 }))
    setMessage(next === null ? "Wallet disconnected." : `Account ${next} selected.`)
  }

  const selectNetwork = async (variant: Network) => {
    const result = await run(`Network ${variant}`, { action: "setNetwork", variant })
    if (!result || typeof result.chainId !== "string") return
    const chainHex = result.chainId
    emit("chainChanged", chainHex)
    setView((current) => ({ ...current, chainId: Number.parseInt(chainHex, 16), epoch: current.epoch + 1 }))
  }

  const toggleDynamic = () => {
    const dynamic = !view.dynamic
    activeSource = dynamic ? DYNAMIC_SOURCE : INJECTED_SOURCE
    setView((current) => ({ ...current, dynamic, epoch: current.epoch + 1 }))
    setMessage(dynamic ? "Dynamic (unsupported) source active." : "Injected fixture source active.")
  }

  const account = view.account
  const orders = state?.orders ?? []
  const selectedOrder = orders.find((order) => `${order.side}:${order.id}` === orderKey) ?? orders[0] ?? null
  const states = selectedOrder && state ? state.orderStates[selectedOrder.side] : []
  const chosenState = states.includes(orderState) ? orderState : states[0] ?? ""
  const held = account && state ? state.held[account] : null
  const hostChain = view.pinChain ? 91342 : view.chainId

  const counters: [string, number | string][] = [
    ["eth_sendTransaction", sum(state, "eth_sendTransaction")],
    ["wallet_sendTransaction", sum(state, "wallet_sendTransaction")],
    ["eth_sendRawTransaction", sum(state, "eth_sendRawTransaction")],
    ["claims", route(state, "POST /api/v1/stocks/wallet-submissions/claims")],
    ["outcomes", route(state, "POST /api/v1/stocks/wallet-submissions/outcomes")],
    ["reconcile", route(state, "POST /api/v1/stocks/wallet-submissions/reconcile")],
    ["chain txs", state?.chain.transactions ?? 0],
    ["held send", held ? (held.waiting ? "waiting" : held.armed ? "armed" : "none") : "n/a"],
  ]

  return (
    <section
      aria-label="Verification fixture controls"
      className="w-full min-w-0 rounded-[var(--radius-strategy)] border-2 border-dashed border-[var(--color-arco-ink-40)] bg-[var(--color-arco-surface-muted)] p-4"
      data-testid="verification-fixture-bar"
    >
      <p className="text-sm font-semibold text-[var(--color-arco-ink)]">Verification fixture — not the app. Offline loopback server; fake wallet; no real assets</p>
      <p className="mt-1 break-words text-xs text-[var(--color-arco-text-soft)]">
        Host view: {account ? `account ${account} ${ADDRESSES[account]}` : "disconnected"} · chain {hostChain} · epoch fixture:{view.epoch} · source{" "}
        {view.dynamic ? "dynamic (unsupported)" : "injected fixture"} · wallet network {state?.network ?? "…"}
      </p>

      <dl className="mt-3 grid w-full grid-cols-2 gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-3 text-xs sm:grid-cols-4" data-testid="verification-counters">
        {counters.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col">
            <dt className="break-words text-[var(--color-arco-text-soft)]">{label}</dt>
            <dd className="font-mono text-sm text-[var(--color-arco-ink)]">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 grid w-full gap-4 md:grid-cols-2">
        <Group label="Wallet account">
          <Toggle pressed={account === "A"} onClick={() => selectAccount("A")}>Account A</Toggle>
          <Toggle pressed={account === "B"} onClick={() => selectAccount("B")}>Account B</Toggle>
          <Toggle pressed={account === null} onClick={() => selectAccount(null)}>Disconnect</Toggle>
          <Toggle pressed={view.dynamic} onClick={toggleDynamic}>Dynamic (unsupported) source</Toggle>
        </Group>
        <Group label="Wallet network">
          {NETWORKS.map((variant) => (
            <Toggle key={variant} pressed={state?.network === variant} onClick={() => void selectNetwork(variant)}>{variant}</Toggle>
          ))}
          <Toggle pressed={view.pinChain} onClick={() => setView((current) => ({ ...current, pinChain: !current.pinChain, epoch: current.epoch + 1 }))}>Host view pins chain 91342</Toggle>
        </Group>
        <Group label={`Next eth_sendTransaction (${account ? `account ${account}` : "no account"})`}>
          <Toggle disabled={!account} onClick={() => void run("Hold next send", { action: "holdNextSend", account })}>Hold next send</Toggle>
          <Toggle disabled={!account || !held?.waiting} onClick={() => void run("Release held send", { action: "releaseHeld", account })}>Release held</Toggle>
          <Toggle disabled={!account} onClick={() => void run("Reject next send 4001", { action: "rejectNextSend", account, code: 4001 })}>Reject 4001</Toggle>
          <Toggle disabled={!account} onClick={() => void run("Reject next send -32603", { action: "rejectNextSend", account, code: -32603 })}>Reject -32603</Toggle>
        </Group>
        <Group label="Fake chain">
          <Toggle onClick={() => void run("Revert next transaction", { action: "revertNextTransaction" })}>Revert next tx</Toggle>
          <Toggle pressed={state?.finalizeImmediately ?? true} onClick={() => void run("Finalize immediately", { action: "setFinalize", value: !(state?.finalizeImmediately ?? true) })}>Finalize immediately</Toggle>
          <Toggle onClick={() => void run("Finalize now", { action: "finalizeNow" })}>Finalize now</Toggle>
        </Group>
        <Group label="Server">
          <Toggle pressed={state?.paused ?? false} onClick={() => void run("Pause", { action: "setPaused", value: !(state?.paused ?? false) })}>Paused</Toggle>
          <Toggle pressed={state ? !state.evidenceAvailable : false} onClick={() => void run("Evidence unavailable", { action: "setEvidenceAvailable", value: !(state?.evidenceAvailable ?? true) })}>Evidence unavailable</Toggle>
          <Toggle onClick={() => void run("Seed 10 NVDA for A", { action: "seedStock", account: "A", units: SEED_STOCK_UNITS })}>Seed 10 NVDA for A</Toggle>
        </Group>
        <Group label="Order state (observer emulation)">
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-[var(--color-arco-text-soft)]">
            Order
            <select className={SELECT} value={selectedOrder ? `${selectedOrder.side}:${selectedOrder.id}` : ""} onChange={(event) => setOrderKey(event.target.value)} disabled={orders.length === 0}>
              {orders.length === 0 ? <option value="">No orders yet</option> : null}
              {orders.map((order) => (
                <option key={`${order.side}:${order.id}`} value={`${order.side}:${order.id}`}>
                  {order.side} {order.id.slice(0, 8)} · {order.state}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-[var(--color-arco-text-soft)]">
            State
            <select className={SELECT} value={chosenState} onChange={(event) => setOrderState(event.target.value)} disabled={!selectedOrder}>
              {states.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <Toggle disabled={!selectedOrder || !chosenState} onClick={() => selectedOrder && void run(`Set ${selectedOrder.side} state ${chosenState}`, { action: "setOrderState", side: selectedOrder.side, id: selectedOrder.id, state: chosenState })}>Apply state</Toggle>
        </Group>
      </div>
      <p className="mt-3 break-words text-xs text-[var(--color-arco-ink)]" role="status" aria-live="polite" data-testid="verification-fixture-message">{message}</p>
    </section>
  )
}

// ── page ────────────────────────────────────────────────────────────────────────────────────────────

function VerificationPage() {
  const [view, setView] = useState<FixtureView>({ account: "A", epoch: 0, chainId: 91342, pinChain: false, dynamic: false })
  const walletAddress = view.account ? ADDRESSES[view.account] : null
  const context = {
    walletAddress,
    chainId: walletAddress ? (view.pinChain ? 91342 : view.chainId) : null,
    frontendOrigin: ORIGIN,
    apiBase: ORIGIN,
    walletEpoch: `fixture:${view.epoch}`,
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 bg-[var(--color-arco-page)] px-4 py-6 text-[var(--color-arco-ink)]">
      <FixtureBar view={view} setView={setView} />
      <StocksHostProvider context={context} dependencies={HOST_DEPENDENCIES} walletSource={view.dynamic ? DYNAMIC_SOURCE : INJECTED_SOURCE}>
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
