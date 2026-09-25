// A direct order's progress: GET /api/v1/stocks/direct/:orderKey. Public (the key is the wallet's own random value);
// no session, no cookies, no cache, no redirects, a bounded body and a deadline, like the investor client.
import { normalizeApiBase } from "../api-base"
import type { StocksDirectStatus, StocksSide } from "../stocks-investor/types"
import { parseDirectStatus, parseEnvelope, parseStocksErrorBody } from "../stocks-investor/validate"
import { isDirectOrderKey, type DirectOrderKey } from "./key"

type FetchLike = (input: string, init: RequestInit) => Promise<Response>
const MAX_BODY_CHARS = 100_000

/** The order's status, or null while the server has not seen the transaction yet (404 DIRECT_ORDER_NOT_FOUND). */
export async function readDirectStatus(options: { apiBase: string; key: DirectOrderKey; side: StocksSide; fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number }): Promise<StocksDirectStatus | null> {
  const base = normalizeApiBase(options.apiBase)
  if (base === null) throw new Error("DIRECT_STATUS_INVALID_BASE")
  if (!isDirectOrderKey(options.key)) throw new Error("DIRECT_STATUS_INVALID_KEY")
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? 10_000)
  try {
    const transport: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const response = await transport(`${base}/api/v1/stocks/direct/${options.key}`, {
      method: "GET", headers: { accept: "application/json" }, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error",
    })
    const raw = await response.text()
    if (raw.length > MAX_BODY_CHARS) throw new Error("DIRECT_STATUS_INVALID_RESPONSE")
    let json: unknown
    try { json = JSON.parse(raw) } catch { throw new Error("DIRECT_STATUS_INVALID_RESPONSE") }
    if (response.status === 404 && parseStocksErrorBody(json) === "DIRECT_ORDER_NOT_FOUND") return null
    if (response.status < 200 || response.status > 299) throw new Error(`DIRECT_STATUS_HTTP_${response.status}`)
    return parseEnvelope(json, (data) => parseDirectStatus(data, options.side)).data
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}
