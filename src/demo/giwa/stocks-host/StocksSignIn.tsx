import { useEffect, useId, useLayoutEffect, useRef } from "react"
import { useGiwaStocksHost } from "./StocksHostProvider"
import { signInFailureMessage } from "./sign-in-errors"

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect
const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

/** Compose on the future Stocks surfaces, not on unrelated Savings/Funds pages. */
export function StocksSignIn() {
  const host = useGiwaStocksHost()
  const description = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const focusInside = useRef(false)
  const signedIn = host.snapshot.status === "authenticated"
  const pending = host.snapshot.status === "signing-in"
  const failed = host.snapshot.status === "error" || Boolean(host.snapshot.error)
  // A ready wallet in an error state that still cannot sign in has no host controller: a retry cannot help.
  const hostUnavailable = host.walletStatus === "ready" && host.snapshot.status === "error" && !host.canSignIn
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
                : hostUnavailable ? "Stocks sign-in is not available on this page. Reload the page; if this continues, contact operations."
                  : failed ? signInFailureMessage(host.snapshot.error)
                    : "Sign in to view your Stocks account."
  // Where the user's focus and pointer are. Only a section the user is working in may move focus.
  useEffect(() => {
    const track = (event: Event) => {
      const root = sectionRef.current
      const target = event.target as Node | null
      focusInside.current = root !== null && target !== null && typeof target.nodeType === "number" && root.contains(target)
    }
    for (const type of ["pointerdown", "focusin", "keydown"]) document.addEventListener(type, track, true)
    return () => { for (const type of ["pointerdown", "focusin", "keydown"]) document.removeEventListener(type, track, true) }
  }, [])
  // The activated button unmounts on sign-in, retry, cancel and sign-out, or turns into the disabled "Signing in…" while
  // the signature is pending. Its lost or stranded focus goes to the status text, never to a button, so a following Enter
  // cannot start a wallet signature (the next Tab from there reaches "Cancel sign-in").
  useIsomorphicLayoutEffect(() => {
    if (!focusInside.current) return
    const active = document.activeElement
    const stranded = active !== null && active.tagName === "BUTTON" && (active as HTMLButtonElement).disabled && sectionRef.current?.contains(active) === true
    if (active === null || active === document.body || stranded) statusRef.current?.focus({ preventScroll: true })
  }, [status, signedIn, pending])
  const button = `rounded-lg border border-[var(--color-arco-border)] px-4 py-2 text-sm font-semibold ${focusRing} disabled:cursor-not-allowed disabled:opacity-50`
  return (
    <section ref={sectionRef} aria-label="Stocks sign-in" className="w-full rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 text-[var(--color-arco-ink)]">
      <p ref={statusRef} id={description} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" className={`text-sm ${focusRing}`}>{status}</p>
      <p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">Signing in does not authorize a transaction.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {!signedIn && <button type="button" className={button} disabled={!host.canSignIn} aria-describedby={description} onClick={() => { void host.signIn() }}>{pending ? "Signing in…" : failed && !hostUnavailable ? "Retry Stocks sign-in" : "Sign in to Stocks"}</button>}
        {(signedIn || pending) && <button type="button" className={button} onClick={host.logout}>{pending ? "Cancel sign-in" : "Sign out of Stocks"}</button>}
      </div>
    </section>
  )
}
