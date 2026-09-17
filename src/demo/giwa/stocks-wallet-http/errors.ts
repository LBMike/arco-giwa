import { StocksWalletError } from "../stocks-wallet/planner"

/**
 * Every code is one the wallet panel already explains (`stocks-wallet-ui/messages.ts`), so a failed read
 * reaches the screen as fixed copy. The controller shows `code` for any StocksWalletError.
 */
export type ExecutionReadCode =
  | "INVALID_CONTEXT"
  | "CONTEXT_CHANGED"
  | "READ_TIMEOUT"
  | "REQUEST_FAILED"
  | "INVALID_RESPONSE"
  | "SESSION_REJECTED"
  | "STALE_RESPONSE"
  | "EXECUTION_NOT_ALLOWED"
  | "EXECUTION_POLICY_EXPIRED"
  | "DEPLOYMENT_NOT_REVIEWED"
  | "DEPLOYMENT_EVIDENCE_EXPIRED"
  | "INVALID_DEPLOYMENT"
  | "UNSUPPORTED_DEPLOYMENT"
  | "INVALID_DEPLOYMENT_ID"
  | "OVERLAPPING_CONTRACTS"
  | "MANIFEST_DIGEST_MISMATCH"

export const EXECUTION_READ_CODES: readonly ExecutionReadCode[] = Object.freeze([
  "INVALID_CONTEXT",
  "CONTEXT_CHANGED",
  "READ_TIMEOUT",
  "REQUEST_FAILED",
  "INVALID_RESPONSE",
  "SESSION_REJECTED",
  "STALE_RESPONSE",
  "EXECUTION_NOT_ALLOWED",
  "EXECUTION_POLICY_EXPIRED",
  "DEPLOYMENT_NOT_REVIEWED",
  "DEPLOYMENT_EVIDENCE_EXPIRED",
  "INVALID_DEPLOYMENT",
  "UNSUPPORTED_DEPLOYMENT",
  "INVALID_DEPLOYMENT_ID",
  "OVERLAPPING_CONTRACTS",
  "MANIFEST_DIGEST_MISMATCH",
])

/** Diagnostic detail made only of fixed words: never a URL, token, header, body or server message. */
export type ExecutionReadReason =
  | "INVALID_REQUEST"
  | "API_BASE_MISMATCH"
  | "ABORTED"
  | "TIMEOUT"
  | "CLOCK"
  | "NETWORK"
  | "REDIRECT"
  | "HTTP_STATUS"
  | "UNAUTHENTICATED"
  | "BODY_TOO_LARGE"
  | "BODY_UNREADABLE"
  | "NOT_JSON"
  | "SHAPE"
  | "PROFILE"
  | "SCOPE"
  | "FUTURE"
  | "STALE"
  | "LEASE_TOO_LONG"
  | "EXPIRED"
  | "EVIDENCE"

export class StocksExecutionReadError extends StocksWalletError {
  declare readonly code: ExecutionReadCode
  constructor(
    code: ExecutionReadCode,
    readonly reason: ExecutionReadReason,
    /** HTTP status when the server answered; `401` lets the wallet controller invalidate its captured session. */
    readonly status: number | null = null,
  ) {
    super(code)
    this.name = "StocksExecutionReadError"
  }
}

export function fail(code: ExecutionReadCode, reason: ExecutionReadReason, status: number | null = null): never {
  throw new StocksExecutionReadError(code, reason, status)
}
