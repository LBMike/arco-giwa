// Strict validation of the trading limits responses, and the amount rules the operator types against. Mirrors the
// server's whitelists (stocks-trading-limits/plugin.ts publicState/publicEvent/PUT checks). Anything else is not the
// reviewed contract: the caller shows none of it.
import { formatBaseUnits } from "../stocks-admin/format"
import { StocksContractError } from "../stocks-admin/parse"
import type { TradingLimit, TradingLimitChange, TradingLimitCommand, TradingLimitEvent, TradingLimitHistory, TradingLimitRow, TradingLimitsRead, TradingSide } from "./types"

export const MAX_VERSION = 2_147_483_647
export const HISTORY_LIMIT = 50
/** tUSDC, the cash token a limit counts, has 6 decimals. */
export const LIMIT_CASH_SCALE = 6
export const LIMIT_CASH_UNIT = "tUSDC"
/** The server accepts caps of 1 to 10^30 base units. */
export const MAX_DAILY_CASH_LIMIT = 10n ** 30n
export const TIME_ZONE = "Asia/Seoul"

type Json = Record<string, unknown>

function fail(path: string): never {
  throw new StocksContractError(path)
}
function record(value: unknown, path: string): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : fail(path)
}
function exactKeys(row: Json, keys: readonly string[], path: string): void {
  const present = Object.keys(row)
  if (present.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(row, key))) fail(`${path}{keys}`)
}
function integer(value: unknown, min: number, path: string): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_VERSION ? value : fail(path)
}
function bool(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : fail(path)
}
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
/** Server `operatorId()` / `reason()`: nonempty, bounded, already trimmed, no C0/C1 control characters. */
function boundedText(value: unknown, max: number, path: string): string {
  return typeof value === "string" && value.length >= 1 && value.length <= max && value.trim() === value && !CONTROL_CHARS.test(value) ? value : fail(path)
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
function iso(value: unknown, path: string): string {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : fail(path)
}
function digest(value: unknown, path: string): string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : fail(path)
}
function symbol(value: unknown, path: string): string {
  return typeof value === "string" && /^[A-Z]{1,10}$/.test(value) ? value : fail(path)
}
function side(value: unknown, path: string): TradingSide {
  return value === "BUY" || value === "SELL" ? value : fail(path)
}
/** Server `validDailyCashLimit`: null, or 1 to 10^30 base units in canonical decimal. */
export function isDailyCashLimit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[1-9]\d{0,30}$/.test(value) && BigInt(value) <= MAX_DAILY_CASH_LIMIT)
}
function cap(value: unknown, path: string): string | null {
  return isDailyCashLimit(value) ? value : fail(path)
}
function unsigned(value: unknown, path: string): string {
  return typeof value === "string" && /^(0|[1-9]\d{0,40})$/.test(value) ? value : fail(path)
}

const STATE_KEYS = ["deploymentDigest", "symbol", "side", "enabled", "dailyCashLimit", "version", "updatedAt", "operatorId", "reason"] as const

function limitState(row: Json, path: string): TradingLimit {
  const version = integer(row.version, 0, `${path}.version`)
  const base = {
    deploymentDigest: digest(row.deploymentDigest, `${path}.deploymentDigest`),
    symbol: symbol(row.symbol, `${path}.symbol`),
    side: side(row.side, `${path}.side`),
    enabled: bool(row.enabled, `${path}.enabled`),
    dailyCashLimit: cap(row.dailyCashLimit, `${path}.dailyCashLimit`),
    version,
  }
  if (version === 0) {
    // The never-changed default: on, no cap, nobody.
    if (base.enabled !== true || base.dailyCashLimit !== null || row.updatedAt !== null || row.operatorId !== null || row.reason !== null) fail(`${path}.initial`)
    return { ...base, updatedAt: null, operatorId: null, reason: null }
  }
  return { ...base, updatedAt: iso(row.updatedAt, `${path}.updatedAt`), operatorId: boundedText(row.operatorId, 128, `${path}.operatorId`), reason: boundedText(row.reason, 500, `${path}.reason`) }
}

export function parseLimitState(data: unknown, path = "data"): TradingLimit {
  const row = record(data, path)
  exactKeys(row, STATE_KEYS, path)
  return limitState(row, path)
}

function limitRow(data: unknown, path: string): TradingLimitRow {
  const row = record(data, path)
  exactKeys(row, [...STATE_KEYS, "usedToday"], path)
  return { ...limitState(row, path), usedToday: unsigned(row.usedToday, `${path}.usedToday`) }
}

