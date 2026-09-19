import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { ShieldAlert } from "lucide-react"
import { GIWA_ADMIN_ADDRESSES_RAW } from "./config"
import { GIWA_FUNDS_ROUTE } from "./routes"
import { isAdminAddress, parseAdminAddresses } from "./admin-access"
import { useGiwaWallet } from "./wallet"

// IMPORTANT: this is a VISIBILITY gate, NOT security. Real enforcement lives in the
// server (requireOperator / x-operator-token) and on-chain (FEED_ADMIN_ROLE for signing).
// This component only hides the admin UI from non-allowlisted wallets in the SPA.
const ADMIN_ALLOWLIST = parseAdminAddresses(GIWA_ADMIN_ADDRESSES_RAW)

export function RequireGiwaAdmin({ children }: { children: ReactNode }) {
  const wallet = useGiwaWallet()
  if (isAdminAddress(wallet.address, ADMIN_ALLOWLIST)) return <>{children}</>

  return (
    <section className="w-full">
      <div
        className="mx-auto mt-6 max-w-[480px] rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-6 text-center"
        style={{ boxShadow: "var(--shadow-control)" }}
      >
        <ShieldAlert className="mx-auto size-6 text-[var(--color-arco-muted)]" />
        {wallet.connected ? (
          <>
            <h2 className="mt-3 text-lg font-semibold text-[var(--color-arco-ink)]">This wallet is not authorized for admin.</h2>
            <p className="mt-1 text-sm text-[var(--color-arco-text-soft)]">Connected as</p>
            <p className="mt-0.5 break-all font-mono text-xs text-[var(--color-arco-muted)]">{wallet.address}</p>
          </>
        ) : (
          <>
            <h2 className="mt-3 text-lg font-semibold text-[var(--color-arco-ink)]">Connect the admin wallet to continue</h2>
            <p className="mt-1 text-sm text-[var(--color-arco-text-soft)]">
              The GIWA admin console is limited to authorized operator wallets.
            </p>
            <button
              type="button"
              onClick={() => void wallet.connect()}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-arco-ink)] px-4 py-2 text-sm font-medium text-[var(--color-arco-on-dark)]"
            >
              Connect wallet
            </button>
          </>
        )}
        <Link to={GIWA_FUNDS_ROUTE} className="mt-4 inline-block text-sm text-[var(--color-arco-ink)] underline">
          Back to products
        </Link>
      </div>
    </section>
  )
}
