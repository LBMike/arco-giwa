// The Risk profile in the funds list. The meter is Figma 3:2: a pill of three bars, lit by the fund's tier (low 1,
// medium 2, high 3). It opens a card after app.sky.money/earn: "Risk profile", the tier, a three-part bar, a short
// account of the risk, Exposure / Liquidation risk / Withdrawals, and a link to the fund's own risk document.
//
// A mouse opens it by pointing and it stays open while the pointer moves onto the card (so the link can be used); a
// tap, or Enter / Space on the focused meter, toggles it; Escape, a click elsewhere or focus leaving it closes it.
// From the `sm` breakpoint the card opens under the meter; on a phone the meter is static, so the card opens across its
// row (the nearest positioned ancestor) instead of running off the screen. Where the window has no room below and more
// above (the last rows), it opens upwards. Closed, it takes no space, so it never lengthens the page.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ArrowUpRight } from "lucide-react"
import type { FundRiskProfile } from "./funds-lineup"
import type { RiskLevel } from "./RiskTag"

const LIT_BARS: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 }

const TIER: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" }

const LIT_COLOR: Record<RiskLevel, string> = {
  low: "bg-[var(--color-risk-meter-low)]",
  medium: "bg-[var(--color-risk-meter-medium)]",
  high: "bg-[var(--color-risk-meter-high)]",
}

const ON_DARK_MUTED = "text-[var(--color-savings-on-hero-muted)]"
const CLOSE_DELAY_MS = 120

export function RiskProfile({ profile }: { profile: FundRiskProfile }) {
  const { level } = profile
  const id = useId()
  const panelId = `${id}-panel`
  const titleId = `${id}-title`
  const [open, setOpen] = useState(false)
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

  // While open: Escape closes (and returns focus to the meter), and a press outside closes.
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
      className="inline-flex sm:relative"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return
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
        aria-expanded={open}
        aria-controls={panelId}
        onPointerDown={(event) => {
          pressedWith.current = event.pointerType
        }}
        onClick={(event) => {
          event.stopPropagation()
          const mouse = pressedWith.current === "mouse"
          pressedWith.current = null
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
        className={`absolute inset-x-3 z-30 sm:inset-x-auto sm:left-1/2 sm:w-[300px] sm:-translate-x-1/2 ${
          above ? "bottom-full pb-2" : "top-full pt-2"
        }`}
      >
        <span className="block rounded-[20px] bg-[var(--color-arco-ink)] p-5 text-left text-[var(--color-arco-on-dark)] shadow-[var(--shadow-savings-popover)]">
          <span className={`block text-xs ${ON_DARK_MUTED}`}>Risk profile</span>
          <span id={titleId} className="mt-0.5 block text-lg font-medium leading-6">
            {TIER[level]}
          </span>
          <span aria-hidden="true" className="mt-3 flex gap-1">
            {[0, 1, 2].map((bar) => (
              <span
                key={bar}
                data-segment={bar < lit ? "lit" : "off"}
                className={`h-1 flex-1 rounded-[var(--radius-pill)] ${bar < lit ? LIT_COLOR[level] : "bg-[var(--color-savings-on-hero-line)]"}`}
              />
            ))}
          </span>
          <span className={`mt-4 block text-sm leading-[22px] ${ON_DARK_MUTED}`}>{profile.summary}</span>
          <span className="mt-4 block space-y-2 border-t border-[var(--color-savings-on-hero-line)] pt-4 text-sm">
            <Fact label="Exposure" value={profile.exposure} />
            <Fact label="Liquidation risk" value={profile.liquidation} />
            <Fact label="Withdrawals" value={profile.withdrawals} />
          </span>
          <a
            href={profile.learnMore.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-savings-on-hero-line)] pt-4 text-sm font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-on-dark)]"
          >
            Learn more about risk
            <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
          </a>
        </span>
      </span>
    </span>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline justify-between gap-4">
      <span className={ON_DARK_MUTED}>{label}</span>
      <span className="text-right font-medium">{value}</span>
    </span>
  )
}