/** GET /limits: one row per tradable (symbol, side), both sides of every symbol, one deployment, one KST day. */
export function parseLimitsRead(data: unknown): TradingLimitsRead {
  const root = record(data, "data")
  exactKeys(root, ["items", "window"], "data")
  if (!Array.isArray(root.items) || root.items.length === 0) fail("data.items")
  const items = root.items.map((item, index) => limitRow(item, `data.items[${index}]`))
  const keys = new Set(items.map((item) => `${item.symbol}:${item.side}`))
  if (keys.size !== items.length) fail("data.items{unique}")
  if (!items.every((item) => keys.has(`${item.symbol}:BUY`) && keys.has(`${item.symbol}:SELL`))) fail("data.items{sides}")
  if (!items.every((item) => item.deploymentDigest === items[0].deploymentDigest)) fail("data.items{deployment}")
  const window = record(root.window, "data.window")
  exactKeys(window, ["start", "resetsAt", "timeZone"], "data.window")
  const start = iso(window.start, "data.window.start")
  const resetsAt = iso(window.resetsAt, "data.window.resetsAt")
  if (Date.parse(resetsAt) - Date.parse(start) !== 86_400_000) fail("data.window{day}")
  if (window.timeZone !== TIME_ZONE) fail("data.window.timeZone")
  return { items, window: { start, resetsAt, timeZone: TIME_ZONE } }
}

const EVENT_KEYS = ["id", "deploymentDigest", "symbol", "side", "version", "previousEnabled", "previousDailyCashLimit", "enabled", "dailyCashLimit", "operatorId", "reason", "createdAt"] as const

export function parseLimitEvent(data: unknown, path = "data"): TradingLimitEvent {
  const row = record(data, path)
  exactKeys(row, EVENT_KEYS, path)
  return {
    id: typeof row.id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(row.id) ? row.id : fail(`${path}.id`),
    deploymentDigest: digest(row.deploymentDigest, `${path}.deploymentDigest`),
    symbol: symbol(row.symbol, `${path}.symbol`),
    side: side(row.side, `${path}.side`),
    version: integer(row.version, 1, `${path}.version`),
    previousEnabled: bool(row.previousEnabled, `${path}.previousEnabled`),
    previousDailyCashLimit: cap(row.previousDailyCashLimit, `${path}.previousDailyCashLimit`),
    enabled: bool(row.enabled, `${path}.enabled`),
    dailyCashLimit: cap(row.dailyCashLimit, `${path}.dailyCashLimit`),
    operatorId: boundedText(row.operatorId, 128, `${path}.operatorId`),
    reason: boundedText(row.reason, 500, `${path}.reason`),
    createdAt: iso(row.createdAt, `${path}.createdAt`),
  }
}

/** GET /limits/history: at most the requested number, newest first, one deployment. */
export function parseLimitHistory(data: unknown, limit: number = HISTORY_LIMIT): TradingLimitHistory {
  const root = record(data, "data")
  exactKeys(root, ["items"], "data")
  if (!Array.isArray(root.items) || root.items.length > limit) fail("data.items")
  const items = root.items.map((item, index) => parseLimitEvent(item, `data.items[${index}]`))
  items.forEach((item, index) => {
    if (index === 0) return
    if (item.createdAt > items[index - 1].createdAt) fail(`data.items[${index}].createdAt{order}`)
    if (item.deploymentDigest !== items[0].deploymentDigest) fail(`data.items[${index}].deploymentDigest`)
  })
  return { items }
}

/**
 * PUT result, checked against the request: the event must be this command's (next version, same values and reason), for
 * the same (symbol, side); the state is the current observation and may be later than the event.
 */
export function parseLimitChange(data: unknown, request: { readonly symbol: string; readonly side: TradingSide; readonly command: TradingLimitCommand }): TradingLimitChange {
  const root = record(data, "data")
  exactKeys(root, ["state", "change", "replayed"], "data")
  const state = parseLimitState(root.state, "data.state")
  const change = parseLimitEvent(root.change, "data.change")
  const replayed = bool(root.replayed, "data.replayed")
  const { command } = request
  if (state.symbol !== request.symbol || state.side !== request.side) fail("data.state{target}")
  if (change.symbol !== request.symbol || change.side !== request.side) fail("data.change{target}")
  if (state.deploymentDigest !== change.deploymentDigest) fail("data.state.deploymentDigest")
  if (state.version < change.version) fail("data.state.version")
  if (change.version !== command.expectedVersion + 1) fail("data.change.version")
  if (change.enabled !== command.enabled || change.dailyCashLimit !== command.dailyCashLimit) fail("data.change{values}")
  if (change.reason !== command.reason) fail("data.change.reason")
  if (state.version === change.version) {
    if (state.enabled !== change.enabled || state.dailyCashLimit !== change.dailyCashLimit || state.updatedAt !== change.createdAt || state.operatorId !== change.operatorId || state.reason !== change.reason) fail("data.state")
  }
  return { state, change, replayed }
}

