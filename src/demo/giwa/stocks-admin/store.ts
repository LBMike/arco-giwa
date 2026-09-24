// Framework-independent state for the Stocks console (consumed via useSyncExternalStore).
//
// Ordering guarantees:
// - A "scope" is (apiBase, session.id, deploymentKey). Changing it aborts every request,
//   bumps the generation and clears all data, so a late response or error from the previous
//   session/deployment can never land on the new screen.
// - Each resource keeps a request sequence number; only the latest request may write.
// - Order detail additionally requires the response to be for the currently selected order.
// - 401 / 403 / disabled API abort everything and clear all data before showing that state.
// - Wallet submission diagnostics are read once when the selected order's detail first loads, with that detail's
//   server-verified side, and again only on an explicit refresh. They are cleared with the selection and written only
//   for the same order and side. A diagnostics-only 404 (order or route) or 503 stays on the diagnostics card.
import { LIST_PARSERS, STOCKS_ADMIN_PATHS, orderDetailPath, parseOrderDetail, stocksAdminGet, submissionDiagnosticsPath } from "./client"
import { parseSubmissionDiagnostics } from "./parse"
import type {
  AccessState,
  DetailState,
  DiagnosticsState,
  OrderSide,
  ListResourceKey,
  ResourceState,
  StocksAdminError,
  StocksAdminFetch,
  StocksAdminSession,
  StocksAdminSnapshot,
} from "./types"

export type StocksAdminStoreConfig = {
  readonly apiBase: string
  readonly session: StocksAdminSession | null
  readonly deploymentKey?: string
  readonly fetch?: StocksAdminFetch
  readonly now?: () => number
}

const IDLE = Object.freeze({ phase: "idle", value: null, error: null }) as ResourceState<never>

export function scopeKeyOf(config: Pick<StocksAdminStoreConfig, "apiBase" | "session" | "deploymentKey">): string {
  return JSON.stringify([config.apiBase, config.session?.id ?? null, config.deploymentKey ?? null])
}

function emptySnapshot(scopeKey: string, access: AccessState): StocksAdminSnapshot {
  return {
    scopeKey,
    access,
    overview: IDLE,
    orders: IDLE,
    reconciliation: IDLE,
    audit: IDLE,
    detail: { ...IDLE, orderId: null },
    diagnostics: { ...IDLE, orderId: null, side: null },
  }
}

const ACCESS_ERRORS: Partial<Record<StocksAdminError["kind"], AccessState>> = {
  unauthenticated: "signed_out",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  disabled: "disabled",
}

type RequestKey = ListResourceKey | "detail" | "diagnostics"

export class StocksAdminStore {
  private config: StocksAdminStoreConfig
  private snapshot: StocksAdminSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly controllers = new Map<RequestKey, AbortController>()
  private readonly latest = new Map<RequestKey, number>()
  private generation = 0
  private sequence = 0
  private active = true

  constructor(config: StocksAdminStoreConfig) {
    this.config = config
    this.snapshot = emptySnapshot(scopeKeyOf(config), config.session ? "ok" : "signed_out")
  }

  readonly getSnapshot = (): StocksAdminSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Applies new host props. A token-only change keeps data; a scope change resets it. */
  configure(config: StocksAdminStoreConfig): void {
    this.config = config
    const scopeKey = scopeKeyOf(config)
    if (scopeKey !== this.snapshot.scopeKey) this.reset(scopeKey, config.session ? "ok" : "signed_out")
  }

  load(key: ListResourceKey): void {
    if (!this.active || this.snapshot.access !== "ok") return
    const generation = this.generation
    const { sequence, signal } = this.begin(key)
    const current = this.snapshot[key] as ResourceState<unknown>
    this.write(key, { phase: "loading", value: current.value, error: null })
    const parse = LIST_PARSERS[key] as (data: unknown) => unknown
    void stocksAdminGet({ ...this.request(STOCKS_ADMIN_PATHS[key], signal), parse }).then((result) => {
      if (!this.isLatest(key, generation, sequence)) return
      this.controllers.delete(key)
      if (result.ok) {
        this.write(key, { phase: "ready", value: { data: result.data, meta: result.meta, loadedAt: this.now() }, error: null })
      } else if (!this.denyOnAccessError(result.error)) {
        this.write(key, { phase: "error", value: (this.snapshot[key] as ResourceState<unknown>).value, error: result.error })
      }
    })
  }

  /** Selects an order. The previous order's detail is cleared immediately, never shown under the new id. */
  selectOrder(orderId: string | null): void {
    if (!this.active) return
    const detail = this.snapshot.detail
    if (orderId !== null && orderId === detail.orderId && detail.phase !== "idle") return
    this.cancel("detail")
    this.cancel("diagnostics")
    this.writeDetail({ orderId, phase: "idle", value: null, error: null })
    // Another order's wallet submissions are never shown under this one, not even for one render.
    this.writeDiagnostics({ orderId, side: null, phase: "idle", value: null, error: null })
    if (orderId !== null) this.fetchDetail(orderId, false)
  }

  /** Explicit refresh of the selected order's diagnostics. Needs the side from its loaded detail; ignored while one runs. */
  refreshDiagnostics(): void {
    const { orderId, side, phase } = this.snapshot.diagnostics
    if (!this.active || orderId === null || side === null || phase === "loading") return
    this.fetchDiagnostics(orderId, side, true)
  }

  refreshDetail(): void {
    const orderId = this.snapshot.detail.orderId
    if (this.active && orderId !== null) this.fetchDetail(orderId, true)
  }

  /** After 401/403/disabled: forget the denial and let the view load again with current props. */
  retryAccess(): void {
    if (!this.active) return
    this.reset(this.snapshot.scopeKey, this.config.session ? "ok" : "signed_out")
  }

