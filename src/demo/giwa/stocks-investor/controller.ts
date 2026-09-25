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
//   • Once any send has an unknown outcome, a later refusal cannot close it: the API
//     does not persist an authoritative rejected idempotency outcome. Preserve the exact
//     key/body until a successful same-key retry or positive order lookup resolves it.
// Order rules
//   • One submission at a time (synchronous guard). No answer, a 500, an unrecognised body or a
//     mismatched order keeps the attempt UNCONFIRMED with its exact body. A retry resends that body.
//   • An expired quote blocks ordering. A new quote is only ever requested by the user.
// Nothing here stores to browser storage, computes money with numbers, or invents results.

import { GiwaStocksRequestError, type GiwaStocksClient } from "./client"
import { formatBaseUnits, parseHumanDecimal, type HumanDecimalCheck } from "./decimal"
import { buyQuantity, priceUnits } from "./pricing"
import { attemptOwnerKey, normalizeSession, sessionIdentityKey, type NormalizedSession } from "./session"
import { orderStatusMeaning } from "./status"
import {
  STOCKS_CASH_SCALE,
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
  /**
   * Customer presentation, Buy: the tUSDC amount as typed in "You pay" ("" when the NVDA quantity was typed instead). The
   * quantity is derived from it at the catalog price, rounded down, so the server's cost for it never exceeds the amount.
   */
  payInput: string
  /**
   * One-click trade: the amount was carried through the sign-in the panel started. The panel continues that trade once it
   * has checked what comes first (the one-time approval, the balance), or clears this. Cleared by any quote request and by
   * any change of side, amount or quantity.
   */
  tradeWhenReady: boolean
  /** The order the one-click trade just placed in this tab: the host starts its one wallet request on its own, once. */
  instantOrderId: string | null
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

/** The catalog's fixed NVDA price (a 6-decimal human decimal), or null before the catalog is read. */
export function catalogPrice(state: Pick<StocksInvestorState, "catalog">): string | null {
  if (state.catalog.status !== "ready") return null
  return state.catalog.catalog.instruments.find((item) => item.symbol === "NVDA")?.price ?? null
}

/**
 * The NVDA quantity (9 decimals, rounded down) that a typed tUSDC amount buys at a price, less the mint fee: "" when either
 * is not a positive decimal, or when the amount buys less than one base unit. Exact BigInt arithmetic only.
 */
export function quantityForCash(cashInput: string, price: string | null): string {
  const unit = priceUnits(price)
  const cash = parseHumanDecimal(cashInput, STOCKS_CASH_SCALE)
  if (unit === null || !cash.ok) return ""
  const quantity = buyQuantity(BigInt(cash.baseUnits), unit)
  return quantity > 0n ? formatBaseUnits(quantity.toString(), STOCKS_QUANTITY_SCALE) : ""
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
  /** The quote request a one-click press armed: its answer places the order. */
  private autoPlaceSeq: number | null = null
  /** The request key of the order a one-click press placed. */
  private instantKey: string | null = null
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
      payInput: "",
      tradeWhenReady: false,
      instantOrderId: null,
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

  private isCurrent(generation: number): boolean {
    return !this.suspended && generation === this.state.generation
  }

  private ownsAttempt(generation: number, owner: string, attempt: OrderAttempt): boolean {
    return this.isCurrent(generation) && this.ownerKey() === owner && this.state.attempt === attempt && this.attempts.get(owner) === attempt
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

  /**
   * That the user THEMSELF started a sign-in from the trade panel, and where. Signing in makes a new identity, and
   * entering one clears the form — quote, order and holdings all belong to an actor, so none of them is carried over.
   * The Buy / Sell segment is not that kind of data: it is the choice the user is stating on screen, so it survives that
   * single step, and so does a quantity the user typed and asked to quote with this very sign-in (one-click "Get quote").
   * Deliberately NOT a copy of the side: the side that is kept is the one chosen when the sign-in lands, so a Buy or Sell
   * pressed after this note still wins. Consumed by the first identity change after it.
   */
  private signInIntent: { identityKey: string; clientId: number | null; deploymentId: string | null; quantity: string | null; pay: string | null } | null = null

  /**
   * The panel's own sign-in press, before the host's sign-in starts. Noting it requests nothing. With `quantity` (the
   * one-click "Get quote" of the customer presentation) that exact typed quantity is kept through the sign-in and quoted
   * once, when the session lands; it is the user's own request on screen, not data of a previous actor.
   */
  noteSignInIntent(quantity: string | null = null, pay: string | null = null): void {
    if (this.state.session.status === "verified") return
    const kept = quantity !== null && parseHumanDecimal(quantity, STOCKS_QUANTITY_SCALE).ok ? quantity : null
    // The typed tUSDC amount stays on screen with the quantity it was converted to.
    const keptPay = kept !== null && pay !== null && parseHumanDecimal(pay, STOCKS_CASH_SCALE).ok ? pay : null
    this.signInIntent = { identityKey: this.state.identityKey, clientId: this.clientId, deploymentId: this.deploymentId, quantity: kept, pay: keptPay }
  }

  /** Leaving the trade view, losing the connected wallet or a failed sign-in drops it: the next one starts on Buy. */
  forgetSignInIntent(): void {
    this.signInIntent = null
  }

  /**
   * The side a new identity starts on: Buy, unless the user started THIS sign-in from the panel, in which case the side
   * they have chosen carries over. The note is consumed by the first identity change after it, and is only honoured for a
   * sign-in (a signed-out → verified step) that is still the same API, the same deployment and the same identity it was
   * made in. A recovered order keeps its own side and hides the form, so recovery wins over the note.
   */
  private honouredIntent(session: NormalizedSession, restored: OrderAttempt | null) {
    const intent = this.signInIntent
    this.signInIntent = null
    if (intent === null || session.status !== "verified" || this.state.session.status === "verified" || restored !== null) return null
    const sameStep = intent.identityKey === this.state.identityKey && intent.clientId === this.clientId && intent.deploymentId === this.deploymentId
    return sameStep ? intent : null
  }

  private enterIdentity(session: NormalizedSession): void {
    const key = sessionIdentityKey(this.clientId, session, this.deploymentId)
    if (key === this.state.identityKey) return
    this.retireGeneration()
    this.rejectionReported = false
    const owner = attemptOwnerKey(this.client?.baseUrl ?? null, session, this.deploymentId)
    const restored = owner === null ? null : this.attempts.get(owner) ?? null
    const intent = this.honouredIntent(session, restored)
    const carried = intent?.quantity ?? ""
    const carriedPay = carried === "" ? "" : intent?.pay ?? ""
    this.set({
      generation: this.state.generation + 1,
      identityKey: key,
      session,
      authRejected: false,
      side: intent ? this.state.side : "BUY",
      quantityInput: carried,
      quantityCheck: parseHumanDecimal(carried, STOCKS_QUANTITY_SCALE),
      payInput: carriedPay,
      tradeWhenReady: carried !== "",
      instantOrderId: null,
      quote: { status: "idle" },
      attempt: restored,
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
    if (seq !== this.catalogSeq || client !== this.client || this.suspended) return
    try {
      const catalog = await client.getCatalog(signal)
      if (seq !== this.catalogSeq || client !== this.client) return
      this.set({ catalog: { status: "ready", catalog } })
      if (seq !== this.catalogSeq || client !== this.client || this.suspended) return
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
      if (!this.isCurrent(generation)) return null
      return { ok: true, value }
    } catch (error) {
      if (!this.isCurrent(generation)) return null
      const failure = toFeatureError(error)
      if (failure === null) return null
      if (failure.kind === "UNAUTHORIZED") this.rejectSession()
      if (!this.isCurrent(generation)) return null
      return { ok: false, error: failure }
    }
  }

  private rejectSession(): void {
    if (this.state.authRejected) return
    const generation = this.state.generation
    const session = this.state.session
    const onRejected = this.onSessionRejected
    this.quoteSeq += 1
    this.ordersSeq += 1
    this.portfolioSeq += 1
    this.selectedSeq += 1
    this.set({ authRejected: true, quote: { status: "idle" }, tradeWhenReady: false, orders: { status: "idle" }, portfolio: { status: "idle" }, selectedOrder: null })
    if (!this.isCurrent(generation)) return
    if (!this.rejectionReported && session.status === "verified") {
      this.rejectionReported = true
      onRejected?.({ walletAddress: session.wallet })
    }
  }

  // ── trade inputs and quote ─────────────────────────────────────────────

  setSide(side: StocksSide): void {
    if (isUnresolved(this.state.attempt) || this.state.attempt?.status === "ACCEPTED" || side === this.state.side) return
    this.quoteSeq += 1
    this.set({ side, quote: { status: "idle" }, payInput: "", tradeWhenReady: false, attempt: this.clearRejected() })
  }

  setQuantity(input: string): void {
    if (isUnresolved(this.state.attempt) || this.state.attempt?.status === "ACCEPTED") return
    this.quoteSeq += 1
    this.set({ quantityInput: input, quantityCheck: parseHumanDecimal(input, STOCKS_QUANTITY_SCALE), quote: { status: "idle" }, payInput: "", tradeWhenReady: false, attempt: this.clearRejected() })
  }

  /**
   * Customer presentation, Buy: the tUSDC amount typed in "You pay". The NVDA quantity is derived from it at the
   * price on screen (`price`, the chart's; else the catalog's), rounded down, as a preview. A Buy with a typed amount is
   * quoted for that exact amount: the server's quote decides the NVDA it buys, and stays the only amount that is paid.
   */
  setPayAmount(input: string, price: string | null = null): void {
    if (isUnresolved(this.state.attempt) || this.state.attempt?.status === "ACCEPTED") return
    const quantity = quantityForCash(input, price ?? catalogPrice(this.state))
    this.quoteSeq += 1
    this.set({ payInput: input, quantityInput: quantity, quantityCheck: parseHumanDecimal(quantity, STOCKS_QUANTITY_SCALE), quote: { status: "idle" }, tradeWhenReady: false, attempt: this.clearRejected() })
  }

  /** The panel checked what the one-click trade carried through sign-in needs first (approval, balance) and stops it there. */
  clearTradeWhenReady(): void {
    if (this.state.tradeWhenReady) this.set({ tradeWhenReady: false })
  }

  /**
   * The one-click Buy or Sell press of the customer presentation: quote the amount on screen and place the order as soon
   * as that quote arrives. Still one request of each kind, from this one press; a later quote is never requested for it.
   */
  tradeNow(): void {
    this.clearTradeWhenReady()
    const quote = this.state.quote
    if (quote.status === "ready" && this.now() < quote.deadlineMs) {
      void this.placeOrder(true)
      return
    }
    void this.requestQuote(true)
  }

  private clearRejected(): OrderAttempt | null {
    const attempt = this.state.attempt
    if (attempt?.status !== "REJECTED") return attempt
    const owner = this.ownerKey()
    if (owner !== null) this.attempts.delete(owner)
    return null
  }

  async requestQuote(autoPlace = false): Promise<void> {
    const state = this.state
    // A REJECTED attempt does not block (it is cleared below); unresolved or open attempts do.
    if (tradeBlock(state) !== null || !state.quantityCheck.ok || state.quote.status === "loading" || state.session.status !== "verified") return
    const generation = state.generation
    const startedAt = this.now()
    const side = state.side
    const quantity = state.quantityCheck.input
    const baseUnits = state.quantityCheck.baseUnits
    const wallet = state.session.wallet
    // A Buy with a typed tUSDC amount is quoted for exactly that amount: the server decides the NVDA it buys at its price.
    const payCheck = side === "BUY" && state.payInput !== "" ? parseHumanDecimal(state.payInput, STOCKS_CASH_SCALE) : null
    const byCash = payCheck !== null && payCheck.ok ? payCheck : null
    const seq = ++this.quoteSeq
    this.autoPlaceSeq = autoPlace ? seq : null
    this.set({ quote: { status: "loading", side, quantity }, tradeWhenReady: false, attempt: this.clearRejected() })
    if (!this.isCurrent(generation) || seq !== this.quoteSeq) return
    const result = await this.authed((client, token, signal) =>
      client.createQuote(side, byCash ? { symbol: "NVDA", cashAmount: byCash.input } : { symbol: "NVDA", quantity }, token, signal),
    )
    if (result === null || !this.isCurrent(generation) || seq !== this.quoteSeq) return
    if (!result.ok) {
      this.set({ quote: { status: "error", side, error: result.error } })
      if (this.isCurrent(generation) && result.error.kind === "REFUSED" && result.error.status === 503) void this.loadCatalog()
      return
    }
    const quote = result.value.data
    // A quote is only used for exactly the request that asked for it.
    if (quote.side !== side || quote.symbol !== "NVDA" || (byCash ? quote.cashAmount !== byCash.baseUnits : quote.quantity !== baseUnits) || quote.wallet !== wallet) {
      this.set({ quote: { status: "error", side, error: { kind: "MISMATCH", status: null, code: "QUOTE_DOES_NOT_MATCH_REQUEST" } } })
      return
    }
    const ttl = Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)
    const observedRemaining = Date.parse(quote.expiresAt) - Date.parse(result.value.observedAt)
    if (!(Number.isFinite(ttl) && ttl > 0 && Number.isFinite(observedRemaining))) {
      this.set({ quote: { status: "error", side, error: { kind: "INVALID_RESPONSE", status: null, code: "QUOTE_VALIDITY" } } })
      return
    }
    const receivedAt = this.now()
    // Start at request dispatch, not receipt: conservatively charge all transit time.
    // Server observation bounds old/cached responses without trusting the device wall clock.
    const deadlineMs = startedAt + Math.max(0, Math.min(ttl, observedRemaining, QUOTE_MAX_TTL_MS))
    this.set({ quote: { status: receivedAt >= deadlineMs ? "expired" : "ready", quote, deadlineMs, observedAt: result.value.observedAt }, nowMs: receivedAt })
    // The one-click trade places the order its own press asked this quote for, and nothing else.
    if (autoPlace && this.autoPlaceSeq === seq) {
      this.autoPlaceSeq = null
      if (this.state.quote.status === "ready") void this.placeOrder(true)
    }
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

  async placeOrder(instant = false): Promise<void> {
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
    const generation = state.generation
    const key = this.newKey()
    if (!this.isCurrent(generation) || this.ownerKey() !== owner || this.state.quote !== quote) return
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
    this.instantKey = instant ? key : null
    this.touchedOwners.add(owner)
    this.attempts.set(owner, attempt)
    this.set({ attempt })
    await this.send(owner, attempt, generation)
  }

  /** Resend the unresolved attempt with exactly the same body and idempotency key. */
  async retryOrder(): Promise<void> {
    if (this.submitting) return
    const attempt = this.state.attempt
    const owner = this.ownerKey()
    if (attempt === null || owner === null || (attempt.status !== "UNCONFIRMED" && attempt.status !== "AUTH_REQUIRED") || attempt.lookup === "CHECKING") return
    if (this.syncFromRegistry(owner, attempt)) return
    if (this.state.session.status !== "verified" || this.state.authRejected) return
    const generation = this.state.generation
    const next: OrderAttempt = Object.freeze({ ...attempt, status: "SUBMITTING", error: null, lookup: "NOT_CHECKED" })
    this.submitting = true
    this.touchedOwners.add(owner)
    this.attempts.set(owner, next)
    this.set({ attempt: next })
    await this.send(owner, next, generation)
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

  private async send(owner: string, attempt: OrderAttempt, generation: number): Promise<void> {
    if (!this.ownsAttempt(generation, owner, attempt)) return
    this.touchedOwners.add(owner)
    const result = await this.authed((client, token, signal) => client.createOrder(attempt.side, attempt.body, token, signal), { submission: true })
    if (!this.ownsAttempt(generation, owner, attempt)) return
    this.submitting = false
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
      else if (attempt.outcomeUnknown) next = { ...attempt, status: "UNCONFIRMED", error }
      else if (error.kind === "NOT_REGISTERED" || (error.kind === "REFUSED" && error.status !== 500)) next = { ...attempt, status: "REJECTED", error }
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
      patch.payInput = ""
      // Only the order this tab's one-click press placed starts its wallet request on its own.
      if (next.order !== null && this.instantKey === next.body.idempotencyKey) patch.instantOrderId = next.order.id
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
    if (this.ownsAttempt(generation, owner, next) && next.status === "REJECTED" && (next.error?.code === "QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED" || next.error?.status === 503)) void this.loadCatalog()
  }

  /** Look for the unresolved attempt in the server's latest orders by its idempotency key. Absence proves nothing. */
  async checkOrder(): Promise<void> {
    const attempt = this.state.attempt
    const owner = this.ownerKey()
    if (this.submitting || attempt === null || owner === null || (attempt.status !== "UNCONFIRMED" && attempt.status !== "AUTH_REQUIRED") || attempt.lookup === "CHECKING") return
    if (this.syncFromRegistry(owner, attempt)) return
    if (this.state.session.status !== "verified" || this.state.authRejected) return
    const generation = this.state.generation
    const checking: OrderAttempt = Object.freeze({ ...attempt, lookup: "CHECKING" })
    this.touchedOwners.add(owner)
    this.attempts.set(owner, checking)
    this.set({ attempt: checking })
    if (!this.ownsAttempt(generation, owner, checking)) return
    const result = await this.authed((client, token, signal) => client.listOrders(attempt.side, token, signal))
    if (result === null || !this.ownsAttempt(generation, owner, checking)) return
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
    this.set({ attempt: null, quote: { status: "idle" }, quantityInput: "", quantityCheck: parseHumanDecimal("", STOCKS_QUANTITY_SCALE), payInput: "", instantOrderId: null })
  }

  /** Re-read the accepted attempt's order by id. Reading never creates or changes anything. */
  async refreshAttemptOrder(): Promise<void> {
    const attempt = this.state.attempt
    const owner = this.ownerKey()
    if (attempt === null || owner === null || attempt.status !== "ACCEPTED" || attempt.order === null || attempt.refresh === "LOADING") return
    if (this.syncFromRegistry(owner, attempt)) return
    const generation = this.state.generation
    const loading: OrderAttempt = Object.freeze({ ...attempt, refresh: "LOADING" })
    this.touchedOwners.add(owner)
    this.attempts.set(owner, loading)
    this.set({ attempt: loading })
    if (!this.ownsAttempt(generation, owner, loading)) return
    const order = attempt.order
    const result = await this.authed((client, token, signal) => client.getOrder(order.side, order.id, token, signal))
    if (result === null || !this.ownsAttempt(generation, owner, loading)) return
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
    const generation = this.state.generation
    const seq = ++this.ordersSeq
    const wallet = this.state.session.wallet
    this.set({ orders: { status: "loading" } })
    if (!this.isCurrent(generation) || seq !== this.ordersSeq) return
    const [buy, sell] = await Promise.all([
      this.authed((client, token, signal) => client.listOrders("BUY", token, signal)),
      this.authed((client, token, signal) => client.listOrders("SELL", token, signal)),
    ])
    if (buy === null || sell === null || !this.isCurrent(generation) || seq !== this.ordersSeq) return
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
    if (this.isCurrent(generation) && deploymentChanged) void this.loadCatalog()
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
    const generation = this.state.generation
    const seq = ++this.selectedSeq
    this.set({ selectedOrder: { ...selected, refresh: "LOADING" } })
    if (!this.isCurrent(generation) || seq !== this.selectedSeq) return
    const known = selected.order
    const result = await this.authed((client, token, signal) => client.getOrder(known.side, known.id, token, signal))
    if (result === null || !this.isCurrent(generation) || seq !== this.selectedSeq) return
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
    const generation = this.state.generation
    const seq = ++this.portfolioSeq
    const wallet = this.state.session.wallet
    this.set({ portfolio: { status: "loading" } })
    if (!this.isCurrent(generation) || seq !== this.portfolioSeq) return
    const result = await this.authed((client, token, signal) => client.getPortfolio(token, signal))
    if (result === null || !this.isCurrent(generation) || seq !== this.portfolioSeq) return
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
