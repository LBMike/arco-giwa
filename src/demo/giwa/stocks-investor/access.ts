// What the host page knows about the steps BEFORE a Stocks request can be made (wallet, network, sign-in), so the trade
// panel can offer the next step itself. Optional: without it (standalone feature, tests) the panel falls back to the
// investor session alone. Every callback is an explicit user action; nothing here runs on render.
import { createContext, useContext } from "react"

export type GiwaStocksAccess = {
  /** The host wallet as seen by the Stocks host (not a verified session). */
  wallet: "disconnected" | "wrong-network" | "unavailable" | "ready"
  /** The host's SIWE state; `hostError` carries its public code (e.g. SESSION_EXPIRED, SESSION_REJECTED, AUTH_UNAVAILABLE). */
  host: "signed-out" | "signing-in" | "authenticated" | "error"
  hostError: string | null
  /** True when a sign-in request may start now (wallet ready, not already signing in). */
  canSignIn: boolean
  /** Starts (or joins) the host's SIWE sign-in. */
  signIn?: () => void
  /** Opens the app's wallet connection. Absent where the page has no connect control (e.g. test harness pages). */
  connectWallet?: () => void
  /** Asks the wallet to switch to GIWA Sepolia. Absent where unsupported. */
  switchNetwork?: () => void
}

export const StocksAccessContext = createContext<GiwaStocksAccess | null>(null)
export const useStocksAccess = () => useContext(StocksAccessContext)
