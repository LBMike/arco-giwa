// Read-only authenticated Stocks execution reads for the browser: deployment evidence, execution policy,
// the accepted order and the public catalog. It holds no session, cache, journal or wallet, performs no
// I/O when created, and never retries. The wallet controller supplies the captured AuthenticatedRead for
// readOrder / readCatalog / readExecutionPolicy; the host calls readDeployment itself.

import type { AuthenticatedRead, ExecutionPolicy, ReviewedDeployment, Side } from "../stocks-wallet/types"
import { fail } from "./errors"
import { createReadTransport, normalizeApiBase, type CapturedRead, type TransportOptions } from "./transport"
import { acceptCatalog, acceptDeployment, acceptOrder, acceptPolicy, type PolicyScope } from "./validate"

export type StocksExecutionReadsOptions = TransportOptions

/** Host request for deployment evidence: the host session captured when the host starts the read. */
export type DeploymentRead = Readonly<{
  apiBase: string
  token: string
  sessionId: string
  signal: AbortSignal
  /** Optional expected manifest digest (for example the accepted order's deploymentDigest). */
  deploymentDigest?: string
}>

/**
 * Accepted evidence plus the local bounds it may be used within. The server dates inside `deployment` are
 * unchanged. `sessionId` and `apiBase` identify the scope the read was made for, so a host can ignore a
 * lease that arrives after its scope changed.
 */
export type DeploymentEvidenceLease = Readonly<{
  deployment: ReviewedDeployment
  sessionId: string
  apiBase: string
  /** Browser wall clock at acceptance: an earlier clock later means the wall clock was stepped back. */
  receivedAt: number
  /** Monotonic time after which the lease is no longer current, whatever the wall clock says. */
  monotonicDeadline: number
}>

const TOKEN = /^[A-Za-z0-9._~-]{1,4096}$/
const ORDER_ID = /^[A-Za-z0-9:_-]{1,128}$/
const DIGEST = /^[a-f0-9]{64}$/

function isSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean" && typeof (value as AbortSignal).addEventListener === "function" && typeof (value as AbortSignal).removeEventListener === "function"
}

