// Hands the pages the live ArcoGOLD contracts (arcogold-live.ts): the gold Savings account's state, read from
// /api/v1/arcogold/reserve and /savings. Unlike the ArcoUSD reads, nothing waits on these: before the gold stack is
// deployed (or on an API without the gold routes) they answer "not-deployed" or fail, the context stays null, and no
// page shows anything gold or says anything failed. A host that hands its own routes or converters (the investor shell
// preview's demo chain) reads nothing here either. Rendered outside ArcoUsdLiveProvider, so it sees the host's routes,
// not the live ArcoUSD ones.

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { giwaApi } from "./api"
import { arcoGoldLive, type ArcoGoldLive } from "./arcogold-live"
import { GIWA_LIVE_REFETCH } from "./config"
import { ArcoUsdConvertContext, SavingsRoutesContext } from "./savings-routes"
import type { GiwaArcoUSDStatus } from "./types"

/** The live gold account, or null (not deployed, not read yet, a failed read, or a host with its own routes). */
export const ArcoGoldLiveContext = createContext<ArcoGoldLive | null>(null)

/**
 * True until both gold reads have answered once (with data or an error). The Savings page waits for it only when the
 * Gold tab is asked for, so a link to it does not open on another account first.
 */
export const ArcoGoldLivePendingContext = createContext(false)

/** A read the server could not make (`unavailable`, one RPC blip) keeps the previous answer, so the account never flickers away. */
function useLastDescribed<T extends { status: GiwaArcoUSDStatus }>(data: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined)
  if (data !== undefined && data.status !== "unavailable") last.current = data
  return data !== undefined && data.status === "unavailable" ? (last.current ?? data) : data
}

export function ArcoGoldLiveProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const outerRoutes = useContext(SavingsRoutesContext)
  const outerConvert = useContext(ArcoUsdConvertContext)
  const hosted = outerRoutes.length > 0 || outerConvert !== null
  const reading = enabled && !hosted
  const reserveQuery = useQuery({
    queryKey: ["giwa", "arcogold", "reserve"],
    queryFn: () => giwaApi.arcogold.reserve(),
    enabled: reading,
    retry: 1,
    ...GIWA_LIVE_REFETCH,
  })
  const savingsQuery = useQuery({
    queryKey: ["giwa", "arcogold", "savings"],
    queryFn: () => giwaApi.arcogold.savings(),
    enabled: reading,
    retry: 1,
    ...GIWA_LIVE_REFETCH,
  })
  const reserve = useLastDescribed(reserveQuery.data)
  const savings = useLastDescribed(savingsQuery.data)
  const live = useMemo(() => (reading ? arcoGoldLive(reserve, savings) : null), [reading, reserve, savings])
  // Answered: data or a final error (react-query keeps a query pending through its retry).
  const pending = reading && (reserveQuery.isPending || savingsQuery.isPending)
  return (
    <ArcoGoldLivePendingContext.Provider value={pending}>
      <ArcoGoldLiveContext.Provider value={live}>{children}</ArcoGoldLiveContext.Provider>
    </ArcoGoldLivePendingContext.Provider>
  )
}
