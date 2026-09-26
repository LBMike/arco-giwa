import { useMemo } from "react"
import { Navigate, useNavigate, useParams } from "react-router-dom"
import { GIWA_EXPLORER } from "../demo/giwa/config"
import { GiwaStocksAdminFeature, HeldPaymentsPanel, type StocksAdminFetch } from "../demo/giwa/stocks-admin"
import { StocksLimitsPanel } from "../demo/giwa/stocks-limits"
import { GiwaStocksTradingControlFeature } from "../demo/giwa/stocks-trading-control"
import { isStocksTab, stocksTabPath, type StocksTabId } from "./console-model"
import { useConsoleSession } from "./console-session"

export function explorerTxUrl(txHash: string): string {
  return `${GIWA_EXPLORER.replace(/\/+$/, "")}/tx/${txHash}`
}

/** One Stocks tab per route; all of them use the console's one session (no separate Stocks sign-in). */
export function StocksRoute() {
  const { section } = useParams()
  const navigate = useNavigate()
  const { apiBase, session, access, signIn, rejectSession, recheckSession } = useConsoleSession()
  // The Stocks routes answer 403 for both an unverifiable session and a missing permission: on 403 the
  // console asks the server again, which tells an ended session (401, sign in again) from a permission.
  const fetch = useMemo<StocksAdminFetch>(
    () => async (url, init) => {
      const response = await globalThis.fetch(url, init)
      if (response.status === 401) rejectSession(session.id)
      else if (response.status === 403) recheckSession()
      return response
    },
    [rejectSession, recheckSession, session.id],
  )
  if (!isStocksTab(section)) return <Navigate to={stocksTabPath("limits")} replace />
  return (
    <StocksTabView
      tab={section}
      apiBase={apiBase}
      session={session}
      canControl={access.stocksControl}
      fetch={fetch}
      onSignInRequired={signIn}
      onNavigate={(path) => navigate(path)}
    />
  )
}

export function StocksTabView({
  tab,
  apiBase,
  session,
  canControl,
  fetch,
  onSignInRequired,
  onNavigate,
}: {
  tab: StocksTabId
  apiBase: string
  session: { readonly id: string; readonly accessToken: string } | null
  canControl: boolean
  fetch?: StocksAdminFetch
  onSignInRequired: () => void
  onNavigate: (path: string) => void
}) {
  if (tab === "limits") {
    return <StocksLimitsPanel apiBase={apiBase} session={session} fetch={fetch} canControl={canControl} onSignInRequired={onSignInRequired} />
  }
  if (tab === "trading-control") {
    return <GiwaStocksTradingControlFeature apiBase={apiBase} session={session} fetch={fetch} canControl={canControl} onSignInRequired={onSignInRequired} />
  }
  if (tab === "held") {
    return <HeldPaymentsPanel apiBase={apiBase} session={session} fetch={fetch} explorerTxUrl={explorerTxUrl} onSignInRequired={onSignInRequired} />
  }
  return (
    <GiwaStocksAdminFeature
      apiBase={apiBase}
      session={session}
      fetch={fetch}
      section={tab}
      onSectionChange={(next) => onNavigate(stocksTabPath(next))}
      onSignInRequired={onSignInRequired}
    />
  )
}
