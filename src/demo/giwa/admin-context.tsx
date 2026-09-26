import { createContext, useContext, type ReactNode } from "react"
import type { AdminAuth } from "./api"
import type { useGiwaWallet } from "./wallet"

// Shared by the customer app's legacy /admin layout (operator token) and the admin console (SIWE
// operator session). The pages read their credentials and write access from here, never from storage.
export type GiwaAdminContextValue = {
  /** Credentials for giwaApi.admin / giwaApi.monitoring requests. */
  auth: AdminAuth
  /** Vault write permission (vault:write). Without it every write control is disabled; the server refuses anyway. */
  canWrite: boolean
  /** Why writes are disabled, shown on the disabled controls. */
  readOnlyReason: string | null
  wallet: ReturnType<typeof useGiwaWallet>
}

export const GiwaAdminContext = createContext<GiwaAdminContextValue | null>(null)

export function useGiwaAdmin() {
  const context = useContext(GiwaAdminContext)
  if (!context) throw new Error("useGiwaAdmin must be used inside an admin layout")
  return context
}

/** Write access for components that are also rendered outside an admin layout (tests, harnesses), where it is allowed. */
export function useAdminWriteAccess(): { canWrite: boolean; readOnlyReason: string | null } {
  const context = useContext(GiwaAdminContext)
  return context ? { canWrite: context.canWrite, readOnlyReason: context.readOnlyReason } : { canWrite: true, readOnlyReason: null }
}

/**
 * Groups write controls. Without write access the fieldset is disabled, which disables every button,
 * input, select and textarea inside it; reading and navigation outside it stay available.
 */
export function AdminWriteGroup({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { canWrite, readOnlyReason } = useAdminWriteAccess()
  return (
    <fieldset
      disabled={!canWrite}
      title={canWrite ? undefined : (readOnlyReason ?? undefined)}
      data-admin-write={canWrite ? "enabled" : "disabled"}
      className={`m-0 min-w-0 border-0 p-0 ${className}`}
    >
      {children}
    </fieldset>
  )
}
