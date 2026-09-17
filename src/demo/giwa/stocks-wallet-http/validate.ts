// Acceptance of the four execution-related Stocks reads. Pure: the transport passes the parsed JSON, the
// captured request scope and a clock sample taken after the body was read. Existing validators are
// reused by import (investor order/catalog parsers, the wallet planner's order and deployment checks,
// the submission client's exact-key and PROFILE envelope checks); nothing here relaxes them.

import { parseCatalog, parseOrder as parseInvestorOrder } from "../stocks-investor/validate"
import { freeze, parseOrder as parseWalletOrder, StocksWalletError, validateDeployment } from "../stocks-wallet/planner"
import type { ExecutionPolicy, ReviewedDeployment, Side } from "../stocks-wallet/types"
import { envelope as profileEnvelope, exact } from "../stocks-wallet-submissions/validate"
import { fail, type ExecutionReadCode } from "./errors"

/** Maximum server lease for execution policy and deployment evidence (stocks-execution-v1). */
export const MAX_LEASE_MS = 15_000
/** Maximum age of a response envelope, the same bound the wallet controller applies. */
export const MAX_RESPONSE_AGE_MS = 15_000

/**
 * `wall` is the browser wall clock when the body was accepted. `effective` never runs behind the request's
 * own start plus monotonic elapsed time, so a wall clock stepped back during the request cannot make a
 * lease look younger.
 */
export type ReadClock = Readonly<{ wall: number; effective: number }>

const PROFILE_KEYS = ["profile", "valuePolicy", "brokerMode", "chainId", "priceSource"] as const
const DEPLOYMENT_KEYS = ["status", "evidenceId", "manifestDigest", "manifest", "verifiedAt", "validUntil"]
const MANIFEST_KEYS = [
  "schemaVersion", "redemptionEscrow", "deploymentId", "profile", "chainId", "networkInstance", "checkpointNumber", "checkpointHash",
  "abiDigest", "finalityPolicy", "cashToken", "cashSymbol", "cashScale", "stockToken", "quantityScale", "fundingVault", "mintController",
  "signerAddress", "codeHashes", "restrictedTransfers", "nonUpgradeable",
]
const CONTRACT_KEYS = ["cashToken", "stockToken", "fundingVault", "mintController", "redemptionEscrow"] as const
const POLICY_KEYS = ["allowed", "deploymentDigest", "orderId", "side", "observedAt", "validUntil"]
const CATALOG_KEYS = [...PROFILE_KEYS, "observedAt", "instruments", "cashSymbol", "deploymentId"]
const INSTRUMENT_KEYS = ["symbol", "quantityScale", "price", "priceSource", "orderCapability"]
const DEPLOYMENT_CODES = new Set<string>(["DEPLOYMENT_NOT_REVIEWED", "DEPLOYMENT_EVIDENCE_EXPIRED", "INVALID_DEPLOYMENT", "UNSUPPORTED_DEPLOYMENT", "INVALID_DEPLOYMENT_ID", "OVERLAPPING_CONTRACTS", "MANIFEST_DIGEST_MISMATCH"])

export type PolicyScope = Readonly<{ side: Side; orderId: string; deploymentDigest: string }>

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_RESPONSE", "SHAPE")
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: readonly string[]) {
  try {
    exact(value, [...required])
  } catch {
    fail("INVALID_RESPONSE", "SHAPE")
  }
}

function epochMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail("INVALID_RESPONSE", "SHAPE")
  return value
}

/** Canonical `Date#toISOString()` output only: milliseconds, `Z`, and an exact round trip. */
function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail("INVALID_RESPONSE", "SHAPE")
  const at = Date.parse(value)
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value) fail("INVALID_RESPONSE", "SHAPE")
  return at
}

/** The server's response time must be neither in the future nor older than the controller would accept. */
function fresh(observedAt: number, clock: ReadClock) {
  if (observedAt > clock.wall) fail("STALE_RESPONSE", "FUTURE")
  if (clock.effective - observedAt >= MAX_RESPONSE_AGE_MS) fail("STALE_RESPONSE", "STALE")
}

/** PROFILE five fields + canonical ISO `observedAt` + `data`, exactly. Returns the envelope time. */
function envelope(json: unknown, clock: ReadClock): { root: Record<string, unknown>; observedAt: number } {
  const root = object(json)
  try {
    profileEnvelope(root)
  } catch {
    fail("INVALID_RESPONSE", "PROFILE")
  }
  const observedAt = instant(root.observedAt)
  fresh(observedAt, clock)
  return { root, observedAt }
}

/**
 * A server lease keeps its original dates. It must be at most 15 s long, have started no later than the
 * envelope and the browser clock, and not have ended by the effective clock.
 */
function lease(start: number, end: number, envelopeAt: number, clock: ReadClock, codes: { tooLong: ExecutionReadCode; future: ExecutionReadCode; expired: ExecutionReadCode }) {
  if (!(start < end) || end - start > MAX_LEASE_MS) fail(codes.tooLong, "LEASE_TOO_LONG")
  if (start > envelopeAt || start > clock.wall) fail(codes.future, "FUTURE")
  if (clock.effective >= end) fail(codes.expired, "EXPIRED")
}

