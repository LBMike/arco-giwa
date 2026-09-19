// Transport for the operator trading control panel. Reads go through the admin console's GET client. The one
// command is a POST of exactly {paused, expectedVersion, idempotencyKey, reason} with the host's SIWE Bearer only:
// no operator id, role header, legacy operator token, cookie or stored credential. The server decides permission.
import { normalizeApiBase } from "../api-base"
import { stocksAdminGet, type StocksAdminResult } from "../stocks-admin/client"
import { parseEnvelope } from "../stocks-admin/parse"
import type { StocksAdminError, StocksAdminErrorKind, StocksAdminFetch } from "../stocks-admin/types"
import { HISTORY_PAGE_LIMIT, MAX_VERSION, parseControlChange, parseControlHistory, parseControlRead, parseRuntimeStatus } from "./parse"
import type { RuntimeStatus, TradingControlChange, TradingControlCommand, TradingControlHistoryPage, TradingControlState } from "./types"

export const TRADING_CONTROL_PATH = "/api/v1/admin/stocks/trading-control"
export const RUNTIME_STATUS_PATH = "/api/v1/admin/stocks/runtime"

/** Canonical decimal query the server accepts (no signs, zeros-padding or exponents). */
export function historyPath(beforeVersion: number | null, limit: number = HISTORY_PAGE_LIMIT): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit")
  if (beforeVersion !== null && (!Number.isInteger(beforeVersion) || beforeVersion < 1 || beforeVersion > MAX_VERSION)) throw new RangeError("beforeVersion")
  return `${TRADING_CONTROL_PATH}/history?limit=${limit}${beforeVersion === null ? "" : `&beforeVersion=${beforeVersion}`}`
}

type Common = { readonly apiBase: string; readonly accessToken: string | null; readonly signal: AbortSignal; readonly fetch?: StocksAdminFetch }

export function readTradingControl(options: Common): Promise<StocksAdminResult<TradingControlState>> {
  return stocksAdminGet({ ...options, path: TRADING_CONTROL_PATH, parse: parseControlRead })
}

export function readTradingControlHistory(options: Common & { readonly beforeVersion: number | null }): Promise<StocksAdminResult<TradingControlHistoryPage>> {
  const request = { limit: HISTORY_PAGE_LIMIT, beforeVersion: options.beforeVersion }
  return stocksAdminGet({ ...options, path: historyPath(options.beforeVersion), parse: (data) => parseControlHistory(data, request) })
}

export async function readRuntimeStatus(options: Common): Promise<StocksAdminResult<RuntimeStatus>> {
  // The runtime checks need the envelope's observedAt, so parse after the generic envelope check.
  const result = await stocksAdminGet({ ...options, path: RUNTIME_STATUS_PATH, parse: (data) => data })
  if (!result.ok) return result
  try {
    return { ok: true, data: parseRuntimeStatus(result.data, result.meta.observedAt), meta: result.meta }
  } catch {
    return { ok: false, error: { kind: "invalid", status: 200, code: null } }
  }
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const defaultFetch: StocksAdminFetch = (url, init) => globalThis.fetch(url, init)

function failure(kind: StocksAdminErrorKind, status: number | null = null, code: string | null = null): { ok: false; error: StocksAdminError } {
  return { ok: false, error: { kind, status, code } }
}

/**
 * Sends one command exactly once. The caller decides what an error means for the outcome: only a verified 2xx
 * proves the command's event; a missing, failed or invalid answer does not prove that nothing was recorded.
 */
export async function sendTradingControlCommand(options: Common & { readonly command: TradingControlCommand }): Promise<StocksAdminResult<TradingControlChange>> {
  const { signal, command } = options
  const apiBase = normalizeApiBase(options.apiBase)
  if (apiBase === null) return failure("configuration")
  if (!options.accessToken) return failure("unauthenticated")
  // Exactly the four accepted fields, in a fixed order; nothing identifies the operator except the Bearer session.
  const body = JSON.stringify({ paused: command.paused, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, reason: command.reason })
  let status: number | null = null
  try {
    const response = await (options.fetch ?? defaultFetch)(`${apiBase}${TRADING_CONTROL_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${options.accessToken}` },
      body,
      credentials: "omit",
      cache: "no-store",
      signal,
    })
    status = response.status
    const text = await response.text()
    if (signal.aborted) return failure("aborted", status)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    const rawCode = json !== null && typeof json === "object" ? (json as Record<string, unknown>).error : undefined
    const code = typeof rawCode === "string" && ERROR_CODE.test(rawCode) ? rawCode : null
    if (Number.isInteger(status) && status >= 200 && status <= 299) {
      try {
        const envelope = parseEnvelope(json)
        return { ok: true, data: parseControlChange(envelope.data, command), meta: envelope.meta }
      } catch {
        return failure("invalid", status)
      }
    }
    if (status === 401) return failure("unauthorized", status, code)
    if (status === 403) return failure("forbidden", status, code)
    if (status === 404) return failure("disabled", status, code)
    if (status >= 500) return failure("server", status, code)
    return failure("request", status, code)
  } catch {
    return failure(signal.aborted ? "aborted" : "network", status)
  }
}

/** Fresh key for a new command: 8–128 of [a-zA-Z0-9:_-]. A retry reuses the frozen key instead. */
export function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return `tc-${cryptoApi.randomUUID()}`
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  return `tc-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
