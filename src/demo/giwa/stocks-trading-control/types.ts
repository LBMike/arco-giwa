// Types for the operator trading control panel (003F). DTOs mirror what server/src/stocks-trading-control/plugin.ts and
// server/src/stocks-runtime-status/plugin.ts actually return; every object is checked with an exact key set.
import type { Loaded, ResourceState, StocksAdminError, StocksAdminFetch, StocksAdminSession, StocksEnvelopeMeta } from "../stocks-admin/types"

export type { Loaded, ResourceState, StocksAdminError, StocksAdminFetch, StocksAdminSession, StocksEnvelopeMeta }

/** The persisted manual admission gate (database). Not the aggregate runtime pause. */
export type TradingControlState = {
  readonly deploymentDigest: string
  readonly paused: boolean
  readonly version: number
  /** Null only for the initial, never-changed state (version 0). */
  readonly updatedAt: string | null
  readonly operatorId: string | null
  readonly reason: string | null
}

/** One immutable audit event. */
export type TradingControlEvent = {
  readonly id: string
  readonly deploymentDigest: string
  readonly version: number
  readonly previousPaused: boolean
  readonly paused: boolean
  readonly operatorId: string
  readonly reason: string
  readonly createdAt: string
}

/** Exactly the four fields the server accepts. */
export type TradingControlCommand = {
  readonly paused: boolean
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly reason: string
}

/** POST result: `state` is the current observation; `change` is this command's own event (maybe an older replay). */
export type TradingControlChange = {
  readonly state: TradingControlState
  readonly change: TradingControlEvent
  readonly replayed: boolean
}

export type TradingControlHistoryPage = {
  readonly items: readonly TradingControlEvent[]
  readonly nextBeforeVersion: number | null
}

export const PAUSE_REASONS = ["RUNTIME_STOPPED", "AUTODISPATCH_DISABLED", "CONFIGURED_PAUSE", "OPERATOR_PAUSE", "OPERATOR_CONTROL_UNAVAILABLE", "OBSERVER_NOT_CURRENT"] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

export const OBSERVER_STATES = ["STARTING", "CURRENT", "STALE", "CATCHING_UP", "WAITING_PROJECTION", "BUSY", "UNAVAILABLE_OR_REVIEW_REQUIRED", "STOPPED"] as const
export type ObserverStatus = (typeof OBSERVER_STATES)[number]

/** Process-local runtime diagnostic. Never permission and never the database state. */
export type RuntimeStatus = {
  readonly runtimeState: "RUNNING" | "STOPPED"
  readonly deploymentId: string
  readonly deploymentDigest: string
  readonly autodispatch: boolean
  readonly configuredPause: boolean
  /** Absent when the server runs without operator controls. Cached for at most 5 s by this process. */
  readonly operatorControl: { readonly status: "PAUSED" | "RESUMED" | "UNAVAILABLE"; readonly version: number | null } | null
  readonly observerStatus: ObserverStatus
  readonly lastObservationAt: string | null
  readonly lastCurrentAt: string | null
  readonly lastCurrentAgeMs: number | null
  readonly tickInFlight: boolean
  readonly newOrdersPaused: boolean
  readonly pauseReasons: readonly PauseReason[]
}

/** GET 401/403 deny the whole panel; a control 404 is shown on the control card (the feature is not enabled). */
export type TradingControlAccess = "signed_out" | "ok" | "unauthorized" | "forbidden"

export type HistoryState = {
  readonly phase: "idle" | "loading" | "ready" | "error"
  /** Pages loaded so far, newest first. Each page is its own observation. */
  readonly items: readonly TradingControlEvent[]
  /** Where the next page starts; null after the last page. */
  readonly nextBeforeVersion: number | null
  /** True once a page ended the list (no older changes). */
  readonly complete: boolean
  readonly observedAt: string | null
  readonly error: StocksAdminError | null
  /** Which request failed: the first page or a "load older" page. */
  readonly failedPage: "first" | "older" | null
  /**
   * The deployment these entries are confirmed for: they matched the shown control state (same digest, and at least as
   * new). Null until then; the view shows entries only for the deployment of the shown control state.
   */
  readonly deploymentDigest: string | null
}

/**
 * One frozen command and what is known about it.
 * - sending: the POST is in flight (buttons disabled).
 * - accepted / replayed: the server returned this command's event.
 * - conflict: 409 CONTROL_VERSION_CONFLICT; nothing was changed by this command. A new command is needed.
 * - rejected: the first attempt was refused (400, 401, 403, 404 or 409 CONTROL_IDEMPOTENCY_CONFLICT); nothing was
 *   changed by this command.
 * - unknown: no verifiable answer (503, 5xx, network, timeout, invalid 200), or a retry of an unknown command was
 *   refused (that refusal says nothing about the earlier attempt). It may or may not have been recorded.
 */
export type CommandPhase = "sending" | "accepted" | "replayed" | "conflict" | "rejected" | "unknown"

export type CommandState = {
  readonly phase: CommandPhase
  readonly command: TradingControlCommand
  /** The state the command was based on, as read (for the review and outcome copy). */
  readonly basis: { readonly paused: boolean; readonly version: number; readonly observedAt: string; readonly deploymentDigest: string }
  /** How many times this exact command (same key) was sent. */
  readonly attempts: number
  readonly result: { readonly change: TradingControlChange; readonly meta: StocksEnvelopeMeta } | null
  readonly error: StocksAdminError | null
  /** True when the unknown outcome came from the client-side timeout. */
  readonly timedOut: boolean
  /** True when a retry of an unknown command was refused: the earlier attempt may still have been recorded. */
  readonly retryRefused: boolean
  /**
   * Order mark taken when the outcome became unknown (only a control read started after it can be trusted for a retry),
   * or when a retry met a version conflict (its unresolved note counts reads from there).
   */
  readonly unknownSeq: number | null
}

/**
 * A command whose result stays unknown after it was discarded or an access denial cleared the panel (same scope only).
 * `sinceSeq` is the order mark from which a control read is known to be taken after it.
 */
export type AbandonedCommand = {
  readonly paused: boolean
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly reason: string
  readonly sinceSeq: number
  /** The deployment the command was reviewed for; only that deployment's history can tell whether it was recorded. */
  readonly deploymentDigest: string
}

export type TradingControlSnapshot = {
  readonly scopeKey: string
  readonly access: TradingControlAccess
  readonly control: ResourceState<TradingControlState>
  readonly runtime: ResourceState<RuntimeStatus>
  readonly history: HistoryState
  readonly command: CommandState | null
  /** Kept across a discard or an access denial in the same scope so the operator knows to check the history. */
  readonly abandoned: AbandonedCommand | null
  /** Order mark of the read (or POST answer) that produced the shown control value; later marks are newer. */
  readonly controlReadSeq: number | null
}

export type GiwaStocksTradingControlFeatureProps = {
  readonly apiBase: string
  /** Host-owned SIWE session (the same one the admin console uses); null sends nothing. */
  readonly session: StocksAdminSession | null
  readonly deploymentKey?: string
  readonly fetch?: StocksAdminFetch
  readonly now?: () => number
  /** Test seam for the idempotency key; defaults to a random UUID-based key. */
  readonly newIdempotencyKey?: () => string
  /** Client-side wait for a POST answer before the outcome is treated as unknown. */
  readonly commandTimeoutMs?: number
  readonly onSignInRequired?: () => void
}
