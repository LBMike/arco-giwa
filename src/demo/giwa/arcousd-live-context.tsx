// Hands the pages the live ArcoUSD v1 contracts (arcousd-live.ts): Get ArcoUSD's converters (ArcoUsdConvertContext),
// the sArcoUSD account's routes (SavingsRoutesContext) and the live state the Savings page builds the account from
// (ArcoUsdLiveContext). A host that already hands converters or routes (the investor shell preview's demo chain) keeps
// its own and nothing live is read. The providers are always rendered, so the pages never remount when the reads land.

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { arcoUsdLive, liveConvert, liveSavingsRoutes, type ArcoUsdLive } from "./arcousd-live"
import { GIWA_LIVE_REFETCH } from "./config"
import { ArcoUsdConvertContext, SavingsRoutesContext } from "./savings-routes"
import type { GiwaArcoUSDStatus } from "./types"

/** The live ArcoUSD v1 state, or null (not deployed, never read yet, or a host with its own routes). */
export const ArcoUsdLiveContext = createContext<ArcoUsdLive | null>(null)

/**
 * True until both ArcoUSD reads have described the contracts (live or not deployed). The Savings page waits for that
 * before picking its account, so a first read that fails (the request, or the server's `unavailable`) keeps it loading
 * and retrying instead of opening on the vault sArcoUSD replaces.
 */
export const ArcoUsdLivePendingContext = createContext(false)

/**
 * Set while pending when the reads keep answering without describing the contracts (the API or its chain read is
 * down): the pages say so and offer `retry` instead of loading forever. Null otherwise. The reads keep polling, so a
 * recovery clears it by itself.
 */
export const ArcoUsdLiveFailedContext = createContext<{ retry: () => void } | null>(null)

/** While a read has not described the contracts it is asked again sooner than the usual live refresh. */
const UNDESCRIBED_REFETCH_MS = 3_000
/** Answers without a description (failed requests or `unavailable`) before the pages are told the read failed. */
const FAILED_AFTER_ANSWERS = 3

/**
 * The last answer that described the contracts. A read the server could not make (`unavailable`: one RPC failure, cached
 * for seconds) keeps the previous answer, so one bad poll never takes the live account or Get ArcoUSD away mid-transfer;
 * `not-deployed` is an answer and replaces it.
 */
function useLastDescribed<T extends { status: GiwaArcoUSDStatus }>(data: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined)
  if (data !== undefined && data.status !== "unavailable") last.current = data
  return data !== undefined && data.status === "unavailable" ? (last.current ?? data) : data
}

/** An answer about the contracts: live or not deployed (not a read that failed or has not landed). */
function described(data: { status: GiwaArcoUSDStatus } | undefined): boolean {
  return data !== undefined && data.status !== "unavailable"
}

function refetchInterval(query: { state: { data: { status: GiwaArcoUSDStatus } | undefined } }) {
  return described(query.state.data) ? GIWA_LIVE_REFETCH.refetchInterval : UNDESCRIBED_REFETCH_MS
}

/** The read answered FAILED_AFTER_ANSWERS times (data or error) and none of them described the contracts. */
function failedRead(query: { dataUpdateCount: number; errorUpdateCount: number }, data: { status: GiwaArcoUSDStatus } | undefined): boolean {
  return !described(data) && query.dataUpdateCount + query.errorUpdateCount >= FAILED_AFTER_ANSWERS
}

export function ArcoUsdLiveProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const outerRoutes = useContext(SavingsRoutesContext)
  const outerConvert = useContext(ArcoUsdConvertContext)
  const hosted = outerRoutes.length > 0 || outerConvert !== null
  const reading = enabled && !hosted
  // The same key and read as the operation hook's Router check, so the two share one request.
  const reserveQuery = useQuery({
    queryKey: ["giwa", "arcousd", "reserve"],
    queryFn: () => giwaApi.arcousd.reserve(),
    enabled: reading,
    ...GIWA_LIVE_REFETCH,
    refetchInterval,
  })
  const savingsQuery = useQuery({
    queryKey: ["giwa", "arcousd", "savings"],
    queryFn: () => giwaApi.arcousd.savings(),
    enabled: reading,
    ...GIWA_LIVE_REFETCH,
    refetchInterval,
  })
  const reserve = useLastDescribed(reserveQuery.data)
  const savings = useLastDescribed(savingsQuery.data)
  const live = useMemo(() => (reading ? arcoUsdLive(reserve, savings) : null), [reading, reserve, savings])
  const pending = reading && (!described(reserve) || !described(savings))
  const queryClient = useQueryClient()
  const retry = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: ["giwa", "arcousd", "reserve"] })
    void queryClient.refetchQueries({ queryKey: ["giwa", "arcousd", "savings"] })
  }, [queryClient])
  // The provider re-renders on every answer (it reads when each read last answered); how many answers each read has had
  // is on its query's state.
  const answered = (key: "reserve" | "savings", lastAnswerAt: number) => {
    const state = lastAnswerAt > 0 ? queryClient.getQueryState(["giwa", "arcousd", key]) : undefined
    return { dataUpdateCount: state?.dataUpdateCount ?? 0, errorUpdateCount: state?.errorUpdateCount ?? 0 }
  }
  const reserveAnswers = answered("reserve", Math.max(reserveQuery.dataUpdatedAt, reserveQuery.errorUpdatedAt))
  const savingsAnswers = answered("savings", Math.max(savingsQuery.dataUpdatedAt, savingsQuery.errorUpdatedAt))
  const failedNow = pending && (failedRead(reserveAnswers, reserve) || failedRead(savingsAnswers, savings))
  const failed = useMemo(() => (failedNow ? { retry } : null), [failedNow, retry])
  const routes = useMemo(() => (live !== null ? liveSavingsRoutes(live) : outerRoutes), [live, outerRoutes])
  const convert = useMemo(() => (live !== null ? liveConvert(live) : outerConvert), [live, outerConvert])
  return (
    <ArcoUsdLivePendingContext.Provider value={pending}>
      <ArcoUsdLiveFailedContext.Provider value={failed}>
        <ArcoUsdLiveContext.Provider value={live}>
          <SavingsRoutesContext.Provider value={routes}>
            <ArcoUsdConvertContext.Provider value={convert}>{children}</ArcoUsdConvertContext.Provider>
          </SavingsRoutesContext.Provider>
        </ArcoUsdLiveContext.Provider>
      </ArcoUsdLiveFailedContext.Provider>
    </ArcoUsdLivePendingContext.Provider>
  )
}
