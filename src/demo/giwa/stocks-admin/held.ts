// Held payments: direct Buy payments and direct Sell escrows that the server recorded without creating an
// order (GET /api/v1/admin/stocks/held, stocks:read). Read-only; the list pages newest first by an opaque cursor.
import { StocksContractError } from "./parse"
import type { StocksAdminError } from "./types"

export const HELD_PATH = "/api/v1/admin/stocks/held"
export const HELD_PAGE_SIZE = 50

export type HeldHold = "TRADING_PAUSED" | "PRICE_UNAVAILABLE" | "BELOW_ONE_UNIT"
export type HeldPayment = {
  readonly id: string
  readonly side: "BUY" | "SELL"
  readonly wallet: string
  /** Cash base units (BUY only). */
  readonly cashAmount: string | null
  /** Stock quantity base units (SELL only). */
  readonly quantity: string | null
  readonly txHash: string
  readonly hold: HeldHold | null
  readonly reason: string
  readonly status: string
  readonly createdAt: string
}
export type HeldPage = { readonly items: readonly HeldPayment[]; readonly nextCursor: string | null }

export const HOLD_LABEL: Record<HeldHold, string> = {
  TRADING_PAUSED: "Trading was paused",
  PRICE_UNAVAILABLE: "No live price was available",
  BELOW_ONE_UNIT: "Too small for one whole unit",
}

export const HELD_REASON_LABEL: Readonly<Record<string, string>> = {
  UNIDENTIFIED_ORDER: "No order exists for its order key",
  UNATTRIBUTED_TRANSFER: "Plain transfer without an order key",
}

export function heldPath(cursor: string | null, limit: number = HELD_PAGE_SIZE): string {
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor !== null) query.set("cursor", cursor)
  return `${HELD_PATH}?${query.toString()}`
}

const UNSIGNED = /^(0|[1-9]\d*)$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const WALLET = /^0x[0-9a-fA-F]{40}$/
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/
const HOLDS: readonly string[] = ["TRADING_PAUSED", "PRICE_UNAVAILABLE", "BELOW_ONE_UNIT"]

function fail(path: string): never {
  throw new StocksContractError(path)
}

function text(value: unknown, pattern: RegExp, path: string): string {
  return typeof value === "string" && pattern.test(value) ? value : fail(path)
}

/** Strict: a response that does not match the contract is rejected whole. */
export function parseHeldPage(data: unknown): HeldPage {
  if (data === null || typeof data !== "object" || Array.isArray(data)) fail("$.data")
  const root = data as Record<string, unknown>
  if (!Array.isArray(root.items)) fail("$.data.items")
  const nextCursor = root.nextCursor === null ? null : text(root.nextCursor, CURSOR, "$.data.nextCursor")
  const items = (root.items as unknown[]).map((raw, index): HeldPayment => {
    const path = `$.data.items[${index}]`
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(path)
    const row = raw as Record<string, unknown>
    const side = row.side === "BUY" || row.side === "SELL" ? row.side : fail(`${path}.side`)
    const cashAmount = side === "BUY" ? text(row.cashAmount, UNSIGNED, `${path}.cashAmount`) : row.cashAmount === null ? null : fail(`${path}.cashAmount`)
    const quantity = side === "SELL" ? text(row.quantity, UNSIGNED, `${path}.quantity`) : row.quantity === null ? null : fail(`${path}.quantity`)
    const hold = row.hold === null ? null : typeof row.hold === "string" && HOLDS.includes(row.hold) ? (row.hold as HeldHold) : fail(`${path}.hold`)
    const createdAt = typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : fail(`${path}.createdAt`)
    const id = typeof row.id === "string" && row.id.length > 0 && row.id.length <= 200 ? row.id : fail(`${path}.id`)
    return {
      id,
      side,
      wallet: text(row.wallet, WALLET, `${path}.wallet`),
      cashAmount,
      quantity,
      txHash: text(row.txHash, HASH, `${path}.txHash`),
      hold,
      reason: text(row.reason, CODE, `${path}.reason`),
      status: text(row.status, CODE, `${path}.status`),
      createdAt,
    }
  })
  return { items, nextCursor }
}

// A small reducer so the view stays a pure function of state (rendered directly by tests).
export type HeldState = {
  readonly phase: "idle" | "loading" | "ready" | "error"
  readonly items: readonly HeldPayment[]
  readonly nextCursor: string | null
  /** A failed first page (whole view) or a failed older page (`appendError`). */
  readonly error: StocksAdminError | null
  readonly appendError: StocksAdminError | null
  readonly appending: boolean
  readonly loadedAt: number | null
}

export type HeldAction =
  | { readonly type: "start"; readonly append: boolean }
  | { readonly type: "loaded"; readonly page: HeldPage; readonly append: boolean; readonly at: number }
  | { readonly type: "failed"; readonly error: StocksAdminError; readonly append: boolean }

export const HELD_INITIAL: HeldState = { phase: "idle", items: [], nextCursor: null, error: null, appendError: null, appending: false, loadedAt: null }

export function heldReducer(state: HeldState, action: HeldAction): HeldState {
  if (action.type === "start") {
    return action.append ? { ...state, appending: true, appendError: null } : { ...HELD_INITIAL, phase: "loading" }
  }
  if (action.type === "loaded") {
    // An older page is appended once; rows are never duplicated across pages (keyset cursor on the server).
    const items = action.append ? [...state.items, ...action.page.items.filter((item) => !state.items.some((known) => known.id === item.id && known.side === item.side))] : action.page.items
    return { phase: "ready", items, nextCursor: action.page.nextCursor, error: null, appendError: null, appending: false, loadedAt: action.append ? state.loadedAt : action.at }
  }
  return action.append ? { ...state, appending: false, appendError: action.error } : { ...HELD_INITIAL, phase: "error", error: action.error }
}
