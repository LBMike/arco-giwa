// The Risk profile in the funds list. The meter is Figma 3:2: a pill of three bars, lit by the fund's tier (low 1,
// medium 2, high 3). It opens the fund's risk after app.sky.money/earn: "Risk profile", the tier, a three-part bar, a
// short account of the risk, Exposure / Liquidation risk / Withdrawals, and "Learn more about risk" (Arco's page on
// user risks).
//
// From the `sm` breakpoint it is a card under the meter: a mouse opens it by pointing and it stays open while the
// pointer moves onto it (so the link can be used); Enter / Space toggles it; Escape, a press elsewhere or focus leaving
// closes it. Where the window has no room below and more above (the last rows), it opens upwards. Closed, it takes no
// space. On a phone a tap opens it as a bottom sheet (BottomSheet), closed by its Close button, the backdrop or Escape.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ArrowUpRight } from "lucide-react"
import { BottomSheet } from "./BottomSheet"
import { FUNDS_RISK_DOC, type FundRiskProfile } from "./funds-lineup"
import type { RiskLevel } from "./RiskTag"

const LIT_BARS: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 }

const TIER: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" }

const LIT_COLOR: Record<RiskLevel, string> = {
  low: "bg-[var(--color-risk-meter-low)]",
  medium: "bg-[var(--color-risk-meter-medium)]",
  high: "bg-[var(--color-risk-meter-high)]",
}

const MUTED = "text-[var(--color-arco-chip-ink)]"
const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const CLOSE_DELAY_MS = 120
const SM_QUERY = "(min-width: 640px)"

/** The card under the meter from `sm`; below it, the bottom sheet. Without matchMedia (tests, old browsers): the card. */
function wideViewport(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(SM_QUERY).matches
}

export function RiskProfile({ profile }: { profile: FundRiskProfile }) {
  const { level } = profile
  const id = useId()
  const panelId = `${id}-panel`
  const titleId = `${id}-title`
  const [open, setOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [above, setAbove] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // How the last press started: a mouse click on an already-pointed meter keeps the card open instead of toggling it.
  const pressedWith = useRef<string | null>(null)
  const lit = LIT_BARS[level]

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  // While the card is open: Escape closes it (and returns focus to the meter), and a press outside closes it.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      if (rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus()
    }
    const onPress = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPress)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPress)
    }
  }, [open])

  useEffect(() => cancelClose, [])

  // Before the open card is painted: upwards when it would run past the bottom of the window and there is more room above.
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !rootRef.current) return
    const anchor = (rootRef.current.closest("li") ?? rootRef.current).getBoundingClientRect()
    const height = panelRef.current.offsetHeight
    const below = window.innerHeight - anchor.bottom
    setAbove(below < height && anchor.top > below)
  }, [open])

  return (
    <span
      ref={rootRef}
      data-open={open}
      className="relative inline-flex"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || !wideViewport()) return
        cancelClose()
        setOpen(true)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return
        cancelClose()
        closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-risk={level}
        aria-label={`Risk profile: ${TIER[level]}`}
        aria-expanded={open || sheetOpen}
        aria-controls={panelId}
        onPointerDown={(event) => {
          pressedWith.current = event.pointerType
        }}
        onClick={(event) => {
          event.stopPropagation()
          const mouse = pressedWith.current === "mouse"
          pressedWith.current = null
          if (!wideViewport()) {
            setOpen(false)
            setSheetOpen(true)
            return
          }
          setOpen((current) => (mouse ? true : !current))
        }}
        className="inline-flex h-6 items-center rounded-[var(--radius-pill)] px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-arco-ink)]"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-[15px] items-center gap-px rounded-[var(--radius-pill)] border border-[var(--color-risk-meter-line)] bg-[var(--color-risk-meter-fill)] px-[5px]"
        >
          {[0, 1, 2].map((bar) => (
            <span
              key={bar}
              data-lit={bar < lit ? "true" : "false"}
              className={`h-[3px] w-2 rounded-[2px] ${bar < lit ? LIT_COLOR[level] : "bg-[var(--color-risk-meter-off)]"}`}
            />
          ))}
        </span>
      </button>

      {/* The padding bridges the gap, so the pointer can move from the meter onto the card. */}
      <span
        ref={panelRef}
        id={panelId}
        role="group"
        aria-labelledby={titleId}
        hidden={!open}
        className={`absolute left-1/2 z-30 w-[300px] -translate-x-1/2 ${above ? "bottom-full pb-2" : "top-full pt-2"}`}
      >
        <span className="block rounded-[20px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-5 text-left text-[var(--color-arco-ink)] shadow-[var(--shadow-savings-popover)]">
          <span className={`block text-xs ${MUTED}`}>Risk profile</span>
          <span id={titleId} className="mt-0.5 block text-lg font-medium leading-6">
            {TIER[level]}
          </span>
          <RiskDetails profile={profile} />
          <a
            href={FUNDS_RISK_DOC}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className={`mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-arco-border)] pt-4 text-sm font-medium hover:underline ${FOCUS_RING}`}
          >
            Learn more about risk
            <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
          </a>
        </span>
      </span>

      <BottomSheet id={`${id}-sheet`} open={sheetOpen} onClose={() => setSheetOpen(false)} label="Risk profile" returnFocusTo={buttonRef}>
        <div className="px-2 pb-2 text-left text-[var(--color-arco-ink)]" data-testid="risk-sheet">
          <p className="text-2xl font-medium leading-8">{TIER[level]}</p>
          <RiskDetails profile={profile} />
          <a
            href={FUNDS_RISK_DOC}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-6 flex min-h-12 items-center justify-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-5 text-base font-medium hover:bg-[var(--color-arco-chip)] ${FOCUS_RING}`}
          >
            Learn more about risk
            <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
          </a>
        </div>
      </BottomSheet>
    </span>
  )
}

/** The bar, the account of the risk and the three facts: the same in the card and the sheet. */
function RiskDetails({ profile }: { profile: FundRiskProfile }) {
  const lit = LIT_BARS[profile.level]
  return (
    <>
      <span aria-hidden="true" className="mt-3 flex gap-1">
        {[0, 1, 2].map((bar) => (
          <span
            key={bar}
            data-segment={bar < lit ? "lit" : "off"}
            className={`h-1 flex-1 rounded-[var(--radius-pill)] ${bar < lit ? LIT_COLOR[profile.level] : "bg-[var(--color-risk-meter-off)]"}`}
          />
        ))}
      </span>
      <span className={`mt-4 block text-sm leading-[22px] ${MUTED}`}>{profile.summary}</span>
      <span className="mt-4 block space-y-2 border-t border-[var(--color-arco-border)] pt-4 text-sm">
        <Fact label="Exposure" value={profile.exposure} />
        <Fact label="Liquidation risk" value={profile.liquidation} />
        <Fact label="Withdrawals" value={profile.withdrawals} />
      </span>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline justify-between gap-4">
      <span className={MUTED}>{label}</span>
      <span className="text-right font-medium">{value}</span>
    </span>
  )
}
