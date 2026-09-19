// Strict validation of the trading control and runtime status responses. Mirrors the server's whitelists
// (stocks-trading-control/plugin.ts publicState/publicEvent/POST checks, stocks-runtime-status/plugin.ts envelope).
// Anything else is not the reviewed contract: the caller shows none of it.
import { StocksContractError } from "../stocks-admin/parse"
import {
  OBSERVER_STATES,
  PAUSE_REASONS,
  type ObserverStatus,
  type PauseReason,
  type RuntimeStatus,
  type TradingControlChange,
  type TradingControlCommand,
  type TradingControlEvent,
  type TradingControlHistoryPage,
  type TradingControlState,
} from "./types"

export const MAX_VERSION = 2_147_483_647
export const HISTORY_PAGE_LIMIT = 20
const FRESHNESS_LIMIT_MS = 60_000

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
function integer(value: unknown, min: number, max: number, path: string): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fail(path)
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
export function isStrictIso(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function iso(value: unknown, path: string): string {
  return isStrictIso(value) ? value : fail(path)
}
function digest(value: unknown, path: string): string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : fail(path)
}
/** Every successful data object carries both fixed flags; neither grants anything. */
function flags(root: Json, path: string): void {
  if (root.executionAuthorization !== false) fail(`${path}.executionAuthorization`)
  if (root.inFlightMayContinue !== true) fail(`${path}.inFlightMayContinue`)
}

export function parseControlStateValue(value: unknown, path = "data.state"): TradingControlState {
  const row = record(value, path)
  exactKeys(row, ["deploymentDigest", "paused", "version", "updatedAt", "operatorId", "reason"], path)
  const deploymentDigest = digest(row.deploymentDigest, `${path}.deploymentDigest`)
  const paused = bool(row.paused, `${path}.paused`)
  const version = integer(row.version, 0, MAX_VERSION, `${path}.version`)
  if (version === 0) {
    // Never changed: the enabled feature starts closed, with no change metadata.
    if (paused !== true || row.updatedAt !== null || row.operatorId !== null || row.reason !== null) fail(`${path}.initial`)
    return { deploymentDigest, paused, version, updatedAt: null, operatorId: null, reason: null }
  }
  return {
    deploymentDigest,
    paused,
    version,
    updatedAt: iso(row.updatedAt, `${path}.updatedAt`),
    operatorId: boundedText(row.operatorId, 128, `${path}.operatorId`),
    reason: boundedText(row.reason, 500, `${path}.reason`),
  }
}

export function parseControlEvent(value: unknown, path: string): TradingControlEvent {
  const row = record(value, path)
  exactKeys(row, ["id", "deploymentDigest", "version", "previousPaused", "paused", "operatorId", "reason", "createdAt"], path)
  return {
    id: typeof row.id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(row.id) ? row.id : fail(`${path}.id`),
    deploymentDigest: digest(row.deploymentDigest, `${path}.deploymentDigest`),
    version: integer(row.version, 1, MAX_VERSION, `${path}.version`),
    previousPaused: bool(row.previousPaused, `${path}.previousPaused`),
    paused: bool(row.paused, `${path}.paused`),
    operatorId: boundedText(row.operatorId, 128, `${path}.operatorId`),
    reason: boundedText(row.reason, 500, `${path}.reason`),
    createdAt: iso(row.createdAt, `${path}.createdAt`),
  }
}

/** GET /api/v1/admin/stocks/trading-control data. */
export function parseControlRead(data: unknown): TradingControlState {
  const root = record(data, "data")
  exactKeys(root, ["state", "executionAuthorization", "inFlightMayContinue"], "data")
  flags(root, "data")
  return parseControlStateValue(root.state)
}

/**
 * POST data for exactly the command that was sent. The event must be this command's (version expectedVersion + 1,
 * same paused value and reason); the state is the current observation and may be later than the event.
 */
