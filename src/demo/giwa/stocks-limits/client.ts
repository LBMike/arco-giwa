// Transport for the trading limits panel. Reads go through the admin console's GET client. A change is a PUT of exactly
// {enabled, dailyCashLimit, expectedVersion, idempotencyKey, reason} with the host's SIWE Bearer only: no operator id,
// role header, legacy operator token, cookie or stored credential. The server decides permission.
import { normalizeApiBase } from "../api-base"
import { stocksAdminGet, type StocksAdminResult } from "../stocks-admin/client"
import { parseEnvelope } from "../stocks-admin/parse"
import type { StocksAdminError, StocksAdminErrorKind, StocksAdminFetch } from "../stocks-admin/types"
import { HISTORY_LIMIT, parseLimitChange, parseLimitHistory, parseLimitsRead } from "./parse"
import type { TradingLimitChange, TradingLimitCommand, TradingLimitHistory, TradingLimitsRead, TradingSide } from "./types"

export const LIMITS_PATH = "/api/v1/admin/stocks/limits"
export const LIMITS_HISTORY_PATH = `${LIMITS_PATH}/history?limit=${HISTORY_LIMIT}`

export function limitPath(symbol: string, side: TradingSide): string {
  if (!/^[A-Z]{1,10}$/.test(symbol)) throw new RangeError("symbol")
  return `${LIMITS_PATH}/${symbol}/${side}`
}

type Common = { readonly apiBase: string; readonly accessToken: string | null; readonly signal: AbortSignal; readonly fetch?: StocksAdminFetch }

export function readTradingLimits(options: Common): Promise<StocksAdminResult<TradingLimitsRead>> {
  return stocksAdminGet({ ...options, path: LIMITS_PATH, parse: parseLimitsRead })
}

export function readTradingLimitHistory(options: Common): Promise<StocksAdminResult<TradingLimitHistory>> {
  return stocksAdminGet({ ...options, path: LIMITS_HISTORY_PATH, parse: (data) => parseLimitHistory(data, HISTORY_LIMIT) })
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const defaultFetch: StocksAdminFetch = (url, init) => globalThis.fetch(url, init)

function failure(kind: StocksAdminErrorKind, status: number | null = null, code: string | null = null): { ok: false; error: StocksAdminError } {
  return { ok: false, error: { kind, status, code } }
}

/**
 * Sends one change exactly once. Only a verified 2xx proves the change's record; a missing, failed or invalid answer does
 * not prove that nothing was recorded (the caller offers a retry with the same key, which the server replays).
 */
export async function sendTradingLimitChange(
  options: Common & { readonly symbol: string; readonly side: TradingSide; readonly command: TradingLimitCommand },
): Promise<StocksAdminResult<TradingLimitChange>> {
  const { signal, command, symbol, side } = options
  const apiBase = normalizeApiBase(options.apiBase)
  if (apiBase === null) return failure("configuration")
  if (!options.accessToken) return failure("unauthenticated")
  // Exactly the five accepted fields, in a fixed order; nothing identifies the operator except the Bearer session.
  const body = JSON.stringify({
    enabled: command.enabled,
    dailyCashLimit: command.dailyCashLimit,
    expectedVersion: command.expectedVersion,
    idempotencyKey: command.idempotencyKey,
    reason: command.reason,
  })
  let status: number | null = null
  try {
    const response = await (options.fetch ?? defaultFetch)(`${apiBase}${limitPath(symbol, side)}`, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${options.accessToken}` },
      body,
      credentials: "omit",
      cache: "no-store",
      // A redirect would re-send the change elsewhere; it fails instead (an unknown outcome, never a refusal).
      redirect: "error",
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
        return { ok: true, data: parseLimitChange(envelope.data, { symbol, side, command }), meta: envelope.meta }
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

/** Fresh key for a new change: 8–128 of [a-zA-Z0-9:_-]. A retry reuses the frozen key instead. */
export function newLimitIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return `limit-${cryptoApi.randomUUID()}`
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  return `limit-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
