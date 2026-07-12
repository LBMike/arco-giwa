import { createContext, useContext, useEffect, useRef, useState } from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import { AdminNotice } from "./components"
import {
  GIWA_ADMIN_CONFIG_ROUTE,
  GIWA_ADMIN_FEATURED_ROUTE,
  GIWA_ADMIN_MONITORING_ROUTE,
  GIWA_ADMIN_OPERATIONS_ROUTE,
  GIWA_ADMIN_PRICES_ROUTE,
} from "./routes"
import { useGiwaWallet } from "./wallet"

const TOKEN_STORAGE_KEY = "arco.giwa.operatorToken"

const ADMIN_TABS = [
  { label: "Prices", to: GIWA_ADMIN_PRICES_ROUTE },
  { label: "Vault Config", to: GIWA_ADMIN_CONFIG_ROUTE },
  { label: "Featured cards", to: GIWA_ADMIN_FEATURED_ROUTE },
  { label: "Vault Operations", to: GIWA_ADMIN_OPERATIONS_ROUTE },
  { label: "Monitoring", to: GIWA_ADMIN_MONITORING_ROUTE },
] as const

function storedOperatorToken() {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? ""
}

type GiwaAdminContextValue = {
  operatorToken: string
  setOperatorToken: (value: string) => void
  clearOperatorToken: () => void
  wallet: ReturnType<typeof useGiwaWallet>
}

const GiwaAdminContext = createContext<GiwaAdminContextValue | null>(null)

export function useGiwaAdmin() {
  const context = useContext(GiwaAdminContext)
  if (!context) throw new Error("useGiwaAdmin must be used inside GiwaAdminLayout")
  return context
}

export function GiwaAdminLayout() {
  const wallet = useGiwaWallet()
  const wasConnected = useRef(wallet.connected)
  const { pathname } = useLocation()
  const [operatorToken, setOperatorToken] = useState(storedOperatorToken)

  function persistToken(value: string) {
    setOperatorToken(value)
    window.localStorage.setItem(TOKEN_STORAGE_KEY, value)
  }

  function clearOperatorToken() {
    setOperatorToken("")
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  }

  useEffect(() => {
    if (wasConnected.current && !wallet.connected) clearOperatorToken()
    wasConnected.current = wallet.connected
  }, [wallet.connected])

  return (
    <GiwaAdminContext.Provider
      value={{ operatorToken, setOperatorToken: persistToken, clearOperatorToken, wallet }}
    >
      <div className="w-full space-y-6">
        <nav className="flex items-center gap-2 border-b border-[var(--color-arco-border)] pb-[6px]">
          {ADMIN_TABS.map((tab) => (
            <AdminTabLink key={tab.to} to={tab.to} active={pathname.startsWith(tab.to)}>
              {tab.label}
            </AdminTabLink>
          ))}
        </nav>

        <AdminNotice />

        <section className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
          <label className="block text-xs text-[var(--color-arco-muted)]">
            Operator token
            <input
              type="password"
              value={operatorToken}
              onChange={(event) => persistToken(event.target.value)}
              placeholder="Entered by operator at runtime"
              className="mt-1 h-10 w-full max-w-[420px] rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-sm"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="rounded-md border border-[var(--color-arco-border)] px-3 py-2 text-xs" onClick={clearOperatorToken}>
              Clear operator token
            </button>
            <button type="button" className="rounded-md border border-[var(--color-arco-border)] px-3 py-2 text-xs" onClick={() => { clearOperatorToken(); wallet.disconnect() }}>
              Disconnect and clear
            </button>
          </div>
        </section>

        <Outlet />
      </div>
    </GiwaAdminContext.Provider>
  )
}

function AdminTabLink({ to, active, children }: { to: string; active: boolean; children: string }) {
  return (
    <Link to={to} className="relative px-4 py-2 text-sm leading-6 text-[var(--color-arco-text)]">
      {children}
      {active && (
        <span className="absolute -bottom-[7px] left-1/4 right-1/4 h-[0.5px] min-w-[50px] bg-[var(--color-arco-ink)]" />
      )}
    </Link>
  )
}
