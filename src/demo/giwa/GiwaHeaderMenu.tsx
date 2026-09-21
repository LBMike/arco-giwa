import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router-dom"
import { Menu, X } from "lucide-react"
import { GIWA_FOOTER_LINKS } from "./footer-links"
import { GiwaSidebarNav } from "./GiwaSidebarNav"

// Below-xl menu: a trigger in the top bar that opens a modal LEFT drawer with the shell nav (the
// desktop sidebar is hidden below xl), the test-funds action (below lg) and the footer links.
// Keyboard: focus moves to Close on open, Tab/Shift+Tab stay inside, Escape closes, focus returns to
// the trigger. Also closes on route change, on backdrop tap, and when the viewport reaches xl.
const SLIDE_MS = 300
const XL_QUERY = "(min-width: 1280px)"
// calc(env(...)) needs real spaces, so apply via inline style (Tailwind arbitrary values escape them).
const SAFE_AREA_PB = "calc(env(safe-area-inset-bottom) + 1rem)"
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

function isOtherLayer(element: Element) {
  return element.shadowRoot !== null || element.closest('[aria-modal="true"], [role="dialog"]') !== null
}

export function GiwaHeaderMenu({ isAdmin, testFunds }: { isAdmin: boolean; testFunds?: ReactNode }) {
  const { pathname } = useLocation()
  const dialogId = useId()
  // open = requested state; mounted keeps the portal through the slide-out; visible drives the slide.
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  const close = useCallback(() => setOpen(false), [])

  function show() {
    setMounted(true)
    setOpen(true)
  }

  // Open: focus Close, slide in on the next frame. Close: slide out, return focus to the trigger
  // (only after an actual open, never on mount or on a route change while closed), then unmount.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      closeRef.current?.focus({ preventScroll: true })
      const raf = window.requestAnimationFrame(() => setVisible(true))
      return () => window.cancelAnimationFrame(raf)
    }
    setVisible(false)
    if (!wasOpen.current) return
    wasOpen.current = false
    triggerRef.current?.focus({ preventScroll: true })
    // At xl the trigger is display:none and cannot take focus; hand it to the main landmark instead.
    if (document.activeElement !== triggerRef.current) document.getElementById("giwa-main")?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setMounted(false), SLIDE_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  // Body-scroll lock while open.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Close on route change (nav tap, browser back). A no-op while closed.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // The drawer is xl:hidden; close it when the viewport reaches xl so no invisible trap stays active.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return
    const query = window.matchMedia(XL_QUERY)
    if (query.matches) {
      setOpen(false)
      return
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false)
    }
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [open])

  // Escape + focus trap. Document-level so it also applies when focus has fallen to <body>. Keys that
  // belong to another layer opened on top (e.g. a wallet sign-in modal started from the drawer's test-funds
  // action, often inside a shadow root) are left alone.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      const drawer = drawerRef.current
      const current = document.activeElement
      if (drawer && current && current !== document.body && !drawer.contains(current) && isOtherLayer(current)) return
      if (event.key === "Escape") {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== "Tab" || !drawer) return
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const inside = active !== null && drawer.contains(active)
      const atEdge = event.shiftKey ? active === first : active === last
      if (!inside || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open])

  return (
    <div className="xl:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={show}
        className={`inline-flex size-11 items-center justify-center rounded-md text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)] ${FOCUS_RING}`}
      >
        <Menu aria-hidden="true" className="size-5" />
      </button>

      {mounted &&
        createPortal(
          // Portal to <body>: the header's backdrop-blur creates a containing block that would trap a
          // position:fixed drawer inside the 76px bar. Re-wrap in `arco-demo` so the scoped theme
          // tokens resolve, and guard with xl:hidden (the portal escapes the trigger's wrapper).
          <div className="arco-demo xl:hidden">
            <div
              aria-hidden="true"
              onClick={close}
              className={`fixed inset-0 z-50 bg-[var(--color-arco-overlay)] transition-opacity duration-300 motion-reduce:transition-none ${
                visible ? "opacity-100" : "opacity-0"
              }`}
            />
            <div
              ref={drawerRef}
              id={dialogId}
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className={`fixed inset-y-0 left-0 z-50 flex w-[min(300px,86vw)] flex-col border-r border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] transition-transform duration-300 motion-reduce:transition-none ${
                visible ? "translate-x-0" : "-translate-x-full"
              }`}
              style={{ boxShadow: "var(--shadow-control)" }}
            >
              <div className="flex min-h-[76px] shrink-0 items-center justify-between border-b border-[var(--color-arco-border)] pl-6 pr-3">
                <div className="flex items-center gap-2">
                  <img src="/arco-icon.svg" alt="Arco" className="h-[26px] w-[28px] shrink-0" />
                  <span className="text-sm font-medium text-[var(--color-arco-ink)]">Menu</span>
                </div>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={close}
                  aria-label="Close menu"
                  className={`inline-flex size-11 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-arco-muted)] hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)] ${FOCUS_RING}`}
                >
                  <X aria-hidden="true" className="size-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-3 pt-4" style={{ paddingBottom: SAFE_AREA_PB }}>
                {/* Tapping the current page's link changes no route, so close explicitly as well. */}
                <GiwaSidebarNav isAdmin={isAdmin} onNavigate={close} />

                {testFunds && (
                  <div className="mt-4 border-t border-[var(--color-arco-border)] px-3 py-4 lg:hidden">{testFunds}</div>
                )}

                <div className="mt-4 flex flex-col gap-3 border-t border-[var(--color-arco-border)] px-3 py-4">
                  {GIWA_FOOTER_LINKS.map((link) => (
                    <a
                      key={link.label}
                      href={link.href}
                      className={`text-sm text-[var(--color-arco-muted)] transition-colors hover:text-[var(--color-arco-ink)] ${FOCUS_RING}`}
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
