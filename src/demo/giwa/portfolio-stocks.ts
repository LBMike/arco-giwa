// The connected wallet's Stocks holding for the Portfolio page, read the way Savings and Funds are: the balance comes
// from GIWA, so no Stocks sign-in is needed. The NVDA token address is the one the public Stocks catalog publishes for
// its verified deployment, and the value uses the live NVDA price and daily closes the Stocks chart shows.
import { useContext, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { readShareSupply, readTokenBalance } from "./contracts"
import type { DailyClose } from "./portfolio-view"
import { normalizeApiBase } from "./api-base"
import { createGiwaStocksHttpClient } from "./stocks-investor/client"
import type { StocksActivityEntry } from "./stocks-investor/types"
import { parseEnvelope, parseStocksActivity } from "./stocks-investor/validate"
import { createMarketClient } from "./stocks-market/client"
import type { Chart, NvdaLiveSnapshot } from "./stocks-market/contracts"
import { curatedStock, stockLogoPath } from "./stocks-market/curated"
import { StocksPageEnvironment, usePageApiBase } from "./stocks-market/environment"
import type { HexAddress } from "./types"

export const STOCK_SYMBOL = "NVDA"
/** NVDA token units, as the verified Stocks deployment defines them (quantityScale 9). */
export const STOCK_DECIMALS = 9
export const STOCK_DISPLAY = { symbol: STOCK_SYMBOL, name: curatedStock(STOCK_SYMBOL)?.name ?? STOCK_SYMBOL, imageUrl: stockLogoPath(STOCK_SYMBOL) }

/** `at` is when the price was read, in unix seconds. */
export type StockPrice = { value: number; changePct: number | null; at: number }
export type StocksHolding =
  | { status: "loading" }
  /** The catalog, token or balance could not be read: the holding is unconfirmed, never zero. */
  | { status: "error" }
  | { status: "ready"; units: number; price: StockPrice | null; priceSettled: boolean; closes: DailyClose[] | null; closesSettled: boolean }

const positive = (value: string | null): number | null => {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The live snapshot's underlying price when the feed has one (a closed market keeps its last observation). */
export function stockPriceOf(snapshot: NvdaLiveSnapshot, at: number): StockPrice | null {
  const u = snapshot.underlying
  if (u.status !== "AVAILABLE" && u.status !== "STALE") return null
  const value = positive(u.price)
  if (value === null) return null
  const change = u.changePercent === null ? Number.NaN : Number(u.changePercent)
  return { value, changePct: Number.isFinite(change) ? change : null, at }
}

/** Daily closes from a 1Y chart envelope; an unavailable chart has none. */
export function dailyClosesOf(chart: { data: Chart | null }): DailyClose[] {
  return (chart.data?.bars ?? [])
    .map((bar) => ({ t: Math.floor(Date.parse(bar.timestamp) / 1000), close: positive(bar.close) ?? Number.NaN }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.close))
}

export function useStocksHolding(account: string | null): { holding: StocksHolding; fetching: boolean; refresh(): Promise<unknown> } {
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const clients = useMemo(() => {
    if (!apiBase) return null
    try {
      return { stocks: createGiwaStocksHttpClient({ baseUrl: apiBase, fetch: environment.fetch }), market: createMarketClient(apiBase, environment.fetch) }
    } catch {
      return null
    }
  }, [apiBase, environment.fetch])

  const tokenQuery = useQuery({
    queryKey: ["giwa", "stocks-token", apiBase],
    queryFn: async ({ signal }) => {
      const catalog = await clients!.stocks.getCatalog(signal)
      const token = catalog.instruments.find((instrument) => instrument.symbol === STOCK_SYMBOL)?.tokenAddress
      if (!token) throw new Error("STOCKS_TOKEN_UNPUBLISHED")
      return token
    },
    enabled: clients !== null,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const token = tokenQuery.data ?? null

  const balanceQuery = useQuery({
    queryKey: ["giwa", "stocks-balance", account, token],
    queryFn: async () => {
      const { decimals } = await readShareSupply(token as HexAddress)
      if (decimals !== STOCK_DECIMALS) throw new Error("STOCKS_TOKEN_MISMATCH")
      const units = Number(await readTokenBalance(token as HexAddress, account as HexAddress, STOCK_DECIMALS))
      if (!Number.isFinite(units) || units < 0) throw new Error("STOCKS_BALANCE_INVALID")
      return units
    },
    enabled: Boolean(account && token),
  })
  const units = balanceQuery.data ?? 0
  const held = balanceQuery.isSuccess && units > 0

  const priceQuery = useQuery({
    queryKey: ["giwa", "stocks-live-price", apiBase],
    queryFn: ({ signal }) => clients!.market.liveNvda(signal),
    enabled: clients !== null && held,
    refetchInterval: 30_000,
  })
  const closesQuery = useQuery({
    queryKey: ["giwa", "stocks-daily-closes", apiBase],
    queryFn: ({ signal }) => clients!.market.chart(STOCK_SYMBOL, "1Y", signal),
    enabled: clients !== null && held,
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  })

  let holding: StocksHolding
  if (clients === null || tokenQuery.isError || balanceQuery.isError) holding = { status: "error" }
  else if (!balanceQuery.isSuccess) holding = { status: "loading" }
  else holding = {
    status: "ready",
    units,
    price: priceQuery.isSuccess ? stockPriceOf(priceQuery.data, Math.floor(priceQuery.dataUpdatedAt / 1000)) : null,
    priceSettled: !held || priceQuery.isSuccess || priceQuery.isError,
    closes: closesQuery.isSuccess ? dailyClosesOf(closesQuery.data) : null,
    closesSettled: !held || closesQuery.isSuccess || closesQuery.isError,
  }

  const queries = [tokenQuery, balanceQuery, priceQuery, closesQuery]
  const refresh = () => Promise.allSettled([
    ...(clients !== null ? [tokenQuery.refetch()] : []),
    ...(account && token ? [balanceQuery.refetch()] : []),
    ...(held ? [priceQuery.refetch(), closesQuery.refetch()] : []),
  ])
  return { holding, fetching: queries.some((query) => query.isFetching), refresh }
}

type ActivityFetch = (input: string, init: RequestInit) => Promise<Response>

/**
 * The wallet's Stocks trades for the Portfolio Activity tab: GET /api/v1/stocks/activity/:wallet, public like the
 * product activity (every fact in it is on GIWA). No session, no cookies, no cache, no redirects, a deadline.
 */
export async function readStocksActivity(options: { apiBase: string; wallet: string; fetch?: ActivityFetch; signal?: AbortSignal; timeoutMs?: number }): Promise<StocksActivityEntry[]> {
  const base = normalizeApiBase(options.apiBase)
  if (base === null || !/^0x[0-9a-fA-F]{40}$/.test(options.wallet)) throw new Error("STOCKS_ACTIVITY_INVALID_REQUEST")
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? 10_000)
  try {
    const transport: ActivityFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const response = await transport(`${base}/api/v1/stocks/activity/${options.wallet.toLowerCase()}`, {
      method: "GET", headers: { accept: "application/json" }, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error",
    })
    if (response.status !== 200) throw new Error(`STOCKS_ACTIVITY_HTTP_${response.status}`)
    const raw = await response.text()
    if (raw.length > 1_000_000) throw new Error("STOCKS_ACTIVITY_INVALID_RESPONSE")
    return parseEnvelope(JSON.parse(raw), parseStocksActivity).data
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

export type StocksActivity =
  | { status: "loading" }
  /** Not confirmed: never shown as "no Stocks activity". */
  | { status: "error" }
  | { status: "ready"; entries: StocksActivityEntry[] }

/** The connected wallet's Stocks trades (Buy, Sell, held payments), newest first, with their GIWA transactions. */
export function useStocksActivity(account: string | null): { activity: StocksActivity; fetching: boolean; refresh(): Promise<unknown> } {
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const query = useQuery({
    queryKey: ["giwa", "stocks-activity", apiBase, account],
    queryFn: ({ signal }) => readStocksActivity({ apiBase: apiBase!, wallet: account!, fetch: environment.fetch, signal }),
    enabled: Boolean(apiBase && account),
    retry: 1,
  })
  const activity: StocksActivity = !apiBase || query.isError ? { status: "error" } : query.isSuccess ? { status: "ready", entries: query.data } : { status: "loading" }
  return { activity, fetching: query.isFetching, refresh: () => (apiBase && account ? query.refetch() : Promise.resolve()) }
}
