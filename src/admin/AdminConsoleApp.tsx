import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, useLocation } from "react-router-dom"
import { AdminApiError } from "../demo/giwa/api"
import { resolveApiBase } from "../demo/giwa/api-base"
import { ARCO_API_BASE, GIWA_CHAIN_ID } from "../demo/giwa/config"
import { useGiwaStocksHost } from "../demo/giwa/stocks-host"
import { useGiwaWallet } from "../demo/giwa/wallet"
import { defaultPath, gateView, groupOfPath, groupVisible, type PermissionState } from "./console-model"
import { ConsoleSessionContext, type ConsoleSession } from "./console-session"
import { ConsoleGate, ConsoleShell, ForbiddenPanel, type GateActions } from "./ConsoleViews"
import { fetchAdminSession } from "./session-api"

const SESSION_QUERY = "admin-console-session"

/**
 * The console root. Sign-in is the shared Stocks host's SIWE flow (one in-memory session per wallet and
 * tab); what the console offers comes only from GET /api/v1/admin/session, and every request carries that
 * one session. A 401 anywhere drops the session (sign in again); a 403 shows a notice and asks the server again.
 */
export function AdminConsoleApp() {
  const wallet = useGiwaWallet()
  const host = useGiwaStocksHost()
  const queryClient = useQueryClient()
  const { pathname } = useLocation()
  const apiBase = useMemo(() => resolveApiBase(ARCO_API_BASE, window.location.origin), [])
  const hostSession = host.snapshot.session
  const sessionId = hostSession?.id ?? null
  const accessToken = hostSession?.accessToken ?? null
  const [forbidden, setForbidden] = useState(false)

  // Cached admin data belongs to one session: drop it when the session ends or changes.
  const seen = useRef(sessionId)
  useEffect(() => {
    if (seen.current === sessionId) return
    seen.current = sessionId
    queryClient.removeQueries({ predicate: (query) => !(query.queryKey[0] === SESSION_QUERY && query.queryKey[1] === sessionId) })
    setForbidden(false)
  }, [sessionId, queryClient])

  const permissions = useQuery({
    queryKey: [SESSION_QUERY, sessionId],
    queryFn: () => fetchAdminSession(apiBase as string, accessToken as string),
    enabled: Boolean(apiBase && accessToken),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })

  const invalidate = host.invalidate
  const rejectSession = useCallback((id: string) => invalidate(id), [invalidate])
  const permissionError = permissions.error
  const rejected = permissionError instanceof AdminApiError && permissionError.status === 401
  useEffect(() => {
    // The server no longer accepts this session: drop exactly this one; the gate asks to sign in again.
    if (sessionId && rejected) rejectSession(sessionId)
  }, [rejected, sessionId, rejectSession])

  const refetch = permissions.refetch
  const recheckSession = useCallback(() => {
    void refetch()
  }, [refetch])
  const reportForbidden = useCallback(() => {
    setForbidden(true)
    void refetch()
  }, [refetch])

  const permissionState: PermissionState = !apiBase
    ? { status: "error", message: "VITE_ARCO_API_BASE is not a valid http(s) URL, so no request was sent." }
    : !hostSession
      ? { status: "idle" }
      : permissions.data
        ? { status: "ok", info: permissions.data }
        : permissionError && !rejected
          ? { status: "error", message: permissionError instanceof Error ? permissionError.message : String(permissionError) }
          : { status: "loading" }

  const view = gateView({
    walletConnected: wallet.connected && wallet.address !== null,
    walletOnGiwa: wallet.chainId === GIWA_CHAIN_ID,
    walletCanSign: host.walletStatus === "ready",
    hostStatus: host.snapshot.status,
    hostError: host.snapshot.error,
    hasSession: hostSession !== null,
    permissions: permissionState,
  })

  const { connect, switchToGiwa, disconnect } = wallet
  const { signIn: hostSignIn, logout } = host
  const signIn = useCallback(() => {
    void hostSignIn()
  }, [hostSignIn])
  const actions = useMemo<GateActions>(
    () => ({
      connect: () => void connect().catch(() => {}),
      switchNetwork: () => void switchToGiwa().catch(() => {}),
      signIn,
      retry: recheckSession,
      signOut: logout,
      disconnect: () => {
        logout()
        disconnect()
      },
    }),
    [connect, switchToGiwa, disconnect, signIn, recheckSession, logout],
  )

  const adminSession = host.admin
  const info = view.kind === "ready" ? view.info : null
  const access = view.kind === "ready" ? view.access : null
  const consoleSession = useMemo<ConsoleSession | null>(
    () =>
      info && access && apiBase && adminSession
        ? { apiBase, info, access, session: adminSession, signIn, rejectSession, recheckSession, reportForbidden }
        : null,
    // info/access are rebuilt from the same server answer on every render; key on that answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissions.data, apiBase, adminSession, signIn, rejectSession, recheckSession, reportForbidden, view.kind],
  )

  if (view.kind !== "ready" || !consoleSession || !hostSession) {
    return <ConsoleGate view={view.kind === "ready" ? { kind: "checking" } : view} wallet={wallet.address} actions={actions} />
  }

  const group = groupOfPath(pathname)
  const home = defaultPath(view.access)
  const content =
    pathname === "/" && home ? (
      <Navigate to={home} replace />
    ) : group !== null && !groupVisible(view.access, group) ? (
      <ForbiddenPanel group={group} />
    ) : (
      <Outlet />
    )

  return (
    <ConsoleSessionContext.Provider value={consoleSession}>
      <ConsoleShell
        info={view.info}
        access={view.access}
        expiresAt={hostSession.expiresAt}
        forbidden={forbidden}
        onDismissForbidden={() => setForbidden(false)}
        onSignOut={logout}
      >
        {content}
      </ConsoleShell>
    </ConsoleSessionContext.Provider>
  )
}