// ---------------------------------------------------------------- the reason recorded with a change

/**
 * The server records a reason with every change (1–500 characters). Operators do not type one: the console sends this
 * fixed text, and the change record itself holds what changed, who changed it and when.
 */
export const LIMIT_CHANGE_REASON = "Changed in the admin console"

// ---------------------------------------------------------------- what the operator types

export type CapCheck = { readonly ok: true; readonly baseUnits: string } | { readonly ok: false; readonly message: string }

/**
 * A daily cap in whole tUSDC with up to 6 decimals: "50000", "50,000" (thousands groups of three) or "1250.5". Zero is
 * refused: a side is stopped by turning it off, not by a zero cap.
 */
export function checkCapInput(input: string): CapCheck {
  const text = input.trim()
  if (text === "") return { ok: false, message: "Enter a daily cap, or choose No cap." }
  const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, "") : text
  const match = /^(\d+)(?:\.(\d+))?$/.exec(plain)
  if (!match) return { ok: false, message: "Use digits with an optional decimal point, for example 50000, 50,000 or 1250.5." }
  const [, whole, fraction = ""] = match
  if (fraction.length > LIMIT_CASH_SCALE) return { ok: false, message: `${LIMIT_CASH_UNIT} has ${LIMIT_CASH_SCALE} decimals; use at most ${LIMIT_CASH_SCALE} digits after the point.` }
  const base = BigInt(whole + fraction.padEnd(LIMIT_CASH_SCALE, "0"))
  if (base === 0n) return { ok: false, message: "A cap must be more than 0. To stop this side, turn it off instead." }
  if (base > MAX_DAILY_CASH_LIMIT) return { ok: false, message: "The cap is larger than the server accepts." }
  return { ok: true, baseUnits: base.toString() }
}

/** The input text for a stored cap: plain decimal, no grouping ("50000", "1250.5"). */
export function capInputText(baseUnits: string): string {
  const padded = baseUnits.padStart(LIMIT_CASH_SCALE + 1, "0")
  const whole = padded.slice(0, padded.length - LIMIT_CASH_SCALE).replace(/^0+(?=\d)/, "")
  const fraction = padded.slice(padded.length - LIMIT_CASH_SCALE).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

/** "50,000 tUSDC" / "No cap". */
export function capText(baseUnits: string | null): string {
  if (baseUnits === null) return "No cap"
  return `${formatBaseUnits(baseUnits, LIMIT_CASH_SCALE) ?? baseUnits} ${LIMIT_CASH_UNIT}`
}

export function cashText(baseUnits: string): string {
  return `${formatBaseUnits(baseUnits, LIMIT_CASH_SCALE) ?? baseUnits} ${LIMIT_CASH_UNIT}`
}

export type LimitStatus = "off" | "cap_reached" | "on"

/** Off refuses every new order of the side; at or past the cap even the smallest order is refused until 00:00 KST. */
export function limitStatus(row: TradingLimitRow): LimitStatus {
  if (!row.enabled) return "off"
  if (row.dailyCashLimit !== null && BigInt(row.usedToday) >= BigInt(row.dailyCashLimit)) return "cap_reached"
  return "on"
}

/** Share of the cap used today, floored to 0.1% ("24.7%"); may pass 100% after a cap is lowered. */
export function usedShare(usedToday: string, dailyCashLimit: string): string {
  const permille = (BigInt(usedToday) * 1000n) / BigInt(dailyCashLimit)
  return `${permille / 10n}.${permille % 10n}%`
}

export function sideWord(value: TradingSide): string {
  return value === "BUY" ? "Buy" : "Sell"
}

export function onWord(enabled: boolean): string {
  return enabled ? "On" : "Off"
}

/** What a change record changed: "On → Off", "Cap No cap → 50,000 tUSDC"; a save without a difference says so. */
export function describeChange(before: { readonly enabled: boolean; readonly dailyCashLimit: string | null }, after: { readonly enabled: boolean; readonly dailyCashLimit: string | null }): string {
  const parts: string[] = []
  if (before.enabled !== after.enabled) parts.push(`${onWord(before.enabled)} → ${onWord(after.enabled)}`)
  if (before.dailyCashLimit !== after.dailyCashLimit) parts.push(`Cap ${capText(before.dailyCashLimit)} → ${capText(after.dailyCashLimit)}`)
  return parts.length > 0 ? parts.join(" · ") : `Saved again without a change (${onWord(after.enabled)} · ${capText(after.dailyCashLimit)})`
}

export function describeEvent(event: TradingLimitEvent): string {
  return describeChange({ enabled: event.previousEnabled, dailyCashLimit: event.previousDailyCashLimit }, event)
}