/** GET /api/v1/stocks/execution/deployment → the server's ReviewedDeployment, dates unchanged, deep-frozen. */
export function acceptDeployment(json: unknown, clock: ReadClock, expectedDigest: string | null): ReviewedDeployment {
  const { root, observedAt } = envelope(json, clock)
  const data = object(root.data)
  keys(data, DEPLOYMENT_KEYS)
  if (data.status !== "VERIFIED") fail("DEPLOYMENT_NOT_REVIEWED", "EVIDENCE")
  const manifest = object(data.manifest)
  keys(manifest, MANIFEST_KEYS)
  // The server publishes exactly one code hash per contract, keyed by its lower-case address.
  const contracts = CONTRACT_KEYS.map((name) => manifest[name])
  if (!contracts.every((value): value is string => typeof value === "string")) fail("INVALID_DEPLOYMENT", "SHAPE")
  keys(object(manifest.codeHashes), contracts.map((value) => value.toLowerCase()))
  const verifiedAt = epochMs(data.verifiedAt)
  const validUntil = epochMs(data.validUntil)
  lease(verifiedAt, validUntil, observedAt, clock, { tooLong: "DEPLOYMENT_NOT_REVIEWED", future: "DEPLOYMENT_EVIDENCE_EXPIRED", expired: "DEPLOYMENT_EVIDENCE_EXPIRED" })
  const deployment = freeze(data) as unknown as ReviewedDeployment
  try {
    // Same checks the planner applies before any plan: ABI digest, profile, contracts, digest of the manifest.
    validateDeployment(deployment, clock.wall)
  } catch (error) {
    const code = error instanceof StocksWalletError && DEPLOYMENT_CODES.has(error.code) ? (error.code as ExecutionReadCode) : "INVALID_DEPLOYMENT"
    fail(code, "EVIDENCE")
  }
  if (expectedDigest !== null && deployment.manifestDigest !== expectedDigest) fail("MANIFEST_DIGEST_MISMATCH", "SCOPE")
  return deployment
}

/** GET /api/v1/stocks/execution/{side}/{orderId} → ExecutionPolicy for exactly the captured order scope. */
export function acceptPolicy(json: unknown, clock: ReadClock, scope: PolicyScope): ExecutionPolicy {
  const { root, observedAt: envelopeAt } = envelope(json, clock)
  const data = object(root.data)
  keys(data, POLICY_KEYS)
  // There is no allowed=false answer on this API; anything else is not permission.
  if (data.allowed !== true) fail("EXECUTION_NOT_ALLOWED", "SHAPE")
  if (data.deploymentDigest !== scope.deploymentDigest || data.orderId !== scope.orderId || data.side !== scope.side) fail("EXECUTION_NOT_ALLOWED", "SCOPE")
  const observedAt = epochMs(data.observedAt)
  const validUntil = epochMs(data.validUntil)
  lease(observedAt, validUntil, envelopeAt, clock, { tooLong: "EXECUTION_NOT_ALLOWED", future: "STALE_RESPONSE", expired: "EXECUTION_POLICY_EXPIRED" })
  return Object.freeze({ allowed: true, deploymentDigest: scope.deploymentDigest, orderId: scope.orderId, side: scope.side, observedAt, validUntil })
}

/**
 * GET /api/v1/stocks/orders/:id (BUY) or /sell-orders/:id (SELL) → the original envelope WITH its PROFILE
 * fields, deep-frozen. The wallet controller checks PROFILE on this object, so it must not be stripped
 * (the investor client's getOrder() returns `{observedAt, data}` only).
 */
export function acceptOrder(json: unknown, clock: ReadClock, scope: PolicyScope): unknown {
  const { root } = envelope(json, clock)
  try {
    parseInvestorOrder(root.data, scope.side)
    parseWalletOrder({ side: scope.side, order: root.data })
  } catch {
    fail("INVALID_RESPONSE", "SHAPE")
  }
  const data = root.data as Record<string, unknown>
  if (data.id !== scope.orderId || data.deploymentDigest !== scope.deploymentDigest) fail("ORDER_CHANGED", "SCOPE")
  return freeze(root)
}

/** GET /api/v1/stocks/catalog → the public top-level catalog (no data envelope), deep-frozen. Not execution evidence. */
export function acceptCatalog(json: unknown, clock: ReadClock): unknown {
  const root = object(json)
  keys(root, CATALOG_KEYS)
  if (!Array.isArray(root.instruments)) fail("INVALID_RESPONSE", "SHAPE")
  root.instruments.forEach((row) => keys(object(row), INSTRUMENT_KEYS))
  try {
    parseCatalog(root)
  } catch {
    fail("INVALID_RESPONSE", "PROFILE")
  }
  fresh(instant(root.observedAt), clock)
  return freeze(root)
}
