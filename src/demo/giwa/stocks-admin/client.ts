// Read-only transport for the Stocks admin API. Authenticates only with the host's SIWE
// Bearer session; never sends the legacy shared operator header, cookies or any stored credential.
import { normalizeApiBase } from "../api-base"
import { parseAudit, parseEnvelope, parseOrderDetail, parseOrders, parseOverview, parseReconciliation } from "./parse"
import type {
  ListResourceKey,
  StocksAdminError,
  StocksAdminErrorKind,
  StocksAdminFetch,
  StocksEnvelopeMeta,
} from "./types"

/** Server query limits (repository.ts `LIMIT 200`); there is no pagination or total count. */
export const ORDER_LIST_LIMIT = 200
export const AUDIT_LIST_LIMIT = 200

export const STOCKS_ADMIN_PATHS = {
  overview: "/api/v1/admin/stocks/overview",
  orders: "/api/v1/admin/stocks/orders",
  reconciliation: "/api/v1/admin/stocks/reconciliations",
  audit: "/api/v1/admin/stocks/audit",
} as const satisfies Record<ListResourceKey, string>

export function orderDetailPath(orderId: string): string {
  return `/api/v1/admin/stocks/orders/${encodeURIComponent(orderId)}`
}

export const LIST_PARSERS = {
  overview: parseOverview,
  orders: parseOrders,
  reconciliation: parseReconciliation,
  audit: parseAudit,
} as const

export { parseOrderDetail }

export type StocksAdminResult<T> =
  | { readonly ok: true; readonly data: T; readonly meta: StocksEnvelopeMeta }
  | { readonly ok: false; readonly error: StocksAdminError }

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

function failure(kind: StocksAdminErrorKind, status: number | null = null, code: string | null = null): { ok: false; error: StocksAdminError } {
  return { ok: false, error: { kind, status, code } }
}

const defaultFetch: StocksAdminFetch = (url, init) => globalThis.fetch(url, init)

export async function stocksAdminGet<T>(options: {
  readonly apiBase: string
  readonly path: string
  readonly accessToken: string | null
  readonly signal: AbortSignal
  readonly parse: (data: unknown) => T
  readonly fetch?: StocksAdminFetch
}): Promise<StocksAdminResult<T>> {
  const { signal } = options
  // Checked before the token so a misconfigured base never receives an authenticated request.
  const apiBase = normalizeApiBase(options.apiBase)
  if (apiBase === null) return failure("configuration")
  if (!options.accessToken) return failure("unauthenticated")
  let status: number | null = null
  try {
    const response = await (options.fetch ?? defaultFetch)(`${apiBase}${options.path}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${options.accessToken}` },
      credentials: "omit",
      cache: "no-store",
      signal,
    })
    status = response.status
    const body = await response.text()
    if (signal.aborted) return failure("aborted", status)

    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
    const rawCode = json !== null && typeof json === "object" ? (json as Record<string, unknown>).error : undefined
    const code = typeof rawCode === "string" && ERROR_CODE.test(rawCode) ? rawCode : null

    if (Number.isInteger(status) && status >= 200 && status <= 299) {
      try {
        const envelope = parseEnvelope(json)
        return { ok: true, data: options.parse(envelope.data), meta: envelope.meta }
      } catch {
        return failure("invalid", status)
      }
    }
    if (status === 401) return failure("unauthorized", status, code)
    if (status === 403) return failure("forbidden", status, code)
    // Stocks' own 404 carries ORDER_NOT_FOUND; a plain framework 404 means the routes are absent.
    if (status === 404) return failure(code === "ORDER_NOT_FOUND" ? "not_found" : "disabled", status, code)
    if (status >= 500) return failure("server", status, code)
    return failure("request", status, code)
  } catch {
    return failure(signal.aborted ? "aborted" : "network", status)
  }
}
