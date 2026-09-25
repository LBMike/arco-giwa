import { Suspense, useMemo } from "react"
import { Outlet } from "react-router-dom"
import { GiwaAdminContext, type GiwaAdminContextValue } from "../demo/giwa/admin-context"
import { bearerSessionAuth } from "../demo/giwa/api"
import { AdminNotice } from "../demo/giwa/components"
import { useGiwaWallet } from "../demo/giwa/wallet"
import { READ_ONLY_VAULT_REASON } from "./console-model"
import { useConsoleSession } from "./console-session"
import { LoadingPanel, ReadOnlyNotice } from "./ConsoleViews"

/**
 * The customer app's Vault admin pages, reused unchanged, with the console's session instead of the
 * legacy operator token (there is no token field here) and write controls tied to vault:write.
 */
export function VaultsLayout() {
  const { session, access, rejectSession, reportForbidden } = useConsoleSession()
  const wallet = useGiwaWallet()
  const auth = useMemo(
    () =>
      bearerSessionAuth(session.accessToken, (status) => {
        if (status === 401) rejectSession(session.id)
        else reportForbidden()
      }),
    [session.accessToken, session.id, rejectSession, reportForbidden],
  )
  const value = useMemo<GiwaAdminContextValue>(
    () => ({ auth, canWrite: access.vaultWrite, readOnlyReason: access.vaultWrite ? null : READ_ONLY_VAULT_REASON, wallet }),
    [auth, access.vaultWrite, wallet],
  )
  return (
    <GiwaAdminContext.Provider value={value}>
      <div className="w-full min-w-0 space-y-6">
        <AdminNotice />
        {!access.vaultWrite && <ReadOnlyNotice />}
        <Suspense fallback={<LoadingPanel what="page" />}>
          <Outlet />
        </Suspense>
      </div>
    </GiwaAdminContext.Provider>
  )
}
