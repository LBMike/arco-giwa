// Framework-independent state machine for the Stocks investor module.
//
// Isolation model
//   • identity = API client + verified wallet/chain/token (or signed-out reason) + deployment.
//     Any change starts a new GENERATION: every in-flight request is aborted, displayed quote,
//     order, list, portfolio, errors and 401 state are cleared, and every late answer from an
//     older generation is ignored (abort AND a generation check, because a transport may ignore
//     abort).
//   • An order attempt is owned by (API base URL, deployment, wallet, chain). It is kept in an
//     in-memory registry that outlives one mounted feature (never browser storage), so returning to
//     the same wallet, remounting, or re-creating the client shows the same unresolved attempt with
//     the same body and idempotency key; another wallet never sees it. An attempt whose answer can
//     no longer be observed becomes UNCONFIRMED — never failed, never resubmitted.
//   • Once any send of an attempt had an unknown outcome, a later refusal only resolves it when the
//     server checks that code AFTER its idempotency lookup (quote/stock checks). Refusals that come
//     before the lookup (pause, activation, unregistered route, 401) say nothing about the earlier
//     send and keep the attempt unresolved.
// Order rules
//   • One submission at a time (synchronous guard). No answer, a 500, an unrecognised body or a
//     mismatched order keeps the attempt UNCONFIRMED with its exact body. A retry resends that body.
//   • An expired quote blocks ordering. A new quote is only ever requested by the user.
// Nothing here stores to browser storage, computes money with numbers, or invents results.

import { GiwaStocksRequestError, type GiwaStocksClient } from "./client"
import { parseHumanDecimal, type HumanDecimalCheck } from "./decimal"
import { attemptOwnerKey, normalizeSession, sessionIdentityKey, type NormalizedSession } from "./session"
import { orderStatusMeaning } from "./status"
import {
  STOCKS_QUANTITY_SCALE,
  type GiwaStocksHostWallet,
  type GiwaStocksSession,
  type StocksCatalog,
  type StocksOrder,
  type StocksOrderRequest,
  type StocksPortfolio,
  type StocksQuote,
  type StocksSide,
} from "./types"

export const QUOTE_MAX_TTL_MS = 60_000
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9:_-]{8,128}$/

export type FeatureErrorKind =
  /** No usable answer. For an order the outcome is unknown. */
  | "NETWORK"
  /** Stocks routes are not registered on this server. */
  | "NOT_REGISTERED"
  /** Not a valid Stocks response. */
  | "INVALID_RESPONSE"
  /** A validated server refusal (StocksError), with its code. */
  | "REFUSED"
  /** 401 for the current session. */
  | "UNAUTHORIZED"
  /** A valid response that does not answer this request / this wallet / this deployment. */
  | "MISMATCH"
  /** Nothing was sent (e.g. an unsafe idempotency key from the host). */
  | "LOCAL"

export type FeatureError = Readonly<{ kind: FeatureErrorKind; status: number | null; code: string | null }>

export type CatalogState =
  | { status: "idle" }
  | { status: "loading"; previous: StocksCatalog | null }
  | { status: "ready"; catalog: StocksCatalog }
  | { status: "unavailable"; error: FeatureError; previous: StocksCatalog | null }
  | { status: "error"; error: FeatureError; previous: StocksCatalog | null }

export type QuoteState =
  | { status: "idle" }
  | { status: "loading"; side: StocksSide; quantity: string }
  | { status: "ready" | "expired"; quote: StocksQuote; deadlineMs: number; observedAt: string }
  | { status: "error"; side: StocksSide; error: FeatureError }

export type OrderAttemptStatus = "SUBMITTING" | "UNCONFIRMED" | "AUTH_REQUIRED" | "ACCEPTED" | "REJECTED"

export type OrderAttempt = Readonly<{
  side: StocksSide
  quote: StocksQuote
  /** The exact body sent, and resent on retry. */
  body: Readonly<StocksOrderRequest>
  status: OrderAttemptStatus
  order: StocksOrder | null
  orderObservedAt: string | null
  error: FeatureError | null
  /** True once any send of this exact request ended without an observable answer. */
  outcomeUnknown: boolean
  lookup: "NOT_CHECKED" | "CHECKING" | "NOT_FOUND"
  refresh: "IDLE" | "LOADING"
}>

export type SideOrders = { status: "ready"; orders: StocksOrder[]; observedAt: string } | { status: "error"; error: FeatureError }

