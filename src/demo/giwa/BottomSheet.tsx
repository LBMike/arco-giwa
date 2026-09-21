import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

// Mobile bottom sheet (below lg): a modal dialog that slides up from the bottom and hosts one piece of content.
// Same keyboard model as the header menu drawer (GiwaHeaderMenu): focus moves to Close on open, Tab/Shift+Tab stay
// inside, Escape closes, keys that belong to another layer opened on top (a wallet modal, often in a shadow root) are
// left alone, and focus returns to the opener (or the main landmark) on close. It closes itself when the viewport
// reaches lg, so no invisible trap or scroll lock stays active. The content is mounted only while the sheet is open
// (plus the slide-out), so a closed sheet renders nothing.
//
// Leaf module: react, react-dom and lucide-react only.

const SLIDE_MS = 300
const LG_QUERY = "(min-width: 1024px)"
// calc(env(...)) needs real spaces, so apply via inline style (Tailwind arbitrary values escape them).
const SAFE_AREA_PB = "calc(env(safe-area-inset-bottom) + 1rem)"
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

function isOtherLayer(element: Element) {
  return element.shadowRoot !== null || element.closest('[aria-modal="true"], [role="dialog"]') !== null
}

/** Focusable and not disabled (a control inside a disabled fieldset has no disabled attribute of its own). */
function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.closest("fieldset[disabled]") === null)
}

export type BottomSheetProps = {
  open: boolean
  /** Called for Close, Escape, a backdrop tap and when the viewport reaches lg. The owner sets `open` to false. */
  onClose: () => void
  /** Accessible name of the dialog, also shown as the sheet's title. */
  label: string
  children: ReactNode
  /** Where focus goes after closing (the control that opened the sheet). Falls back to #giwa-main. */
  returnFocusTo?: RefObject<HTMLElement | null>
  /** Dialog id, for the openers' aria-controls. */
  id?: string
}

export function BottomSheet({ open, onClose, label, children, returnFocusTo, id }: BottomSheetProps) {
  // mounted keeps the portal through the slide-out; visible drives the slide (flipped one frame after mount).
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)
  // Opening mounts the content in the same commit (the opener's click already shows it).
  if (open && !mounted) setMounted(true)
  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  // Latest callbacks, read by the effects below without re-running them (a new function identity must not refocus Close).
  const onCloseRef = useRef(onClose)
  const returnRef = useRef(returnFocusTo)
  useIsomorphicLayoutEffect(() => {
    onCloseRef.current = onClose
    returnRef.current = returnFocusTo
  })

  const returnFocus = useCallback(() => {
    const target = returnRef.current?.current ?? null
    if (target !== null && target.isConnected) target.focus({ preventScroll: true })
    // At lg the opener is gone (or display:none) and cannot take focus; hand it to the main landmark instead.
    if (target === null || document.activeElement !== target) document.getElementById("giwa-main")?.focus({ preventScroll: true })
  }, [])

  // Open: focus Close, slide in on the next frame. Close: slide out, return focus (only after an actual open, and only
  // when focus was in the sheet or has fallen to <body>), then unmount.
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
    const active = document.activeElement
    if (active === null || active === document.body || sheetRef.current?.contains(active)) returnFocus()
    const timer = window.setTimeout(() => setMounted(false), SLIDE_MS)
    return () => window.clearTimeout(timer)
  }, [open, returnFocus])

  // Removed while open (its owner unmounted it): the focused content is gone, so focus falls to <body>. Hand it back.
  useEffect(
    () => () => {
      if (!wasOpen.current) return
      wasOpen.current = false
      const active = document.activeElement
      if (active === null || active === document.body) returnFocus()
    },
    [returnFocus],
  )

  // Body-scroll lock while open.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // The sheet is lg:hidden; close it when the viewport reaches lg so no invisible trap stays active.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return
    const query = window.matchMedia(LG_QUERY)
    if (query.matches) {
      onCloseRef.current()
      return
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) onCloseRef.current()
    }
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [open])

  // Escape + focus trap. Document-level so it also applies when focus has fallen to <body>. Keys that belong to another
  // layer opened on top (e.g. a wallet modal started from the sheet, often inside a shadow root) are left alone.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      const sheet = sheetRef.current
      const current = document.activeElement
      if (sheet && current && current !== document.body && !sheet.contains(current) && isOtherLayer(current)) return
      if (event.key === "Escape") {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab" || !sheet) return
      const focusable = tabbable(sheet)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const inside = current !== null && sheet.contains(current)
      const atEdge = event.shiftKey ? current === first : current === last
      if (!inside || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open])

  if (!mounted || typeof document === "undefined") return null
  return createPortal(
    // Portal to <body>: an ancestor with a transform, filter or backdrop-filter would trap a position:fixed sheet. Re-wrap
    // in `arco-demo` so the scoped theme tokens resolve, and guard with lg:hidden (the portal escapes the page's wrappers).
    <div className="arco-demo lg:hidden">
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-50 bg-[var(--color-arco-overlay)] transition-opacity duration-300 motion-reduce:transition-none ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        ref={sheetRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-[var(--radius-strategy)] bg-[var(--color-arco-page)] transition-transform duration-300 motion-reduce:transition-none ${
          visible ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ boxShadow: "var(--shadow-control)" }}
      >
        <div className="relative flex shrink-0 items-center justify-between gap-3 pb-1 pl-5 pr-2 pt-4">
          <span aria-hidden="true" className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-[var(--radius-pill)] bg-[var(--color-arco-border)]" />
          <p className="min-w-0 truncate text-sm font-medium text-[var(--color-arco-ink)]">{label}</p>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-arco-text-soft)] hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)] ${FOCUS_RING}`}
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3" style={{ paddingBottom: SAFE_AREA_PB }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
