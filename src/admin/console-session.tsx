import { createContext, useContext } from "react"
import type { AdminSessionInfo, ConsoleAccess } from "./console-model"

export type ConsoleSession = {
  readonly apiBase: string
  readonly info: AdminSessionInfo
  readonly access: ConsoleAccess
  /** The host's SIWE operator session (memory only), sent unchanged with every Vault and Stocks request. */
  readonly session: { readonly id: string; readonly accessToken: string }
  readonly signIn: () => void
  /** A 401 from an admin request: drop the session that request carried (never a newer one). */
  readonly rejectSession: (sessionId: string) => void
  /** Ask the server again what this session may do (after a 403, or on demand). */
  readonly recheckSession: () => void
  /** A 403 from a Vault request: show the notice and ask the server again. */
  readonly reportForbidden: () => void
}

export const ConsoleSessionContext = createContext<ConsoleSession | null>(null)

export function useConsoleSession(): ConsoleSession {
  const value = useContext(ConsoleSessionContext)
  if (!value) throw new Error("useConsoleSession must be used inside the signed-in admin console")
  return value
}
