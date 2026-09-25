import { useSyncExternalStore } from "react"
import { directTradeOf, subscribeDirectTrades, type DirectTrade } from "./trade"

/** The connected wallet's direct trade on this page (kept while the panel remounts), or null. */
export function useDirectTrade(owner: string | null): DirectTrade | null {
  return useSyncExternalStore(subscribeDirectTrades, () => directTradeOf(owner), () => null)
}
