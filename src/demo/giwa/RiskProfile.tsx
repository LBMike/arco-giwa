// The Risk profile meter in the funds list (Figma 3:2): a pill of three bars, lit by the fund's tier (low 1, medium 2,
// high 3). Pointing at it, or focusing it, names the tier and the fund's main risks; Escape hides them. From the `sm`
// breakpoint the note opens under the meter; on a phone the meter is static, so the note opens across its row
// (the nearest positioned ancestor) instead of running off the screen.

import { useEffect, useId, useState } from "react"
import { RISK_LABEL, type RiskLevel } from "./RiskTag"

const LIT_BARS: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 }

const LIT_COLOR: Record<RiskLevel, string> = {
  low: "bg-[var(--color-risk-meter-low)]",
  medium: "bg-[var(--color-risk-meter-medium)]",
  high: "bg-[var(--color-risk-meter-high)]",
}

export function RiskProfile({ level, risks }: { level: RiskLevel; risks: readonly string[] }) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  const [pointed, setPointed] = useState(false)
  const lit = LIT_BARS[level]

  // Escape also hides a note opened by pointing, while the pointer stays on the meter.
  useEffect(() => {
    if (!pointed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [pointed])

  return (
    <span
      className="group/risk inline-flex sm:relative"
      onMouseEnter={() => setPointed(true)}
      onMouseLeave={() => {
        setPointed(false)
        setDismissed(false)
      }}
    >
      <button
        type="button"
        data-risk={level}
        aria-label={RISK_LABEL[level]}
        aria-describedby={id}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !dismissed) {
            event.stopPropagation()
            setDismissed(true)
          }
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
      <span
        id={id}
        role="tooltip"
        className={`invisible absolute inset-x-3 top-full z-30 mt-1 rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] px-3 py-2.5 text-left text-xs font-normal leading-[18px] text-[var(--color-arco-on-dark)] opacity-0 transition-[opacity,visibility] duration-150 motion-reduce:transition-none sm:inset-x-auto sm:left-0 sm:w-max sm:max-w-[280px] ${
          dismissed ? "" : "group-focus-within/risk:visible group-focus-within/risk:opacity-100 group-hover/risk:visible group-hover/risk:opacity-100"
        }`}
      >
        <span className="block font-medium">{RISK_LABEL[level]}</span>
        <span className="mt-1 block space-y-1">
          {risks.map((risk) => (
            <span key={risk} className="block">
              {risk}
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}
