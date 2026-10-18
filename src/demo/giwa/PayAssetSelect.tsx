// "You pay" token dropdown of the fund invest panel (ArcoRouter buys): USDC, USDT, RLUSD or
// ArcoUSD. It takes the place of the AmountField token chip (AmountField `symbolControl`).
//
// Leaf module: react + lucide-react only. Icons arrive as nodes so this file never imports
// ./components (which renders it) — no import cycle. The menu is portalled to <body> with fixed
// positioning (the amount block around the field clips its overflow), re-wrapped in `arco-demo`
// so the scoped theme tokens and font resolve there too.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"

export type PayAssetSelectOption = {
  readonly key: string
  readonly label: string
  readonly icon?: ReactNode
  /** Right-hand note in the menu (e.g. "No fee", "0.1% fee"). */
  readonly note?: string
}

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

export function PayAssetSelect({
  options,
  selected,
  onSelect,
  label = "Pay with",
  disabled = false,
}: {
  options: readonly PayAssetSelectOption[]
  selected: string | null
  onSelect: (key: string) => void
  label?: string
  /** While a transaction runs the asset cannot change (the panel must keep naming what is in flight). */
  disabled?: boolean
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const open = position !== null
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const focusIndex = useRef(0)
  const current = options.find((option) => option.key === selected) ?? options[0]

  function toggle() {
    const rect = trigger.current?.getBoundingClientRect()
    focusIndex.current = Math.max(0, options.findIndex((option) => option.key === current?.key))
    setPosition(open || !rect ? null : { top: rect.bottom + 6, left: rect.left })
  }

  function close(refocus: boolean) {
    setPosition(null)
    if (refocus) trigger.current?.focus()
  }

  // Close on a press outside the trigger and the menu, and on scroll or resize (the fixed menu
  // would drift from its field).
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close(false)
    }
    const onMove = () => close(false)
    document.addEventListener("mousedown", onPointer)
    window.addEventListener("scroll", onMove, true)
    window.addEventListener("resize", onMove)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      window.removeEventListener("scroll", onMove, true)
      window.removeEventListener("resize", onMove)
    }
  }, [open])

  // Opening moves focus to the selected option — once per opening, so a background refresh of the
  // options never pulls a keyboard user back.
  useEffect(() => {
    if (open) items.current[focusIndex.current]?.focus()
  }, [open])

  if (!current) return null

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const focused = items.current.findIndex((item) => item === document.activeElement)
    if (event.key === "Escape" || event.key === "Tab") {
      // The menu lives at the end of <body>: hand focus back to the trigger rather than lose it.
      event.preventDefault()
      close(true)
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      items.current[(focused + step + options.length) % options.length]?.focus()
    }
  }

  return (
    <div className="shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current.label}`}
        disabled={disabled}
        onClick={toggle}
        className={`inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] py-1 pl-1 pr-2 text-sm font-medium text-[var(--color-arco-ink)] disabled:opacity-60 ${FOCUS_RING}`}
      >
        {current.icon}
        {current.label}
        <ChevronDown className={`size-3.5 text-[var(--color-arco-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {position &&
        createPortal(
        <div className="arco-demo">
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={{ top: position.top, left: position.left }}
          className="fixed z-50 min-w-[200px] rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-1 shadow-[var(--shadow-table)]"
        >
          {options.map((option, index) => {
            const active = option.key === current.key
            return (
              <button
                key={option.key}
                ref={(element) => {
                  items.current[index] = element
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(option.key)
                  close(true)
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-[var(--radius-card)] px-2.5 py-2 text-left text-sm text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)] ${FOCUS_RING}`}
              >
                <span className="inline-flex items-center gap-2">
                  {option.icon}
                  {option.label}
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-arco-muted)]">
                  {option.note}
                  {active && <Check className="size-3.5 text-[var(--color-arco-ink)]" />}
                </span>
              </button>
            )
          })}
        </div>
        </div>,
          document.body,
        )}
    </div>
  )
}