export type OrdersState = { status: "idle" | "loading" } | { status: "ready"; buy: SideOrders; sell: SideOrders }

export type SelectedOrderState = Readonly<{ order: StocksOrder; observedAt: string; refresh: "IDLE" | "LOADING"; error: FeatureError | null }> | null

export type PortfolioState = { status: "idle" | "loading" } | { status: "ready"; portfolio: StocksPortfolio; observedAt: string } | { status: "error"; error: FeatureError }

export type StocksInvestorState = Readonly<{
  generation: number
  identityKey: string
  clientConfigured: boolean
  session: NormalizedSession
  authRejected: boolean
  catalog: CatalogState
  side: StocksSide
  quantityInput: string
  quantityCheck: HumanDecimalCheck
  quote: QuoteState
  attempt: OrderAttempt | null
  selectedOrder: SelectedOrderState
  orders: OrdersState
  portfolio: PortfolioState
  nowMs: number
}>

export type StocksInvestorContext = {
  client: GiwaStocksClient | null
  session: GiwaStocksSession
  hostWallet?: GiwaStocksHostWallet | null
  onSessionRejected?: (event: { walletAddress: string }) => void
}

export type StocksInvestorControllerOptions = {
  /** Monotonic milliseconds (default performance.now). Used only for quote deadlines. */
  now?: () => number
  newIdempotencyKey?: () => string
  /** In-memory attempt registry. Defaults to one shared per page; tests pass their own. */
  attemptRegistry?: Map<string, OrderAttempt>
}

/** Page-lifetime, memory-only registry of order attempts, shared by every mounted feature. */
const sharedAttemptRegistry = new Map<string, OrderAttempt>()

/**
 * Refusals the server raises only after its idempotency lookup (server/src/stocks/service.ts and
 * sell-service.ts createOrder). If an earlier send with this key had created an order, the lookup
 * would have returned that order instead, so these codes prove no order exists under the key.
 * Everything checked before the lookup (401, body shape in plugin.ts, INVALID_ORDER_REQUEST, the
 * 503s from ready(), an unregistered route) says nothing about an earlier send. IDEMPOTENCY_CONFLICT
 * means a row with this key already exists, so it never resolves the attempt either.
 */
const RESOLVES_AFTER_UNKNOWN = new Set([
  "QUOTE_NOT_FOUND",
  "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED",
  "QUOTE_ALREADY_USED",
  "INSUFFICIENT_AVAILABLE_STOCK",
])

const clientIds = new WeakMap<object, number>()
let nextClientId = 1

function clientIdOf(client: GiwaStocksClient | null, assign: boolean): number | null {
  if (client === null) return null
  const known = clientIds.get(client)
  if (known !== undefined) return known
  if (!assign) return -1
  const id = nextClientId++
  clientIds.set(client, id)
  return id
}

