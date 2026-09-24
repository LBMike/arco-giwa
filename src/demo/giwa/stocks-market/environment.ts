import { createContext, useContext, useMemo } from "react"
import { resolveApiBase } from "../api-base"
import { ARCO_API_BASE } from "../config"
import type { ExecutionClockSeam } from "../stocks-execution-host"
import type { KnownHashStore } from "../stocks-known-hash-recovery"
import type { ActiveWalletSource } from "../stocks-wallet-source"
import type { MarketFetch } from "./contracts"
/** Explicit offline verification seam; normal runtime uses ARCO_API_BASE, browser fetch, real clocks and the wallet module's active source. */
export const StocksPageEnvironment = createContext<{ apiBase: string | null; fetch?: MarketFetch; executionClock?: ExecutionClockSeam; activeWalletSource?: () => ActiveWalletSource | null; knownHashes?: KnownHashStore }>({ apiBase: ARCO_API_BASE })
/** One validated API base for market, investor, admin and wallet execution, so a malformed setting fails the same way on every Stocks surface. */
export function usePageApiBase(): string | null {
  const { apiBase } = useContext(StocksPageEnvironment)
  return useMemo(() => (apiBase === null ? null : resolveApiBase(apiBase, window.location.origin)), [apiBase])
}