export function parseControlChange(data: unknown, command: TradingControlCommand): TradingControlChange {
  const root = record(data, "data")
  exactKeys(root, ["state", "change", "replayed", "executionAuthorization", "inFlightMayContinue"], "data")
  flags(root, "data")
  const state = parseControlStateValue(root.state)
  const change = parseControlEvent(root.change, "data.change")
  const replayed = bool(root.replayed, "data.replayed")
  if (state.deploymentDigest !== change.deploymentDigest) fail("data.change.deploymentDigest")
  if (state.version < change.version) fail("data.state.version")
  if (change.version !== command.expectedVersion + 1) fail("data.change.version")
  if (change.paused !== command.paused) fail("data.change.paused")
  if (change.reason !== command.reason) fail("data.change.reason")
  if (state.version === change.version) {
    if (state.paused !== change.paused || state.updatedAt !== change.createdAt || state.operatorId !== change.operatorId || state.reason !== change.reason) fail("data.state")
  }
  return { state, change, replayed }
}

/** GET …/history data for one page requested with `limit` and optional `beforeVersion`. */
export function parseControlHistory(data: unknown, request: { readonly limit: number; readonly beforeVersion: number | null }): TradingControlHistoryPage {
  const root = record(data, "data")
  exactKeys(root, ["items", "nextBeforeVersion", "executionAuthorization", "inFlightMayContinue"], "data")
  flags(root, "data")
  if (!Array.isArray(root.items) || root.items.length > request.limit) fail("data.items")
  const items = root.items.map((item, index) => parseControlEvent(item, `data.items[${index}]`))
  items.forEach((item, index) => {
    if (request.beforeVersion !== null && item.version >= request.beforeVersion) fail(`data.items[${index}].version`)
    if (index > 0 && (item.version >= items[index - 1].version || item.deploymentDigest !== items[0].deploymentDigest)) fail(`data.items[${index}]`)
  })
  const next = root.nextBeforeVersion
  if (next !== null) {
    if (items.length !== request.limit || next !== items[items.length - 1]?.version) fail("data.nextBeforeVersion")
  }
  return { items, nextBeforeVersion: next as number | null }
}

/** Pause reasons exactly as the server derives them, in its fixed order. */
export function expectedPauseReasons(input: {
  readonly runtimeState: RuntimeStatus["runtimeState"]
  readonly autodispatch: boolean
  readonly configuredPause: boolean
  readonly operatorControl: RuntimeStatus["operatorControl"]
  readonly observerStatus: ObserverStatus
}): PauseReason[] {
  return [
    ...(input.runtimeState === "STOPPED" ? (["RUNTIME_STOPPED"] as const) : []),
    ...(!input.autodispatch ? (["AUTODISPATCH_DISABLED"] as const) : []),
    ...(input.configuredPause ? (["CONFIGURED_PAUSE"] as const) : []),
    ...(input.operatorControl?.status === "PAUSED" ? (["OPERATOR_PAUSE"] as const) : []),
    ...(input.operatorControl?.status === "UNAVAILABLE" ? (["OPERATOR_CONTROL_UNAVAILABLE"] as const) : []),
    ...(input.observerStatus !== "CURRENT" ? (["OBSERVER_NOT_CURRENT"] as const) : []),
  ]
}

