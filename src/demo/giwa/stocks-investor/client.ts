// GIWA-only HTTP client for the Stocks investor API.
//
// • Public catalog: no Authorization header. Every other call requires the host-verified SIWE
//   bearer token and is never sent without one.
// • Bodies are exactly the server's accepted keys: quotes {symbol, quantity}, orders
//   {quoteId, idempotencyKey} (the idempotency key travels in the BODY, not a header).
// • No cookies, no HTTP cache, no redirects, a bounded response size and a request deadline.
// • Errors are classified so callers can tell "the server definitely did not do it" from
//   "the outcome is unknown".

import { normalizeApiBase } from "../api-base"
import {
  isRouteNotRegisteredBody,
  parseCatalog,
  parseEnvelope,
  parseOrder,
  parseOrderList,
  parsePortfolio,
  parseQuote,
  parseStocksErrorBody,
  StocksResponseError,
} from "./validate"
import type {
  StocksCatalog,
  StocksEnvelope,
  StocksOrder,
  StocksOrderRequest,
  StocksPortfolio,
  StocksQuote,
  StocksQuoteRequest,
  StocksSide,
} from "./types"

export type GiwaStocksRequestErrorKind =
  /** The caller's own abort (session change, unmount). */
  | "ABORTED"
  /** No usable HTTP answer: offline, CORS, dropped connection, deadline. Outcome unknown. */
  | "NETWORK"
  /** A validated Stocks error body: the server refused this request. */
  | "HTTP"
  /** The Stocks routes are not registered on this server (Fastify default 404). */
  | "NOT_REGISTERED"
  /** An answer that is not a valid Stocks response (bad JSON, wrong shape, unknown error body). Outcome unknown. */
  | "INVALID_RESPONSE"

export class GiwaStocksRequestError extends Error {
  constructor(
    readonly kind: GiwaStocksRequestErrorKind,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(`GIWA_STOCKS_${kind}${code ? `:${code}` : ""}`)
    this.name = "GiwaStocksRequestError"
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type GiwaStocksClient = {
  readonly baseUrl: string
  getCatalog(signal: AbortSignal): Promise<StocksCatalog>
  createQuote(side: StocksSide, body: StocksQuoteRequest, token: string, signal: AbortSignal): Promise<StocksEnvelope<StocksQuote>>
  createOrder(side: StocksSide, body: StocksOrderRequest, token: string, signal: AbortSignal): Promise<StocksEnvelope<StocksOrder>>
  listOrders(side: StocksSide, token: string, signal: AbortSignal): Promise<StocksEnvelope<StocksOrder[]>>
  getOrder(side: StocksSide, orderId: string, token: string, signal: AbortSignal): Promise<StocksEnvelope<StocksOrder>>
  getPortfolio(token: string, signal: AbortSignal): Promise<StocksEnvelope<StocksPortfolio>>
}

export type GiwaStocksHttpClientOptions = {
  /** API base, e.g. the host's ARCO_API_BASE. Must be absolute http(s) without credentials and without any "?" or "#". */
  baseUrl: string
  /** Injected transport for tests and the explicit verification fixture. Defaults to globalThis.fetch. */
  fetch?: FetchLike
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number
}

const MAX_BODY_CHARS = 1_000_000

function normalizeBaseUrl(value: string): string {
  const base = normalizeApiBase(value)
  if (base === null) throw new Error("GIWA_STOCKS_INVALID_BASE_URL")
  return base
}

function sidePath(side: StocksSide, buy: string, sell: string): string {
  return side === "SELL" ? sell : buy
}

export function createGiwaStocksHttpClient(options: GiwaStocksHttpClientOptions): GiwaStocksClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const transport: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 15_000

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    parse: (value: unknown) => T,
    signal: AbortSignal,
    auth: { token: string } | null,
    body?: unknown,
  ): Promise<T> {
    if (signal.aborted) throw new GiwaStocksRequestError("ABORTED", null, null)
    // A missing token is a caller bug, not a server answer: never sent, never reported as a 401.
    if (auth !== null && auth.token.length === 0) throw new Error("GIWA_STOCKS_TOKEN_REQUIRED")
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const headers: Record<string, string> = { accept: "application/json" }
      if (body !== undefined) headers["content-type"] = "application/json"
      if (auth !== null) headers.authorization = `Bearer ${auth.token}`
      let response: Response
      try {
        response = await transport(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        })
      } catch {
        if (signal.aborted && !timedOut) throw new GiwaStocksRequestError("ABORTED", null, null)
        throw new GiwaStocksRequestError("NETWORK", null, timedOut ? "TIMEOUT" : null)
      }
      let raw: string
      try {
        raw = await response.text()
      } catch {
        if (signal.aborted && !timedOut) throw new GiwaStocksRequestError("ABORTED", null, null)
        throw new GiwaStocksRequestError("NETWORK", response.status, timedOut ? "TIMEOUT" : "BODY_UNREADABLE")
      }
      if (raw.length > MAX_BODY_CHARS) throw new GiwaStocksRequestError("INVALID_RESPONSE", response.status, "BODY_TOO_LARGE")
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        throw new GiwaStocksRequestError("INVALID_RESPONSE", response.status, "NOT_JSON")
      }
      if (response.status < 200 || response.status > 299) {
        const code = parseStocksErrorBody(json)
        if (code !== null) throw new GiwaStocksRequestError("HTTP", response.status, code)
        if (response.status === 404 && isRouteNotRegisteredBody(json)) throw new GiwaStocksRequestError("NOT_REGISTERED", 404, null)
        throw new GiwaStocksRequestError("INVALID_RESPONSE", response.status, null)
      }
      try {
        return parse(json)
      } catch (error) {
        if (error instanceof StocksResponseError) throw new GiwaStocksRequestError("INVALID_RESPONSE", response.status, error.path)
        throw error
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
  }

  return Object.freeze({
    baseUrl,
    getCatalog: (signal) => request("GET", "/api/v1/stocks/catalog", parseCatalog, signal, null),
    createQuote: (side, body, token, signal) =>
      request(
        "POST",
        sidePath(side, "/api/v1/stocks/quotes", "/api/v1/stocks/sell-quotes"),
        (value) => parseEnvelope(value, (data) => parseQuote(data, side)),
        signal,
        { token },
        { symbol: body.symbol, quantity: body.quantity },
      ),
    createOrder: (side, body, token, signal) =>
      request(
        "POST",
        sidePath(side, "/api/v1/stocks/orders", "/api/v1/stocks/sell-orders"),
        (value) => parseEnvelope(value, (data) => parseOrder(data, side)),
        signal,
        { token },
        { quoteId: body.quoteId, idempotencyKey: body.idempotencyKey },
      ),
    listOrders: (side, token, signal) =>
      request(
        "GET",
        sidePath(side, "/api/v1/stocks/orders", "/api/v1/stocks/sell-orders"),
        (value) => parseEnvelope(value, (data) => parseOrderList(data, side)),
        signal,
        { token },
      ),
    getOrder: (side, orderId, token, signal) =>
      request(
        "GET",
        `${sidePath(side, "/api/v1/stocks/orders", "/api/v1/stocks/sell-orders")}/${encodeURIComponent(orderId)}`,
        (value) => parseEnvelope(value, (data) => parseOrder(data, side)),
        signal,
        { token },
      ),
    getPortfolio: (token, signal) =>
      request("GET", "/api/v1/stocks/portfolio", (value) => parseEnvelope(value, parsePortfolio), signal, { token }),
  })
}
