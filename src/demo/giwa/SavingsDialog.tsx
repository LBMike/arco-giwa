// The overlay the Savings page opens: a centred modal (APY details) or a full screen (deposit / withdraw). Same
// keyboard model as TransactionFlowModal: focus moves in on open and goes back to the opener on close, Tab / Shift+Tab
// stay inside, Escape closes, and keys that belong to a layer opened on top (the wallet's own modal, often in a
// shadow root) are left alone. Portalled to <body> and re-wrapped in `arco-demo` so the theme tokens resolve.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

function isOtherLayer(element: Element): boolean {
  return element.shadowRoot !== null || element.closest('[aria-modal="true"], [role="dialog"]') !== null
}

function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.closest("fieldset[disabled]") === null)
}

export function SavingsDialog({
  open,
  onClose,
  labelledBy,
  variant = "modal",
  size = "regular",
  dismissible = true,
  initialFocus,
  children,
}: {
  open: boolean
  onClose: () => void
  /** id of the visible title. */
  labelledBy: string
  /** "modal": a centred card over a dimmed page. "screen": a full-screen page of its own. */
  variant?: "modal" | "screen"
  /** The modal's width from sm up: "regular" (760px, the Savings dialogs) or "narrow" (440px, a picker). */
  size?: "regular" | "narrow"
  /** A press on the dimmed page closes the modal. */
  dismissible?: boolean
  /** Where focus goes on open; the dialog itself when not given. */
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const onCloseRef = useRef(onClose)
  const initialRef = useRef(initialFocus)
  useIsomorphicLayoutEffect(() => {
    onCloseRef.current = onClose
    initialRef.current = initialFocus
  })

  // Open: remember the opener, move focus in, fade in. Closed or removed: focus goes back to the opener.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const target = initialRef.current?.current ?? dialogRef.current
    target?.focus({ preventScroll: true })
    const raf = window.requestAnimationFrame(() => setVisible(true))
    return () => {
      window.cancelAnimationFrame(raf)
      setVisible(false)
      const active = document.activeElement
      const lost = active === null || active === document.body || !active.isConnected || (dialogRef.current?.contains(active) ?? false)
      if (!lost) return
      for (const candidate of [opener, document.getElementById("giwa-main")]) {
        if (candidate === null || !candidate.isConnected) continue
        candidate.focus({ preventScroll: true })
        if (document.activeElement === candidate) return
      }
    }
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

  // Escape + focus trap, in the capture phase on window. Keys that belong to a layer on top are left alone, and so is an
  // Escape pressed inside a popup of the dialog's own that closes itself first (marked data-escape-layer).
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current
      if (dialog === null) return
      const active = document.activeElement
      if (active !== null && active !== document.body && !dialog.contains(active) && isOtherLayer(active)) return
      if (event.key === "Escape" && active !== null && dialog.contains(active) && active.closest("[data-escape-layer]") !== null) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab") return
      event.stopPropagation()
      const focusable = tabbable(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const inside = active !== null && active !== dialog && dialog.contains(active)
      const atEdge = event.shiftKey ? active === first : active === last
      if (!inside || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open])

  if (!open || typeof document === "undefined") return null

  const fade = `transition-opacity duration-200 ease-out motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`
  return createPortal(
    <div className="arco-demo">
      {variant === "screen" ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          className={`fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-[var(--color-arco-page)] outline-none ${fade}`}
        >
          {children}
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-[60] flex items-end justify-center bg-[var(--color-arco-overlay)] backdrop-blur-[2px] sm:items-center sm:p-4 ${fade}`}
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return
            event.preventDefault()
            if (dismissible) onCloseRef.current()
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            tabIndex={-1}
            className={`max-h-[92vh] w-full overflow-y-auto overscroll-contain rounded-t-[22px] bg-[var(--color-arco-surface)] outline-none transition-transform duration-200 ease-out motion-reduce:transition-none sm:rounded-[22px] ${
              size === "narrow" ? "sm:max-w-[440px]" : "sm:max-w-[760px]"
            } ${visible ? "translate-y-0" : "translate-y-3"}`}
            style={{ boxShadow: "var(--shadow-control)" }}
          >
            {children}
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
