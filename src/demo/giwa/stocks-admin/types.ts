// Types for the read-only GIWA Stocks operator console. DTOs mirror what
// server/src/stocks/{plugin,repository,reconciliation}.ts actually return; only the
// fields the console renders are typed, extra server fields are ignored.

export type StocksAdminSection = "overview" | "orders" | "reconciliation" | "audit"

export type StocksAdminSession = {
  /** Stable identity of the host's SIWE operator session. A different id resets all data. */
  readonly id: string
  /** Short-lived SIWE Bearer token issued by /api/v1/auth/verify. Rotating it keeps data. */
  readonly accessToken: string
}

export type StocksAdminResponse = { readonly status: number; text(): Promise<string> }
export type StocksAdminFetch = (url: string, init: RequestInit) => Promise<StocksAdminResponse>

export type GiwaStocksAdminFeatureProps = {
  /** API origin, e.g. ARCO_API_BASE. */
  readonly apiBase: string
  /** Host-owned SIWE session; null renders the signed-out state and sends no request. */
  readonly session: StocksAdminSession | null
  /** Host-known deployment switch key. A different value resets all data. */
  readonly deploymentKey?: string
  /** Transport injection (tests, fixtures). Defaults to the global fetch. */
  readonly fetch?: StocksAdminFetch
  /** Clock for "loaded at" / elapsed labels. Defaults to Date.now. */
  readonly now?: () => number
  readonly initialSection?: StocksAdminSection
  /** Controlled section: a host navigation owns it, and the feature's own section tabs are not shown. */
  readonly section?: StocksAdminSection
  /** Told when the feature itself moves to another section ("Open detail" opens Orders). */
  readonly onSectionChange?: (section: StocksAdminSection) => void
  /** Optional host hook shown as a button on the signed-out and 401 states. */
  readonly onSignInRequired?: () => void
}

/** Envelope fields every successful Stocks response carries (contracts.ts PROFILE + observedAt). */
export type StocksEnvelopeMeta = {
  readonly profile: string
  readonly valuePolicy: string
  readonly brokerMode: string
  readonly priceSource: string
  readonly chainId: number
  /** Server response time — not an assertion that chain data is current. */
  readonly observedAt: string
}

export type OrderSide = "BUY" | "SELL"

export type OverviewRow = {
  readonly side: OrderSide
  readonly state: string
  readonly count: string
  /** Server-side SUM of this state's cashAmount, cash base units. */
  readonly cashAmount: string
}

