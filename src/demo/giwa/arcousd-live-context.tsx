// Hands the pages the live ArcoUSD v1 contracts (arcousd-live.ts): Get ArcoUSD's converters (ArcoUsdConvertContext),
// the sArcoUSD account's routes (SavingsRoutesContext) and the live state the Savings page builds the account from
// (ArcoUsdLiveContext). A host that already hands converters or routes (the investor shell preview's demo chain) keeps
// its own and nothing live is read. The providers are always rendered, so the pages never remount when the reads land.

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { arcoUsdLive, liveConvert, liveSavingsRoutes, type ArcoUsdLive } from "./arcousd-live"
import { GIWA_LIVE_REFETCH } from "./config"
import { ArcoUsdConvertContext, SavingsRoutesContext } from "./savings-routes"
import type { GiwaArcoUSDStatus } from "./types"

/** The live ArcoUSD v1 state, or null (not deployed, never read yet, or a host with its own routes). */
export const ArcoUsdLiveContext = createContext<ArcoUsdLive | null>(null)

/** True until the first ArcoUSD reads have answered (the Savings page waits for them before picking its account). */
export const ArcoUsdLivePendingContext = createContext(false)

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
  })
  const savingsQuery = useQuery({
    queryKey: ["giwa", "arcousd", "savings"],
    queryFn: () => giwaApi.arcousd.savings(),
    enabled: reading,
    ...GIWA_LIVE_REFETCH,
  })
  const reserve = useLastDescribed(reserveQuery.data)
  const savings = useLastDescribed(savingsQuery.data)
  const live = useMemo(() => (reading ? arcoUsdLive(reserve, savings) : null), [reading, reserve, savings])
  const pending = reading && (reserveQuery.isPending || savingsQuery.isPending)
  const routes = useMemo(() => (live !== null ? liveSavingsRoutes(live) : outerRoutes), [live, outerRoutes])
  const convert = useMemo(() => (live !== null ? liveConvert(live) : outerConvert), [live, outerConvert])
  return (
    <ArcoUsdLivePendingContext.Provider value={pending}>
      <ArcoUsdLiveContext.Provider value={live}>
        <SavingsRoutesContext.Provider value={routes}>
          <ArcoUsdConvertContext.Provider value={convert}>{children}</ArcoUsdConvertContext.Provider>
        </SavingsRoutesContext.Provider>
      </ArcoUsdLiveContext.Provider>
    </ArcoUsdLivePendingContext.Provider>
  )
}
