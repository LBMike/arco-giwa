import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { BottomSheet } from "../BottomSheet"
import { INVEST_PANEL_CARD, INVEST_TAB, INVEST_TAB_ACTIVE, INVEST_TAB_INACTIVE, INVEST_TAB_TRACK } from "../invest-panel-ui"
import { useIsDesktop } from "./ui"

export type StockInvestTab = "BUY" | "SELL" | "ORDERS"
const TABS: readonly StockInvestTab[] = ["BUY", "SELL", "ORDERS"]
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

/** Same card, spacing, segmented track and mobile sheet as the GIWA Invest panel. No trading logic here. */
export function StockInvestSurface({ symbol, tab, onTab, children }: { symbol: string; tab: StockInvestTab; onTab: (tab: StockInvestTab) => void; children: ReactNode }) {
  const desktop = useIsDesktop()
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  useEffect(() => {
    if (desktop) { setOpen(false); return }
    const root = document.documentElement
    const previous = root.style.getPropertyValue("--giwa-dock-space")
    root.style.setProperty("--giwa-dock-space", "calc(env(safe-area-inset-bottom) + 4.5rem)")
    return () => { if (previous) root.style.setProperty("--giwa-dock-space", previous); else root.style.removeProperty("--giwa-dock-space") }
  }, [desktop])
  const card = <section aria-label={`${symbol} invest panel`} className={`w-full ${INVEST_PANEL_CARD}`}>
    <div className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2.5 py-1 text-xs text-[var(--color-arco-text-soft)]">
        <img src="/logos/giwa.png" alt="" width={14} height={14} className="rounded-full object-contain" />GIWA
      </span>
      <span className="text-xs font-medium text-[var(--color-arco-text-soft)]">{symbol}</span>
    </div>
    <div role="tablist" aria-label={`${symbol} trading`} className={`mt-3 grid grid-cols-3 ${INVEST_TAB_TRACK}`}>
      {TABS.map((value, index) => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-selected={tab === value} aria-controls={`${id}-body`} tabIndex={tab === value ? 0 : -1} onClick={() => onTab(value)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : null
        if (next === null) return
        event.preventDefault(); onTab(TABS[next]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus()
      }} className={`${INVEST_TAB} ${FOCUS} ${tab === value ? INVEST_TAB_ACTIVE : INVEST_TAB_INACTIVE}`}>{value === "BUY" ? "Buy" : value === "SELL" ? "Sell" : "Orders"}</button>)}
    </div>
    <div id={`${id}-body`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="mt-4 w-full">{children}</div>
  </section>
  if (desktop) return <div className="w-full">{card}</div>
  return <>
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-arco-border)] bg-[var(--color-arco-page-80)] px-4 pt-3 backdrop-blur" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
      <div className="mx-auto flex w-full max-w-[var(--container-page)] gap-3">
        {(["BUY", "SELL"] as const).map(side => <button key={side} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-sheet`} onClick={event => { opener.current = event.currentTarget; onTab(side); setOpen(true) }} className={`flex-1 rounded-[var(--radius-card)] py-3 text-sm font-medium ${FOCUS} ${side === "BUY" ? "border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]" : "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]"}`}>{side === "BUY" ? "Buy" : "Sell"}</button>)}
      </div>
    </div>
    <BottomSheet id={`${id}-sheet`} open={open} onClose={() => setOpen(false)} label={`Trade ${symbol}`} returnFocusTo={opener}>{card}</BottomSheet>
  </>
}
