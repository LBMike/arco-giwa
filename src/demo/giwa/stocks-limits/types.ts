// Types for the operator trading limits panel. DTOs mirror what server/src/stocks-trading-limits/plugin.ts returns;
// every object is checked with an exact key set (parse.ts).
import type { Loaded, ResourceState, StocksAdminError, StocksAdminFetch, StocksAdminSession, StocksEnvelopeMeta } from "../stocks-admin/types"

export type { Loaded, ResourceState, StocksAdminError, StocksAdminFetch, StocksAdminSession, StocksEnvelopeMeta }

export type TradingSide = "BUY" | "SELL"

/** The stored limit of one (symbol, side). Version 0 is the never-changed default: on, no cap. */
export type TradingLimit = {
  readonly deploymentDigest: string
  readonly symbol: string
  readonly side: TradingSide
  /** Whether the side takes new orders. */
  readonly enabled: boolean
  /** Cash base units (scale 6) all wallets together may trade on this side in one KST day; null means no cap. */
  readonly dailyCashLimit: string | null
  readonly version: number
  readonly updatedAt: string | null
  readonly operatorId: string | null
  readonly reason: string | null
}

/** A limit with the cash base units its side has already taken today. */
export type TradingLimitRow = TradingLimit & { readonly usedToday: string }

/** The day a cap counts: 00:00 to 24:00 in Asia/Seoul. */
export type TradingLimitWindow = { readonly start: string; readonly resetsAt: string; readonly timeZone: "Asia/Seoul" }

export type TradingLimitsRead = { readonly items: readonly TradingLimitRow[]; readonly window: TradingLimitWindow }

/** Exactly the five fields the server accepts. */
export type TradingLimitCommand = {
  readonly enabled: boolean
  readonly dailyCashLimit: string | null
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly reason: string
}

/** One immutable change record. */
export type TradingLimitEvent = {
  readonly id: string
  readonly deploymentDigest: string
  readonly symbol: string
  readonly side: TradingSide
  readonly version: number
  readonly previousEnabled: boolean
  readonly previousDailyCashLimit: string | null
  readonly enabled: boolean
  readonly dailyCashLimit: string | null
  readonly operatorId: string
  readonly reason: string
  readonly createdAt: string
}

/** PUT result: `state` is the current observation; `change` is this command's own event (an earlier one when replayed). */
export type TradingLimitChange = { readonly state: TradingLimit; readonly change: TradingLimitEvent; readonly replayed: boolean }

export type TradingLimitHistory = { readonly items: readonly TradingLimitEvent[] }

export type StocksLimitsPanelProps = {
  /** API origin, e.g. ARCO_API_BASE. */
  readonly apiBase: string
  /** The host's SIWE operator session; null sends nothing. */
  readonly session: StocksAdminSession | null
  /** The server's stocks:control answer for this session. Without it the panel is read only (the server checks again). */
  readonly canControl: boolean
  readonly fetch?: StocksAdminFetch
  readonly now?: () => number
  readonly onSignInRequired?: () => void
  /** Tests inject a fixed key; defaults to a random one per new change. A retry reuses the frozen key. */
  readonly newIdempotencyKey?: () => string
  /** After this long without an answer a change is treated as unknown (it may have been recorded). */
  readonly commandTimeoutMs?: number
}