/** GET /api/v1/admin/stocks/runtime data, checked against the envelope's `observedAt` like the server's adapter. */
export function parseRuntimeStatus(data: unknown, observedAt: string): RuntimeStatus {
  const root = record(data, "data")
  const hasControl = Object.prototype.hasOwnProperty.call(root, "operatorControl")
  exactKeys(
    root,
    [
      "enabled", "runtimeState", "deploymentId", "deploymentDigest", "autodispatch", "configuredPause",
      ...(hasControl ? ["operatorControl"] : []),
      "observerStatus", "lastObservationAt", "lastCurrentAt", "lastCurrentAgeMs", "freshnessLimitMs", "tickInFlight",
      "newOrdersPaused", "pauseReasons", "executionAuthorization",
    ],
    "data",
  )
  if (root.enabled !== true) fail("data.enabled")
  if (root.freshnessLimitMs !== FRESHNESS_LIMIT_MS) fail("data.freshnessLimitMs")
  if (root.executionAuthorization !== false) fail("data.executionAuthorization")
  const observed = iso(observedAt, "$.observedAt")
  const runtimeState = root.runtimeState === "RUNNING" || root.runtimeState === "STOPPED" ? root.runtimeState : fail("data.runtimeState")
  const deploymentId = typeof root.deploymentId === "string" && /^[a-zA-Z0-9:_-]{8,128}$/.test(root.deploymentId) ? root.deploymentId : fail("data.deploymentId")
  const deploymentDigest = digest(root.deploymentDigest, "data.deploymentDigest")
  const autodispatch = bool(root.autodispatch, "data.autodispatch")
  const configuredPause = bool(root.configuredPause, "data.configuredPause")
  const tickInFlight = bool(root.tickInFlight, "data.tickInFlight")
  const newOrdersPaused = bool(root.newOrdersPaused, "data.newOrdersPaused")
  let operatorControl: RuntimeStatus["operatorControl"] = null
  if (hasControl) {
    const control = record(root.operatorControl, "data.operatorControl")
    exactKeys(control, ["status", "version"], "data.operatorControl")
    const status = control.status === "PAUSED" || control.status === "RESUMED" || control.status === "UNAVAILABLE" ? control.status : fail("data.operatorControl.status")
    const version = status === "UNAVAILABLE" ? (control.version === null ? null : fail("data.operatorControl.version")) : integer(control.version, 0, MAX_VERSION, "data.operatorControl.version")
    operatorControl = { status, version }
  }
  const observerStatus = (OBSERVER_STATES as readonly unknown[]).includes(root.observerStatus) ? (root.observerStatus as ObserverStatus) : fail("data.observerStatus")
  const lastObservationAt = root.lastObservationAt === null ? null : iso(root.lastObservationAt, "data.lastObservationAt")
  const lastCurrentAt = root.lastCurrentAt === null ? null : iso(root.lastCurrentAt, "data.lastCurrentAt")
  const age = root.lastCurrentAgeMs
  const lastCurrentAgeMs = age === null ? null : typeof age === "number" && Number.isFinite(age) && age >= 0 ? age : fail("data.lastCurrentAgeMs")
  if (lastCurrentAt === null && lastCurrentAgeMs !== null) fail("data.lastCurrentAgeMs")
  if ((runtimeState === "STOPPED") !== (observerStatus === "STOPPED")) fail("data.observerStatus")
  if (observerStatus === "CURRENT") {
    if (lastCurrentAt === null || lastObservationAt === null || lastCurrentAgeMs === null || lastCurrentAgeMs > FRESHNESS_LIMIT_MS) fail("data.current")
    const elapsed = Date.parse(observed) - Date.parse(lastCurrentAt)
    if (elapsed < 0 || elapsed > FRESHNESS_LIMIT_MS || lastCurrentAgeMs < elapsed || Date.parse(lastObservationAt) < Date.parse(lastCurrentAt) || Date.parse(lastObservationAt) > Date.parse(observed)) fail("data.current")
  }
  const expected = expectedPauseReasons({ runtimeState, autodispatch, configuredPause, operatorControl, observerStatus })
  const reasons = root.pauseReasons
  if (!Array.isArray(reasons) || reasons.length !== expected.length || !reasons.every((reason, index) => reason === expected[index])) fail("data.pauseReasons")
  if (newOrdersPaused !== expected.length > 0) fail("data.newOrdersPaused")
  if (!expected.every((reason) => (PAUSE_REASONS as readonly string[]).includes(reason))) fail("data.pauseReasons")
  return {
    runtimeState,
    deploymentId,
    deploymentDigest,
    autodispatch,
    configuredPause,
    operatorControl,
    observerStatus,
    lastObservationAt,
    lastCurrentAt,
    lastCurrentAgeMs,
    tickInFlight,
    newOrdersPaused,
    pauseReasons: expected,
  }
}

// ---------------------------------------------------------------- the reason the operator types

export const REASON_MAX_LENGTH = 500

export type ReasonCheck = { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly message: string }

/**
 * The server accepts 1–500 UTF-16 code units, already trimmed, without C0/C1 control characters.
 * Leading and trailing whitespace is removed here (the review shows the exact text that will be sent).
 */
export function checkReason(input: string): ReasonCheck {
  const reason = input.trim()
  if (reason.length === 0) return { ok: false, message: "Enter a reason. It is recorded with the change." }
  if (CONTROL_CHARS.test(reason)) return { ok: false, message: "Line breaks, tabs and other control characters are not allowed." }
  if (reason.length > REASON_MAX_LENGTH) return { ok: false, message: `The reason is ${reason.length} characters; the limit is ${REASON_MAX_LENGTH}.` }
  return { ok: true, reason }
}

export const IDEMPOTENCY_KEY = /^[a-zA-Z0-9:_-]{8,128}$/
