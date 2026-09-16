import { useId } from "react"
import { useGiwaStocksHost } from "./StocksHostProvider"

/** Compose on the future Stocks surfaces, not on unrelated Savings/Funds pages. */
export function StocksSignIn() {
  const host = useGiwaStocksHost()
  const description = useId()
  const signedIn = host.snapshot.status === "authenticated"
  const pending = host.snapshot.status === "signing-in"
  const failed = host.snapshot.status === "error" || Boolean(host.snapshot.error)
  const status = host.walletStatus === "disconnected"
    ? "Connect a wallet to sign in to Stocks."
    : host.walletStatus === "wrong-network"
      ? "Switch your wallet to GIWA Sepolia to sign in to Stocks."
      : host.walletStatus === "unavailable"
        ? "Your wallet is not ready to sign a message."
        : signedIn ? "Signed in to Stocks."
          : pending ? "Complete the sign-in message in your wallet."
            : host.snapshot.error === "SESSION_EXPIRED" ? "Your Stocks session expired. Sign in again."
              : host.snapshot.error === "SESSION_REJECTED" ? "Your Stocks session is no longer valid. Sign in again."
                : failed ? "Stocks sign-in could not be completed. Try again."
                  : "Sign in to view your Stocks account."
  const button = "rounded-lg border border-[var(--color-arco-border)] px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] disabled:cursor-not-allowed disabled:opacity-50"
  return (
    <section aria-label="Stocks sign-in" className="w-full rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 text-[var(--color-arco-ink)]">
      <p id={description} role="status" aria-live="polite" aria-atomic="true" className="text-sm">{status}</p>
      <p className="mt-2 text-sm text-[var(--color-arco-muted)]">Signing in does not authorize a transaction.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {!signedIn && <button type="button" className={button} disabled={!host.canSignIn} aria-describedby={description} onClick={() => { void host.signIn() }}>{pending ? "Signing in…" : failed ? "Retry Stocks sign-in" : "Sign in to Stocks"}</button>}
        {(signedIn || pending) && <button type="button" className={button} onClick={host.logout}>{pending ? "Cancel sign-in" : "Sign out of Stocks"}</button>}
      </div>
    </section>
  )
}