export function defaultIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === "function") return `stocks-${cryptoApi.randomUUID()}`
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  return `stocks-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function toFeatureError(error: unknown): FeatureError | null {
  if (error instanceof GiwaStocksRequestError) {
    switch (error.kind) {
      case "ABORTED":
        return null
      case "HTTP":
        return error.status === 401
          ? { kind: "UNAUTHORIZED", status: 401, code: error.code }
          : { kind: "REFUSED", status: error.status, code: error.code }
      default:
        return { kind: error.kind, status: error.status, code: error.code }
    }
  }
  return { kind: "INVALID_RESPONSE", status: null, code: "CLIENT_FAILURE" }
}

const UNRESOLVED: ReadonlySet<OrderAttemptStatus> = new Set(["SUBMITTING", "UNCONFIRMED", "AUTH_REQUIRED"])

export function isUnresolved(attempt: OrderAttempt | null): boolean {
  return attempt !== null && UNRESOLVED.has(attempt.status)
}

export type TradeBlock =
  | "NO_CLIENT"
  | "CATALOG_NOT_READY"
  | "NOT_ACTIVATED"
  | "SIGNED_OUT"
  | "AUTH_REJECTED"
  | "ATTEMPT_UNRESOLVED"
  | "ATTEMPT_OPEN"
  | null

export function tradeBlock(state: StocksInvestorState): TradeBlock {
  if (!state.clientConfigured) return "NO_CLIENT"
  if (state.catalog.status !== "ready") return "CATALOG_NOT_READY"
  const instrument = state.catalog.catalog.instruments.find((item) => item.symbol === "NVDA")
  if (!instrument || instrument.orderCapability !== "CHECK_PAUSE_AT_ORDER") return "NOT_ACTIVATED"
  if (state.session.status !== "verified") return "SIGNED_OUT"
  if (state.authRejected) return "AUTH_REJECTED"
  if (isUnresolved(state.attempt)) return "ATTEMPT_UNRESOLVED"
  if (state.attempt?.status === "ACCEPTED") return "ATTEMPT_OPEN"
  return null
}

export class StocksInvestorController {
  private state: StocksInvestorState
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly newKey: () => string
  private client: GiwaStocksClient | null = null
  private clientId: number | null = null
  private suspended = false
  private deploymentId: string | null = null
  private onSessionRejected: StocksInvestorContext["onSessionRejected"]
  private abort = new AbortController()
  /** Order submissions are never aborted: a sent body may already be applied. They are only unobserved. */
  private orderAbort = new AbortController()
  private catalogAbort = new AbortController()
  private catalogSeq = 0
  private quoteSeq = 0
  private ordersSeq = 0
  private portfolioSeq = 0
  private selectedSeq = 0
  private submitting = false
  private rejectionReported = false
  private readonly attempts: Map<string, OrderAttempt>
  /** Owners whose in-flight work this controller started; only these are retired with a generation. */
  private readonly touchedOwners = new Set<string>()

  constructor(options: StocksInvestorControllerOptions = {}) {
    this.now = options.now ?? (() => performance.now())
    this.newKey = options.newIdempotencyKey ?? defaultIdempotencyKey
    this.attempts = options.attemptRegistry ?? sharedAttemptRegistry
    const session: NormalizedSession = { status: "signed-out", reason: "SIGNED_OUT" }
    const initial: StocksInvestorState = {
      generation: 0,
      identityKey: sessionIdentityKey(null, session, null),
      clientConfigured: false,
      session,
      authRejected: false,
      catalog: { status: "idle" },
      side: "BUY",
      quantityInput: "",
      quantityCheck: parseHumanDecimal("", STOCKS_QUANTITY_SCALE),
      quote: { status: "idle" },
      attempt: null,
      selectedOrder: null,
      orders: { status: "idle" },
      portfolio: { status: "idle" },
      nowMs: this.now(),
    }
    this.state = Object.freeze(initial)
  }

  readonly getState = (): StocksInvestorState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<StocksInvestorState>): void {
    this.state = Object.freeze({ ...this.state, ...patch })
    for (const listener of [...this.listeners]) listener()
  }

  /** The identity a context WOULD have, without changing anything (lets a view avoid painting stale data). */
  identityFor(context: StocksInvestorContext): string {
    return sessionIdentityKey(clientIdOf(context.client, false), normalizeSession(context.session, context.hostWallet), this.deploymentId)
  }

  private ownerKey(): string | null {
    return attemptOwnerKey(this.client?.baseUrl ?? null, this.state.session, this.deploymentId)
  }

  // ── context and generations ─────────────────────────────────────────────

  setContext(context: StocksInvestorContext): void {
    this.onSessionRejected = context.onSessionRejected
    const clientId = clientIdOf(context.client, true)
    const clientChanged = clientId !== this.clientId || this.suspended
    this.suspended = false
    if (clientChanged) {
      this.client = context.client
      this.clientId = clientId
      this.deploymentId = null
      this.catalogSeq += 1
      this.catalogAbort.abort()
      this.catalogAbort = new AbortController()
      this.set({ clientConfigured: context.client !== null, catalog: context.client === null ? { status: "idle" } : { status: "loading", previous: null } })
    }
    this.enterIdentity(normalizeSession(context.session, context.hostWallet))
    if (clientChanged && context.client !== null) void this.loadCatalog()
  }

  /**
   * Unmount / StrictMode cleanup: stop observing everything; the next setContext starts afresh.
   * An in-flight order POST is not aborted (its body may already be applied); its answer is simply
   * no longer observed, so the attempt becomes UNCONFIRMED in the shared registry.
   */
  suspend(): void {
    this.suspended = true
    this.catalogAbort.abort()
    this.catalogSeq += 1
    this.retireGeneration()
    this.set({ identityKey: "suspended" })
  }

  private retireGeneration(): void {
    this.abort.abort()
    this.abort = new AbortController()
    this.orderAbort = new AbortController()
    this.quoteSeq += 1
    this.ordersSeq += 1
    this.portfolioSeq += 1
    this.selectedSeq += 1
    this.submitting = false
    // Answers to these requests can no longer be observed: their outcome is unknown, not failed.
    for (const owner of this.touchedOwners) {
      const attempt = this.attempts.get(owner)
      if (attempt && (attempt.status === "SUBMITTING" || attempt.lookup === "CHECKING" || attempt.refresh === "LOADING")) {
        this.attempts.set(
          owner,
          Object.freeze({
            ...attempt,
            status: attempt.status === "SUBMITTING" ? "UNCONFIRMED" : attempt.status,
            outcomeUnknown: attempt.outcomeUnknown || attempt.status === "SUBMITTING",
            lookup: attempt.lookup === "CHECKING" ? "NOT_CHECKED" : attempt.lookup,
            refresh: "IDLE",
          }),
        )
      }
    }
    this.touchedOwners.clear()
  }

  private enterIdentity(session: NormalizedSession): void {
    const key = sessionIdentityKey(this.clientId, session, this.deploymentId)
    if (key === this.state.identityKey) return
    this.retireGeneration()
    this.rejectionReported = false
    const owner = attemptOwnerKey(this.client?.baseUrl ?? null, session, this.deploymentId)
    this.set({
      generation: this.state.generation + 1,
      identityKey: key,
      session,
      authRejected: false,
      side: "BUY",
      quantityInput: "",
      quantityCheck: parseHumanDecimal("", STOCKS_QUANTITY_SCALE),
      quote: { status: "idle" },
      attempt: owner === null ? null : this.attempts.get(owner) ?? null,
      selectedOrder: null,
      orders: { status: "idle" },
      portfolio: { status: "idle" },
      nowMs: this.now(),
    })
  }

  // ── public catalog ─────────────────────────────────────────────────────

  async loadCatalog(): Promise<void> {
    const client = this.client
    if (client === null) return
    const seq = ++this.catalogSeq
    this.catalogAbort.abort()
    this.catalogAbort = new AbortController()
    const signal = this.catalogAbort.signal
    const current = this.state.catalog
    const previous = current.status === "ready" ? current.catalog : current.status === "idle" ? null : current.previous
    this.set({ catalog: { status: "loading", previous } })
    try {
      const catalog = await client.getCatalog(signal)
      if (seq !== this.catalogSeq || client !== this.client) return
      this.set({ catalog: { status: "ready", catalog } })
      if (catalog.deploymentId !== this.deploymentId) {
        // A different deployment is a different ledger: nothing from the previous one stays on screen.
        this.deploymentId = catalog.deploymentId
        this.enterIdentity(this.state.session)
      }
    } catch (error) {
      if (seq !== this.catalogSeq || client !== this.client) return
      const failure = toFeatureError(error)
      if (failure === null) return
      this.set({ catalog: failure.kind === "NOT_REGISTERED" ? { status: "unavailable", error: failure, previous } : { status: "error", error: failure, previous } })
    }
  }

  // ── authenticated requests ─────────────────────────────────────────────

  private async authed<T>(
    work: (client: GiwaStocksClient, token: string, signal: AbortSignal) => Promise<T>,
    options: { submission?: boolean } = {},
  ): Promise<{ ok: true; value: T } | { ok: false; error: FeatureError } | null> {
    const client = this.client
    const session = this.state.session
    if (client === null || session.status !== "verified" || this.state.authRejected) return { ok: false, error: { kind: "UNAUTHORIZED", status: null, code: "NO_VERIFIED_SESSION" } }
    const generation = this.state.generation
    const signal = options.submission ? this.orderAbort.signal : this.abort.signal
    try {
      const value = await work(client, session.token, signal)
      if (generation !== this.state.generation) return null
      return { ok: true, value }
    } catch (error) {
      if (generation !== this.state.generation) return null
      const failure = toFeatureError(error)
      if (failure === null) return null
      if (failure.kind === "UNAUTHORIZED") this.rejectSession()
      return { ok: false, error: failure }
    }
  }

  private rejectSession(): void {
    if (this.state.authRejected) return
    this.quoteSeq += 1
    this.ordersSeq += 1
    this.portfolioSeq += 1
    this.selectedSeq += 1
    this.set({ authRejected: true, quote: { status: "idle" }, orders: { status: "idle" }, portfolio: { status: "idle" }, selectedOrder: null })
    const session = this.state.session
    if (!this.rejectionReported && session.status === "verified") {
      this.rejectionReported = true
      this.onSessionRejected?.({ walletAddress: session.wallet })
    }
  }

  // ── trade inputs and quote ─────────────────────────────────────────────

  setSide(side: StocksSide): void {
    if (isUnresolved(this.state.attempt) || this.state.attempt?.status === "ACCEPTED" || side === this.state.side) return
    this.quoteSeq += 1
    this.set({ side, quote: { status: "idle" }, attempt: this.clearRejected() })
  }

  setQuantity(input: string): void {
    if (isUnresolved(this.state.attempt) || this.state.attempt?.status === "ACCEPTED") return
    this.quoteSeq += 1
    this.set({ quantityInput: input, quantityCheck: parseHumanDecimal(input, STOCKS_QUANTITY_SCALE), quote: { status: "idle" }, attempt: this.clearRejected() })
  }

  private clearRejected(): OrderAttempt | null {
    const attempt = this.state.attempt
    if (attempt?.status !== "REJECTED") return attempt
    const owner = this.ownerKey()
    if (owner !== null) this.attempts.delete(owner)
    return null
  }

  async requestQuote(): Promise<void> {
    const state = this.state
    // A REJECTED attempt does not block (it is cleared below); unresolved or open attempts do.
    if (tradeBlock(state) !== null || !state.quantityCheck.ok || state.quote.status === "loading" || state.session.status !== "verified") return
    const side = state.side
    const quantity = state.quantityCheck.input
    const baseUnits = state.quantityCheck.baseUnits
    const wallet = state.session.wallet
    const seq = ++this.quoteSeq
    this.set({ quote: { status: "loading", side, quantity }, attempt: this.clearRejected() })
    const result = await this.authed((client, token, signal) => client.createQuote(side, { symbol: "NVDA", quantity }, token, signal))
    if (result === null || seq !== this.quoteSeq) return
    if (!result.ok) {
      this.set({ quote: { status: "error", side, error: result.error } })
      if (result.error.kind === "REFUSED" && result.error.status === 503) void this.loadCatalog()
      return
    }
    const quote = result.value.data
    // A quote is only used for exactly the request that asked for it.
    if (quote.side !== side || quote.symbol !== "NVDA" || quote.quantity !== baseUnits || quote.wallet !== wallet) {
      this.set({ quote: { status: "error", side, error: { kind: "MISMATCH", status: null, code: "QUOTE_DOES_NOT_MATCH_REQUEST" } } })
      return
    }
    const ttl = Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)
    if (!(Number.isFinite(ttl) && ttl > 0)) {
      this.set({ quote: { status: "error", side, error: { kind: "INVALID_RESPONSE", status: null, code: "QUOTE_VALIDITY" } } })
      return
    }
    const receivedAt = this.now()
    // Measured on this device from receipt, never against the device's wall clock.
    this.set({ quote: { status: "ready", quote, deadlineMs: receivedAt + Math.min(ttl, QUOTE_MAX_TTL_MS), observedAt: result.value.observedAt }, nowMs: receivedAt })
  }

  /** Clock tick from the view: moves a ready quote to expired. Never requests a replacement. */
  tick(): void {
    const nowMs = this.now()
    const quote = this.state.quote
    if (quote.status === "ready" && nowMs >= quote.deadlineMs) this.set({ nowMs, quote: { ...quote, status: "expired" } })
    else this.set({ nowMs })
  }

  discardQuote(): void {
    if (this.state.quote.status === "loading") return
    this.quoteSeq += 1
    this.set({ quote: { status: "idle" } })
  }

  // ── orders ──────────────────────────────────────────────────────────────

  async placeOrder(): Promise<void> {
    if (this.submitting) return
    const state = this.state
    if (tradeBlock(state) !== null) return
    const quote = state.quote
    if (quote.status !== "ready") return
    const nowMs = this.now()
    if (nowMs >= quote.deadlineMs) {
      this.set({ nowMs, quote: { ...quote, status: "expired" } })
      return
    }
    const owner = this.ownerKey()
    if (owner === null) return
    const key = this.newKey()
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
      this.set({ attempt: { side: quote.quote.side, quote: quote.quote, body: { quoteId: quote.quote.id, idempotencyKey: "" }, status: "REJECTED", order: null, orderObservedAt: null, error: { kind: "LOCAL", status: null, code: "UNSAFE_IDEMPOTENCY_KEY" }, outcomeUnknown: false, lookup: "NOT_CHECKED", refresh: "IDLE" } })
      return
    }
    const attempt: OrderAttempt = Object.freeze({
      side: quote.quote.side,
      quote: quote.quote,
      body: Object.freeze({ quoteId: quote.quote.id, idempotencyKey: key }),
      status: "SUBMITTING",
      order: null,
      orderObservedAt: null,
      error: null,
      outcomeUnknown: false,
      lookup: "NOT_CHECKED",
      refresh: "IDLE",
    })
    // Another mounted feature (or an earlier mount) may already hold an unresolved attempt for this owner.
    if (isUnresolved(this.attempts.get(owner) ?? null)) {
      this.set({ attempt: this.attempts.get(owner) ?? null })
      return
    }
    this.submitting = true
    this.attempts.set(owner, attempt)
    this.set({ attempt })
    await this.send(owner, attempt)
  }

  /** Resend the unresolved attempt with exactly the same body and idempotency key. */
  async retryOrder(): Promise<void> {
    if (this.submitting) return
    const attempt = this.state.attempt
    const owner = this.ownerKey()
    if (attempt === null || owner === null || (attempt.status !== "UNCONFIRMED" && attempt.status !== "AUTH_REQUIRED") || attempt.lookup === "CHECKING") return
    if (this.syncFromRegistry(owner, attempt)) return
    if (this.state.session.status !== "verified" || this.state.authRejected) return
    const next: OrderAttempt = Object.freeze({ ...attempt, status: "SUBMITTING", error: null, lookup: "NOT_CHECKED" })
    this.submitting = true
    this.attempts.set(owner, next)
    this.set({ attempt: next })
    await this.send(owner, next)
  }

  /** Another mounted feature may have moved this owner's attempt on; show that instead of acting on a stale copy. */
  private syncFromRegistry(owner: string, shown: OrderAttempt): boolean {
    const current = this.attempts.get(owner) ?? null
    if (current === shown) return false
    this.set({ attempt: current })
    return true
  }

  private orderAnswers(order: StocksOrder, attempt: OrderAttempt): boolean {
    const session = this.state.session
    return (
      session.status === "verified" &&
      order.side === attempt.side &&
      order.quoteId === attempt.body.quoteId &&
      order.idempotencyKey === attempt.body.idempotencyKey &&
      order.wallet === session.wallet &&
      order.deploymentId === this.deploymentId &&
      order.symbol === attempt.quote.symbol &&
      order.quantity === attempt.quote.quantity &&
      order.cashAmount === attempt.quote.cashAmount
    )
  }

  private async send(owner: string, attempt: OrderAttempt): Promise<void> {
    const generation = this.state.generation
    this.touchedOwners.add(owner)
    const result = await this.authed((client, token, signal) => client.createOrder(attempt.side, attempt.body, token, signal), { submission: true })
    if (generation === this.state.generation) this.submitting = false
    if (result === null) return
    let next: OrderAttempt
    if (result.ok) {
      const order = result.value.data
      next = this.orderAnswers(order, attempt)
        ? { ...attempt, status: "ACCEPTED", order, orderObservedAt: result.value.observedAt, error: null }
        : { ...attempt, status: "UNCONFIRMED", outcomeUnknown: true, error: { kind: "MISMATCH", status: null, code: "ORDER_DOES_NOT_MATCH_REQUEST" } }
    } else {
      const error = result.error
      // 401 is decided before the service runs: this send was not processed. An earlier unknown send stays unknown.
      if (error.kind === "UNAUTHORIZED") next = { ...attempt, status: "AUTH_REQUIRED", error }
      else if (attempt.outcomeUnknown) {
        next =
          error.kind === "REFUSED" && error.status !== 500 && error.code !== null && RESOLVES_AFTER_UNKNOWN.has(error.code)
            ? { ...attempt, status: "REJECTED", error }
            : { ...attempt, status: "UNCONFIRMED", error }
      } else if (error.kind === "NOT_REGISTERED" || (error.kind === "REFUSED" && error.status !== 500)) next = { ...attempt, status: "REJECTED", error }
      else next = { ...attempt, status: "UNCONFIRMED", outcomeUnknown: true, error }
    }
    next = Object.freeze(next)
    this.attempts.set(owner, next)
    const patch: { -readonly [K in keyof StocksInvestorState]?: StocksInvestorState[K] } = { attempt: next }
    if (next.status === "ACCEPTED") {
      this.quoteSeq += 1
      patch.quote = { status: "idle" }
      patch.quantityInput = ""
      patch.quantityCheck = parseHumanDecimal("", STOCKS_QUANTITY_SCALE)
    } else if (next.status === "REJECTED") {
      const code = next.error?.code
      const quote = this.state.quote
      if (code === "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED" && quote.status === "ready") patch.quote = { ...quote, status: "expired" }
      else if (code === "QUOTE_ALREADY_USED" || code === "QUOTE_NOT_FOUND" || code === "IDEMPOTENCY_CONFLICT" || code === "INSUFFICIENT_AVAILABLE_STOCK") {
        this.quoteSeq += 1
        patch.quote = { status: "idle" }
      }
    }
    this.set(patch)
    if (next.status === "REJECTED" && (next.error?.code === "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED" || next.error?.status === 503)) void this.loadCatalog()
  }

  /** Look for the unresolved attempt in the server's latest orders by its idempotency key. Absence proves nothing. */
  async checkOrder(): Promise<void> {
    const attempt = this.state.attempt
    const owner = this.ownerKey()
    if (this.submitting || attempt === null || owner === null || (attempt.status !== "UNCONFIRMED" && attempt.status !== "AUTH_REQUIRED") || attempt.lookup === "CHECKING") return
    if (this.syncFromRegistry(owner, attempt)) return
    if (this.state.session.status !== "verified" || this.state.authRejected) return
    const checking: OrderAttempt = Object.freeze({ ...attempt, lookup: "CHECKING" })
    this.touchedOwners.add(owner)
    this.attempts.set(owner, checking)
    this.set({ attempt: checking })
    const result = await this.authed((client, token, signal) => client.listOrders(attempt.side, token, signal))
    if (result === null) return
    const current = this.attempts.get(owner)
    if (current !== checking) return
    let next: OrderAttempt
    if (!result.ok) next = { ...checking, lookup: "NOT_CHECKED", error: result.error }
    else {
      const match = result.value.data.find((order) => order.idempotencyKey === attempt.body.idempotencyKey)
      if (match === undefined) next = { ...checking, lookup: "NOT_FOUND" }
      else if (this.orderAnswers(match, attempt)) next = { ...checking, status: "ACCEPTED", order: match, orderObservedAt: result.value.observedAt, error: null, lookup: "NOT_CHECKED" }
      else next = { ...checking, lookup: "NOT_CHECKED", error: { kind: "MISMATCH", status: null, code: "ORDER_DOES_NOT_MATCH_REQUEST" } }
    }
    next = Object.freeze(next)
    this.attempts.set(owner, next)
    this.set({ attempt: next })
  }

  /** Leave a finished attempt (accepted or definitively refused) to start another order. */
  startNewOrder(): void {
    const attempt = this.state.attempt
    if (attempt === null || isUnresolved(attempt)) return
    const owner = this.ownerKey()
    if (owner !== null) this.attempts.delete(owner)
    this.quoteSeq += 1
    this.set({ attempt: null, quote: { status: "idle" }, quantityInput: "", quantityCheck: parseHumanDecimal("", STOCKS_QUANTITY_SCALE) })
  }

  /** Re-read the accepted attempt's order by id. Reading never creates or changes anything. */
  async refreshAttemptOrder(): Promise<void> {
    const attempt = this.state.attempt
    const owner = this.ownerKey()
    if (attempt === null || owner === null || attempt.status !== "ACCEPTED" || attempt.order === null || attempt.refresh === "LOADING") return
    const loading: OrderAttempt = Object.freeze({ ...attempt, refresh: "LOADING" })
    this.touchedOwners.add(owner)
    this.attempts.set(owner, loading)
    this.set({ attempt: loading })
    const order = attempt.order
    const result = await this.authed((client, token, signal) => client.getOrder(order.side, order.id, token, signal))
    if (result === null) return
    const current = this.attempts.get(owner)
    if (current === undefined || current.order?.id !== order.id) return
    let next: OrderAttempt
    if (result.ok && this.sameOrder(result.value.data, order)) {
      const latest = result.value.data
      next = latest.version >= (current.order?.version ?? 0) ? { ...current, order: latest, orderObservedAt: result.value.observedAt, refresh: "IDLE", error: null } : { ...current, refresh: "IDLE" }
    } else {
      next = { ...current, refresh: "IDLE", error: result.ok ? { kind: "MISMATCH", status: null, code: "ORDER_DOES_NOT_MATCH" } : result.error }
    }
    next = Object.freeze(next)
    this.attempts.set(owner, next)
    this.set({ attempt: next })
  }

  private sameOrder(latest: StocksOrder, known: StocksOrder): boolean {
    const session = this.state.session
    return latest.id === known.id && latest.side === known.side && session.status === "verified" && latest.wallet === session.wallet && latest.quoteId === known.quoteId && latest.idempotencyKey === known.idempotencyKey
  }

  // ── lists, selected order, portfolio ──────────────────────────────────

  async loadOrders(): Promise<void> {
    // Orders are only read once the catalog has named the deployment they must belong to.
    if (this.state.session.status !== "verified" || this.state.authRejected || this.client === null || this.deploymentId === null) return
    const seq = ++this.ordersSeq
    const wallet = this.state.session.wallet
    this.set({ orders: { status: "loading" } })
    const [buy, sell] = await Promise.all([
      this.authed((client, token, signal) => client.listOrders("BUY", token, signal)),
      this.authed((client, token, signal) => client.listOrders("SELL", token, signal)),
    ])
    if (buy === null || sell === null || seq !== this.ordersSeq) return
    let deploymentChanged = false
    const sideOrders = (result: NonNullable<typeof buy>): SideOrders => {
      if (!result.ok) return { status: "error", error: result.error }
      const orders = result.value.data
      if (orders.some((order) => order.wallet !== wallet)) return { status: "error", error: { kind: "MISMATCH", status: null, code: "ORDER_WALLET_MISMATCH" } }
      if (orders.some((order) => order.deploymentId !== this.deploymentId)) {
        deploymentChanged = true
        return { status: "error", error: { kind: "MISMATCH", status: null, code: "DEPLOYMENT_CHANGED" } }
      }
      return { status: "ready", orders, observedAt: result.value.observedAt }
    }
    this.set({ orders: { status: "ready", buy: sideOrders(buy), sell: sideOrders(sell) } })
    if (deploymentChanged) void this.loadCatalog()
  }

  selectOrder(order: StocksOrder | null): void {
    this.selectedSeq += 1
    const orders = this.state.orders
    if (order === null || orders.status !== "ready") {
      this.set({ selectedOrder: null })
      return
    }
    const list = order.side === "SELL" ? orders.sell : orders.buy
    if (list.status !== "ready" || !list.orders.includes(order)) return
    this.set({ selectedOrder: { order, observedAt: list.observedAt, refresh: "IDLE", error: null } })
  }

  async refreshSelectedOrder(): Promise<void> {
    const selected = this.state.selectedOrder
    if (selected === null || selected.refresh === "LOADING") return
    const seq = ++this.selectedSeq
    this.set({ selectedOrder: { ...selected, refresh: "LOADING" } })
    const known = selected.order
    const result = await this.authed((client, token, signal) => client.getOrder(known.side, known.id, token, signal))
    if (result === null || seq !== this.selectedSeq) return
    const current = this.state.selectedOrder
    if (current === null || current.order.id !== known.id) return
    if (result.ok && this.sameOrder(result.value.data, known)) {
      const latest = result.value.data
      this.set({ selectedOrder: latest.version >= current.order.version ? { order: latest, observedAt: result.value.observedAt, refresh: "IDLE", error: null } : { ...current, refresh: "IDLE" } })
    } else {
      this.set({ selectedOrder: { ...current, refresh: "IDLE", error: result.ok ? { kind: "MISMATCH", status: null, code: "ORDER_DOES_NOT_MATCH" } : result.error } })
    }
  }

  async loadPortfolio(): Promise<void> {
    if (this.state.session.status !== "verified" || this.state.authRejected || this.client === null || this.deploymentId === null) return
    const seq = ++this.portfolioSeq
    const wallet = this.state.session.wallet
    this.set({ portfolio: { status: "loading" } })
    const result = await this.authed((client, token, signal) => client.getPortfolio(token, signal))
    if (result === null || seq !== this.portfolioSeq) return
    if (!result.ok) {
      this.set({ portfolio: { status: "error", error: result.error } })
      return
    }
    const portfolio = result.value.data
    if (portfolio.holdings.some((holding) => holding.wallet !== wallet)) {
      this.set({ portfolio: { status: "error", error: { kind: "MISMATCH", status: null, code: "HOLDING_WALLET_MISMATCH" } } })
      return
    }
    this.set({ portfolio: { status: "ready", portfolio, observedAt: result.value.observedAt } })
  }
}

export function createStocksInvestorController(options?: StocksInvestorControllerOptions): StocksInvestorController {
  return new StocksInvestorController(options)
}

/** Whether a displayed order still changes on the server (polling stops at a terminal state). */
export function orderIsTerminal(order: StocksOrder): boolean {
  return orderStatusMeaning(order).terminal
}
