// Whether the server would take a new order of a side now: GET /api/v1/stocks/availability. A direct trade asks right
// before the wallet is asked, because the server cannot refuse a transaction that is already on GIWA, only hold it.
// Public (no session, cookies, cache or redirects), a bounded body and a short deadline, like the status read.
//
// The answer is a hint that can only stop a send: when the server says no, nothing is asked of the wallet; when the check
// cannot be made (an older server without the route, no answer, an unreadable one) the trade goes ahead as before and the
// server still holds anything it cannot take.
import { normalizeApiBase } from "../api-base"
import type { StocksSide } from "../stocks-investor/types"
import { parseEnvelope } from "../stocks-investor/validate"
import type { DirectTradeInput } from "./trade"

type FetchLike = (input: string, init: RequestInit) => Promise<Response>
const MAX_BODY_CHARS = 10_000

/** Why the server would not take a new order of the side now. */
export type TradingBlock = "TRADING_PAUSED" | "SIDE_DISABLED" | "DAILY_LIMIT_REACHED"
const BLOCKS: readonly string[] = ["TRADING_PAUSED", "SIDE_DISABLED", "DAILY_LIMIT_REACHED"] satisfies TradingBlock[]

export type TradingAvailability = Readonly<{ side: StocksSide; accepts: boolean; block: TradingBlock | null }>

function parseAvailability(input: unknown, side: StocksSide): TradingAvailability {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("AVAILABILITY_INVALID_RESPONSE")
  const row = input as Record<string, unknown>
  const keys = Object.keys(row).sort().join(",")
  if (keys !== "accepts,block,side,symbol" || row.symbol !== "NVDA" || row.side !== side || typeof row.accepts !== "boolean") throw new Error("AVAILABILITY_INVALID_RESPONSE")
  if (row.accepts ? row.block !== null : typeof row.block !== "string" || !BLOCKS.includes(row.block)) throw new Error("AVAILABILITY_INVALID_RESPONSE")
  return { side, accepts: row.accepts, block: row.accepts ? null : (row.block as TradingBlock) }
}

/** The server's answer for `side` and a cash amount in tUSDC base units; throws when there is no usable answer. */
export async function readTradingAvailability(options: { apiBase: string; side: StocksSide; cashAmount: string | null; fetch?: FetchLike; timeoutMs?: number }): Promise<TradingAvailability> {
  const base = normalizeApiBase(options.apiBase)
  if (base === null) throw new Error("AVAILABILITY_INVALID_BASE")
  const query = new URLSearchParams({ side: options.side })
  if (options.cashAmount !== null && /^[1-9]\d{0,30}$/.test(options.cashAmount)) query.set("cashAmount", options.cashAmount)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const transport: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const response = await transport(`${base}/api/v1/stocks/availability?${query.toString()}`, {
      method: "GET", headers: { accept: "application/json" }, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error",
    })
    const raw = await response.text()
    if (response.status < 200 || response.status > 299) throw new Error(`AVAILABILITY_HTTP_${response.status}`)
    if (raw.length > MAX_BODY_CHARS) throw new Error("AVAILABILITY_INVALID_RESPONSE")
    let json: unknown
    try { json = JSON.parse(raw) } catch { throw new Error("AVAILABILITY_INVALID_RESPONSE") }
    return parseEnvelope(json, (data) => parseAvailability(data, options.side)).data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The refusal that stops a direct trade before the wallet is asked, or null to go ahead. A Buy is checked for the tUSDC it
 * pays; a Sell for the tUSDC the page expects it to pay out (the server prices it when GIWA confirms it).
 */
export async function directSendBlock(options: { apiBase: string; input: DirectTradeInput; fetch?: FetchLike; timeoutMs?: number }): Promise<TradingBlock | null> {
  const { input } = options
  const cashAmount = input.side === "BUY" ? input.amount : input.estimate
  try {
    const answer = await readTradingAvailability({ apiBase: options.apiBase, side: input.side, cashAmount, fetch: options.fetch, timeoutMs: options.timeoutMs })
    return answer.block
  } catch {
    return null
  }
}
