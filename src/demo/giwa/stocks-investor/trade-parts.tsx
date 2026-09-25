// Pieces the session trade panel (TradePanel) and the direct trade panel (DirectTrade) share: the GIWA CTA looks, the
// NVDA chip mark and the test-value note.
import type { ReactNode } from "react"
import { DemoDetails } from "../demo-presentation"
import { INVEST_CTA, INVEST_CTA_READY } from "../invest-panel-ui"
import { StockLogo } from "../stocks-market/StockLogo"
import { FOCUS_RING } from "./ui"

export const CTA = `${INVEST_CTA} min-h-11 ${FOCUS_RING}`
export const CTA_READY = `${CTA} ${INVEST_CTA_READY} disabled:cursor-not-allowed`
/** In progress: readable text on the muted surface (the muted text token is for placeholders only). */
export const CTA_BUSY = `${CTA} cursor-progress bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-text-soft)]`
export const CHIP_NOTE = "rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-arco-text-soft)]"
export const FIELD_FOCUS = "focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-[var(--color-arco-ink)]"

/** The NVDA logo at chip size (StockLogo's smallest box, scaled into 20px). Decorative: "NVDA" follows. */
export function NvdaMark() {
  return (
    <span className="inline-flex size-5 shrink-0 [&>span]:size-5 [&>span]:text-[10px]">
      <StockLogo symbol="NVDA" size={32} />
    </span>
  )
}

export function TestNote({ children }: { children: ReactNode }) {
  return <DemoDetails><span className={CHIP_NOTE}>{children}</span></DemoDetails>
}