export function createStocksExecutionReads(options: StocksExecutionReadsOptions) {
  const transport = createReadTransport(options)
  const base = transport.base
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const issued = new WeakSet<object>()

  /** Synchronous copy of the caller's request, taken before the first await. */
  function capture(request: unknown, authenticated: boolean): CapturedRead & { apiBase: string } {
    if (request === null || typeof request !== "object") fail("INVALID_CONTEXT", "INVALID_REQUEST")
    const row = request as Record<string, unknown>
    const apiBase = normalizeApiBase(row.apiBase)
    if (apiBase === null) fail("INVALID_CONTEXT", "INVALID_REQUEST")
    // A token is only ever sent to the API base this adapter was created for.
    if (apiBase !== base) fail("INVALID_CONTEXT", "API_BASE_MISMATCH")
    if (!isSignal(row.signal)) fail("INVALID_CONTEXT", "INVALID_REQUEST")
    if (!authenticated) return Object.freeze({ apiBase, token: null, sessionId: null, signal: row.signal })
    if (typeof row.token !== "string" || !TOKEN.test(row.token)) fail("INVALID_CONTEXT", "INVALID_REQUEST")
    if (typeof row.sessionId !== "string" || row.sessionId.length === 0 || row.sessionId.length > 256) fail("INVALID_CONTEXT", "INVALID_REQUEST")
    return Object.freeze({ apiBase, token: row.token, sessionId: row.sessionId, signal: row.signal })
  }

  function orderScope(request: unknown): PolicyScope {
    const row = request as Record<string, unknown>
    const side = row.side
    if (side !== "BUY" && side !== "SELL") fail("INVALID_CONTEXT", "INVALID_REQUEST")
    if (typeof row.orderId !== "string" || !ORDER_ID.test(row.orderId)) fail("INVALID_CONTEXT", "INVALID_REQUEST")
    if (typeof row.deploymentDigest !== "string" || !DIGEST.test(row.deploymentDigest)) fail("INVALID_CONTEXT", "INVALID_REQUEST")
    return Object.freeze({ side: side as Side, orderId: row.orderId, deploymentDigest: row.deploymentDigest })
  }

  return Object.freeze({
    /** The one API base requests may use. */
    apiBase: base,

    /** GET /api/v1/stocks/execution/deployment. Non-2xx → DEPLOYMENT_NOT_REVIEWED. */
    async readDeployment(request: DeploymentRead): Promise<DeploymentEvidenceLease> {
      const captured = capture(request, true)
      const expected = (request as { deploymentDigest?: unknown }).deploymentDigest
      if (expected !== undefined && (typeof expected !== "string" || !DIGEST.test(expected))) fail("INVALID_CONTEXT", "INVALID_REQUEST")
      const expectedDigest = expected === undefined ? null : expected
      return transport.get(captured, "/api/v1/stocks/execution/deployment", () => "DEPLOYMENT_NOT_REVIEWED", (json, clock) => {
        const deployment = acceptDeployment(json, clock, expectedDigest)
        const lease: DeploymentEvidenceLease = Object.freeze({
          deployment,
          sessionId: captured.sessionId!,
          apiBase: captured.apiBase,
          receivedAt: clock.wall,
          // Remaining lifetime measured from the effective clock, never from the (possibly earlier) wall clock.
          monotonicDeadline: clock.monotonic + (deployment.validUntil - clock.effective),
        })
        issued.add(lease)
        return lease
      })
    },

    /**
     * The lease's evidence while it is still current, else null. Only leases returned by this adapter count.
     * Hosts call it inside `context()`, so an expired or clock-extended lease stops planning synchronously.
     */
    currentDeployment(lease: DeploymentEvidenceLease | null): ReviewedDeployment | null {
      if (lease === null || typeof lease !== "object" || !issued.has(lease)) return null
      const wall = now()
      const monotonic = monotonicNow()
      if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) return null
      const current = wall >= lease.receivedAt && wall >= lease.deployment.verifiedAt && wall < lease.deployment.validUntil && monotonic < lease.monotonicDeadline
      return current ? lease.deployment : null
    },

    /** WalletPorts.readExecutionPolicy: GET /api/v1/stocks/execution/{side}/{orderId}. Non-2xx → EXECUTION_NOT_ALLOWED. */
    async readExecutionPolicy(request: AuthenticatedRead): Promise<ExecutionPolicy> {
      const captured = capture(request, true)
      const scope = orderScope(request)
      return transport.get(captured, `/api/v1/stocks/execution/${scope.side}/${encodeURIComponent(scope.orderId)}`, () => "EXECUTION_NOT_ALLOWED", (json, clock) => acceptPolicy(json, clock, scope))
    },

    /** WalletPorts.readOrder: the validated original envelope, PROFILE included. Non-2xx → REQUEST_FAILED (a 404 is not proof the order moved on). */
    async readOrder(request: AuthenticatedRead): Promise<unknown> {
      const captured = capture(request, true)
      const scope = orderScope(request)
      const path = `${scope.side === "SELL" ? "/api/v1/stocks/sell-orders" : "/api/v1/stocks/orders"}/${encodeURIComponent(scope.orderId)}`
      return transport.get(captured, path, () => "REQUEST_FAILED", (json, clock) => acceptOrder(json, clock, scope))
    },

    /** WalletPorts.readCatalog: public route, sent without Authorization. Non-2xx → REQUEST_FAILED. */
    async readCatalog(request: AuthenticatedRead): Promise<unknown> {
      const captured = capture(request, false)
      return transport.get(captured, "/api/v1/stocks/catalog", () => "REQUEST_FAILED", (json, clock) => acceptCatalog(json, clock))
    },
  })
}

export type StocksExecutionReads = ReturnType<typeof createStocksExecutionReads>
