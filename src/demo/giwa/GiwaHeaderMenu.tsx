import { type ReactNode, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation, useNavigate } from "react-router-dom"
import { Menu, X } from "lucide-react"
import { GIWA_ADMIN_ROUTE, GIWA_PORTFOLIO_ROUTE, GIWA_PREPROD_ROUTE, GIWA_SAVINGS_ROUTE } from "./routes"
import { GIWA_FOOTER_LINKS } from "./footer-links"

// Mobile-only (lg:hidden) header menu: a hamburger that opens a slide-up bottom sheet with the
// nav (hidden in the header below lg), the test-funds action (moved here on mobile), and the
// footer links. Sheet mechanics mirror GiwaInvestDock (open/visible state, rAF slide-up, backdrop
// tap-to-dismiss, body-scroll lock, role=dialog aria-modal, X close, safe-area). Desktop (>= lg)
// header is unchanged — this whole component renders nothing visible there.
const SLIDE_MS = 300
// calc(env(...)) needs real spaces, so apply via inline style (Tailwind arbitrary values escape them).
const SAFE_AREA_PB = "calc(env(safe-area-inset-bottom) + 0.75rem)"

export function GiwaHeaderMenu({ isAdmin, testFunds }: { isAdmin: boolean; testFunds?: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  // Body-scroll lock while the sheet is mounted.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Force-close on route change (browser back while open; also unifies the nav-tap path). A
  // no-op on mount and while already closed.
  useEffect(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpen(false)
    setVisible(false)
  }, [pathname])

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  function close() {
    setVisible(false) // slide down + fade
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      closeTimer.current = null
    }, SLIDE_MS)
  }

  const navItems = [
    { label: "Savings", to: GIWA_SAVINGS_ROUTE, active: pathname.startsWith(GIWA_SAVINGS_ROUTE) },
    { label: "Products", to: GIWA_PREPROD_ROUTE, active: pathname === GIWA_PREPROD_ROUTE },
    { label: "Portfolio", to: GIWA_PORTFOLIO_ROUTE, active: pathname.startsWith(GIWA_PORTFOLIO_ROUTE) },
    ...(isAdmin ? [{ label: "Admin", to: GIWA_ADMIN_ROUTE, active: pathname.startsWith(GIWA_ADMIN_ROUTE) }] : []),
  ]

  return (
    <div className="lg:hidden">
      {/* Hamburger trigger */}
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex size-9 items-center justify-center rounded-md text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)]"
      >
        <Menu className="size-5" />
      </button>

      {open && createPortal(
        // Portal to <body>: the header's backdrop-blur creates a containing block, which would trap
        // a position:fixed sheet inside the ~76px header. Re-wrap in `arco-demo` so the theme tokens
        // (scoped to .arco-demo, which we've just escaped) still resolve.
        <div className="arco-demo">
        {/* lg:hidden here too: the sheet is portaled OUT of the lg:hidden trigger wrapper, so it
            needs its own guard to vanish at >= lg (e.g. opened on mobile, then resized to desktop). */}
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          {/* Backdrop — tap to dismiss */}
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className={`absolute inset-0 bg-[var(--color-arco-overlay)] transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
          />
          {/* Sheet */}
          <div
            className={`absolute inset-x-0 bottom-0 flex max-h-[90vh] flex-col rounded-t-[var(--radius-strategy)] bg-[var(--color-arco-page)] transition-transform duration-300 ${
              visible ? "translate-y-0" : "translate-y-full"
            }`}
            style={{ boxShadow: "var(--shadow-control)" }}
          >
            {/* Logo + title + close */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-arco-border)] px-4 py-3">
              <div className="flex items-center gap-2">
                <img src="/arco-icon.svg" alt="Arco" className="h-[26px] w-[28px] shrink-0" />
                <span className="text-sm font-medium text-[var(--color-arco-ink)]">Menu</span>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-arco-muted)] hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-4" style={{ paddingBottom: SAFE_AREA_PB }}>
              {/* Nav — tap navigates; the route-change effect closes the sheet */}
              <nav className="flex flex-col py-2">
                {navItems.map((item) => (
                  <button
                    key={item.to}
                    type="button"
                    onClick={() => navigate(item.to)}
                    className={`py-3 text-left text-lg ${
                      item.active ? "font-medium text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>

              {/* Test-funds action (moved into the sheet on mobile) */}
              {testFunds && <div className="border-t border-[var(--color-arco-border)] py-4">{testFunds}</div>}

              {/* Footer links */}
              <div className="flex flex-col gap-3 border-t border-[var(--color-arco-border)] py-4">
                {GIWA_FOOTER_LINKS.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    className="text-sm text-[var(--color-arco-muted)] transition-colors hover:text-[var(--color-arco-ink)]"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