export type OrderRow = {
  readonly id: string
  readonly side: OrderSide
  readonly state: string
  readonly symbol: string
  /** Stock quantity base units (scale 9). */
  readonly quantity: string
  /** Test cash base units (scale 6). */
  readonly cashAmount: string
  readonly wallet: string
  readonly orderKey: string
  readonly deploymentId: string
  readonly deploymentDigest: string
  readonly version: number
  readonly quoteExpiresAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type ProofSummary = {
  readonly blockNumber: string | null
  readonly blockHash: string | null
  readonly evidenceDigest: string | null
}

export type FundingRow = {
  readonly id: string
  readonly orderId: string | null
  readonly payer: string
  readonly amount: string
  readonly status: string
  readonly reason: string
  readonly txHash: string
  readonly proof: ProofSummary
  readonly createdAt: string
}

export type OperationRow = {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly txHash: string | null
  readonly createdAt: string
  /** BUY detail only (the SELL query does not select it). */
  readonly leaseUntil: string | null
}

export type AuditValue = string | number | boolean | null

export type AuditRow = {
  readonly id: string
  readonly subject: string
  readonly action: string
  /** Flattened primitive detail fields; nested values are compact JSON strings. */
  readonly detail: ReadonlyArray<readonly [string, AuditValue]>
  readonly createdAt: string
}

export type HoldingRow = {
  readonly orderId: string
  readonly wallet: string
  readonly symbol: string
  readonly quantity: string
  readonly txHash: string
  readonly blockHash: string
  readonly blockNumber: string
  readonly createdAt: string
}

export type CustodyRow = {
  readonly id: string
  readonly escrowId: string
  readonly orderId: string | null
  readonly payer: string
  readonly quantity: string
  readonly reason: string
  readonly status: string
  readonly txHash: string
  readonly proof: ProofSummary
  readonly createdAt: string
}

export type CashReservationRow = {
  readonly orderId: string
  readonly scopeKey: string
  readonly amount: string
  readonly status: string
  readonly createdAt: string
}

export type BuyOrderDetail = {
  readonly side: "BUY"
  readonly order: OrderRow
  readonly funding: readonly FundingRow[]
  readonly operations: readonly OperationRow[]
  readonly audit: readonly AuditRow[]
  readonly holdings: readonly HoldingRow[]
}

export type SellOrderDetail = {
  readonly side: "SELL"
  readonly order: OrderRow
  readonly custody: readonly CustodyRow[]
  readonly operations: readonly OperationRow[]
  readonly audit: readonly AuditRow[]
  readonly reservations: readonly CashReservationRow[]
}

export type OrderDetail = BuyOrderDetail | SellOrderDetail

export type ReconciliationStatus = "MATCHED_AT_CUTOFF" | "MISMATCH" | "UNAVAILABLE" | "INCOMPLETE"

export type ReconciliationCutoff = {
  readonly deploymentDigest: string
  readonly throughBlock: string
  readonly blockHash: string
  /** Observer coverage time (not the response time). */
  readonly observedAt: string
}

export type ReconciliationSnapshot = {
  readonly blockNumber: string
  readonly blockHash: string
  /** Block timestamp in seconds, decimal string. */
  readonly blockTimestamp: string | null
  readonly cashBalance: string
  readonly stockSupply: string
  readonly escrowBalance: string
  readonly walletBalances: ReadonlyArray<readonly [string, string]>
}

export type ReconciliationDifference = {
  readonly asset: string
  readonly wallet: string | null
  readonly expected: string
  /** null when the finalized snapshot returned no value for this wallet. */
  readonly actual: string | null
}

export type PendingItem = { readonly kind: string; readonly id: string; readonly status: string }

export type CurrentLiabilities = {
  readonly cashBalance: string
  readonly liabilities: string
  readonly sellReserved: string
}

export type Reconciliation = {
  readonly status: ReconciliationStatus
  readonly reason: string | null
  readonly cutoff: ReconciliationCutoff | null
  readonly snapshot: ReconciliationSnapshot | null
  readonly differences: readonly ReconciliationDifference[]
  readonly pending: readonly PendingItem[]
  readonly currentLiabilities: CurrentLiabilities | null
}

export type StocksAdminErrorKind =
  | "configuration" // the API base is not a valid absolute http(s) base; nothing was sent
  | "unauthenticated" // no session token on the client; nothing was sent
  | "unauthorized" // 401
  | "forbidden" // 403
  | "disabled" // 404 without a Stocks error code: the Stocks routes are not registered
  | "not_found" // 404 ORDER_NOT_FOUND
  | "server" // 5xx
  | "request" // other non-2xx
  | "network"
  | "invalid" // response does not match the contract
  | "aborted"

export type StocksAdminError = {
  readonly kind: StocksAdminErrorKind
  readonly status: number | null
  /** Server error code when it is a plain UPPER_SNAKE identifier; never raw body text. */
  readonly code: string | null
}

export type Loaded<T> = { readonly data: T; readonly meta: StocksEnvelopeMeta; readonly loadedAt: number }

export type ResourcePhase = "idle" | "loading" | "ready" | "error"

export type ResourceState<T> = {
  readonly phase: ResourcePhase
  /** Last successful value for the current scope and access; kept (and labelled) on refresh failure. */
  readonly value: Loaded<T> | null
  readonly error: StocksAdminError | null
}

export type DetailState = ResourceState<OrderDetail> & { readonly orderId: string | null }

/** Wallet submission journal status of one stage (server `stocks-submission-diagnostics`). Historical, never permission. */
export type SubmissionStatus = "REQUEST_MAY_START" | "UNKNOWN" | "SUBMITTED" | "CONFIRMED" | "REVERTED"

/** The server's trusted receipt check of the recorded hash. Not mint, burn or payout completion. */
export type SubmissionReceipt = {
  readonly status: "CONFIRMED" | "REVERTED"
  readonly blockNumber: string
  readonly blockHash: string
  /** When the server recorded the verified receipt. */
  readonly verifiedAt: string
}

export type SubmissionStage = {
  readonly claimId: string
  readonly stage: "APPROVAL" | "TRANSFER"
  readonly transactionDigest: string
  readonly status: SubmissionStatus
  /** Only the hash the server recorded; null when none was recorded. Never entered, guessed or searched here. */
  readonly txHash: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly receipt: SubmissionReceipt | null
}

/** Read-only diagnostic of one order's wallet submissions at one server snapshot. */
export type SubmissionDiagnostics = {
  readonly deploymentId: string
  readonly deploymentDigest: string
  readonly order: {
    readonly id: string
    readonly side: OrderSide
    readonly state: string
    readonly wallet: string
    readonly version: number
    readonly quoteExpiresAt: string
    /** As of the server snapshot (observedAt), not the browser clock. */
    readonly quoteExpired: boolean
  }
  readonly enrollment: "ENROLLED" | "NOT_ENROLLED"
  readonly intentKey: string
  readonly approval: SubmissionStage | null
  readonly transfer: SubmissionStage | null
  readonly readOnly: true
  readonly executionAuthorization: false
  readonly resubmissionAllowed: false
}

/** Diagnostics of the selected order; `side` is the server-verified side of that order's loaded detail. */
export type DiagnosticsState = ResourceState<SubmissionDiagnostics> & { readonly orderId: string | null; readonly side: OrderSide | null }

export type AccessState = "signed_out" | "ok" | "unauthorized" | "forbidden" | "disabled"

export type StocksAdminSnapshot = {
  readonly scopeKey: string
  readonly access: AccessState
  readonly overview: ResourceState<readonly OverviewRow[]>
  readonly orders: ResourceState<readonly OrderRow[]>
  readonly reconciliation: ResourceState<Reconciliation>
  readonly audit: ResourceState<readonly AuditRow[]>
  readonly detail: DetailState
  readonly diagnostics: DiagnosticsState
}

export type ListResourceKey = "overview" | "orders" | "reconciliation" | "audit"