  /** Mount/unmount hooks (StrictMode-safe): deactivation aborts and clears; activation resumes. */
  activate(): void {
    if (this.active) return
    this.active = true
    this.reset(scopeKeyOf(this.config), this.config.session ? "ok" : "signed_out")
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.generation += 1
    this.abortAll()
  }

  private fetchDetail(orderId: string, keepValue: boolean): void {
    if (this.snapshot.access !== "ok") return
    const generation = this.generation
    const { sequence, signal } = this.begin("detail")
    this.writeDetail({ orderId, phase: "loading", value: keepValue ? this.snapshot.detail.value : null, error: null })
    void stocksAdminGet({ ...this.request(orderDetailPath(orderId), signal), parse: parseOrderDetail }).then((result) => {
      if (!this.isLatest("detail", generation, sequence) || this.snapshot.detail.orderId !== orderId) return
      this.controllers.delete("detail")
      if (result.ok && result.data.order.id === orderId) {
        this.writeDetail({ orderId, phase: "ready", value: { data: result.data, meta: result.meta, loadedAt: this.now() }, error: null })
        // The first successful detail gives the server-verified side: read the diagnostics once with it.
        const diagnostics = this.snapshot.diagnostics
        if (diagnostics.orderId === orderId && diagnostics.side === null && diagnostics.phase === "idle") this.fetchDiagnostics(orderId, result.data.order.side, false)
        return
      }
      const error: StocksAdminError = result.ok ? { kind: "invalid", status: null, code: null } : result.error
      if (!this.denyOnAccessError(error)) {
        this.writeDetail({ orderId, phase: "error", value: this.snapshot.detail.value, error })
      }
    })
  }

  private fetchDiagnostics(orderId: string, side: OrderSide, keepValue: boolean): void {
    if (this.snapshot.access !== "ok") return
    const generation = this.generation
    const { sequence, signal } = this.begin("diagnostics")
    const previous = this.snapshot.diagnostics
    this.writeDiagnostics({ orderId, side, phase: "loading", value: keepValue && previous.orderId === orderId && previous.side === side ? previous.value : null, error: null })
    void stocksAdminGet({ ...this.request(submissionDiagnosticsPath(side, orderId), signal), parse: (data: unknown) => data }).then((result) => {
      const current = this.snapshot.diagnostics
      if (!this.isLatest("diagnostics", generation, sequence) || current.orderId !== orderId || current.side !== side) return
      this.controllers.delete("diagnostics")
      if (result.ok) {
        let value: DiagnosticsState["value"] = null
        try {
          const data = parseSubmissionDiagnostics(result.data, { side, orderId, observedAt: result.meta.observedAt })
          // Cross-check with the loaded detail of the same order: same deployment and wallet, or the response is not shown.
          const detail = this.snapshot.detail.orderId === orderId ? this.snapshot.detail.value?.data.order : undefined
          if (!detail || detail.id !== orderId || detail.side !== side || detail.deploymentDigest !== data.deploymentDigest || detail.wallet.toLowerCase() !== data.order.wallet.toLowerCase()) throw new Error("scope")
          value = { data, meta: result.meta, loadedAt: this.now() }
        } catch {
          value = null
        }
        if (value) this.writeDiagnostics({ orderId, side, phase: "ready", value, error: null })
        else this.writeDiagnostics({ orderId, side, phase: "error", value: current.value, error: { kind: "invalid", status: null, code: null } })
        return
      }
      // 401 / 403: the same session and stocks:read as every admin route, so the existing global denial applies.
      // A 404 without a Stocks code means only this route is absent: the rest of the console stays usable.
      if (result.error.kind !== "disabled" && this.denyOnAccessError(result.error)) return
      this.writeDiagnostics({ orderId, side, phase: "error", value: current.value, error: result.error })
    })
  }

  private request(path: string, signal: AbortSignal) {
    return {
      apiBase: this.config.apiBase,
      path,
      // Read at send time so a rotated token (same session id) is used without a reset.
      accessToken: this.config.session?.accessToken ?? null,
      fetch: this.config.fetch,
      signal,
    }
  }

  private now(): number {
    return (this.config.now ?? Date.now)()
  }

  private begin(key: RequestKey): { sequence: number; signal: AbortSignal } {
    this.controllers.get(key)?.abort()
    const controller = new AbortController()
    this.controllers.set(key, controller)
    this.sequence += 1
    this.latest.set(key, this.sequence)
    return { sequence: this.sequence, signal: controller.signal }
  }

  private cancel(key: RequestKey): void {
    this.controllers.get(key)?.abort()
    this.controllers.delete(key)
    this.latest.delete(key)
  }

  private isLatest(key: RequestKey, generation: number, sequence: number): boolean {
    return this.active && generation === this.generation && this.latest.get(key) === sequence
  }

  private denyOnAccessError(error: StocksAdminError): boolean {
    const access = ACCESS_ERRORS[error.kind]
    if (!access) return false
    this.reset(this.snapshot.scopeKey, access)
    return true
  }

  private reset(scopeKey: string, access: AccessState): void {
    this.generation += 1
    this.abortAll()
    this.snapshot = emptySnapshot(scopeKey, access)
    this.emit()
  }

  private abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.latest.clear()
  }

  private write(key: ListResourceKey, state: ResourceState<unknown>): void {
    this.snapshot = { ...this.snapshot, [key]: state }
    this.emit()
  }

  private writeDetail(state: DetailState): void {
    this.snapshot = { ...this.snapshot, detail: state }
    this.emit()
  }

  private writeDiagnostics(state: DiagnosticsState): void {
    this.snapshot = { ...this.snapshot, diagnostics: state }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
