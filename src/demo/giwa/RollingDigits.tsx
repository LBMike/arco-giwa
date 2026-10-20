// A figure that rolls digit by digit, like an odometer. Each character sits in its own slot, clipped to its box; when
// one changes, the new character slides in from below while the old one leaves through the top as the figure grows
// (the other way as it shrinks). Slots are counted from the right, so the units, the decimal point and the cents keep
// their places when the figure gains a digit. The motion is in theme.css (savings-digit-*) and is instant under
// reduced motion. Decorative: the slots are hidden from screen readers, so put the figure's text beside them.

import { useEffect, useState } from "react"

export type Trend = "up" | "down"

/** Which way `value` last moved: "up" (it grew) until it first shrinks. Unknown values leave the trend as it was. */
export function useTrend(value: number | null): Trend {
  const known = value !== null && Number.isFinite(value) ? value : null
  const [seen, setSeen] = useState<{ value: number | null; trend: Trend }>({ value: known, trend: "up" })
  if (known !== seen.value) {
    const trend: Trend = known !== null && seen.value !== null ? (known < seen.value ? "down" : "up") : seen.trend
    setSeen({ value: known, trend })
    return trend
  }
  return seen.trend
}

type Slot = Readonly<{ char: string; previous: string | null; turn: number; trend: Trend }>

function DigitSlot({ char, trend, enter }: { char: string; trend: Trend; enter: boolean }) {
  // `turn` counts the changes; a new turn remounts both characters so their slide plays from the start.
  const [slot, setSlot] = useState<Slot>({ char, previous: null, turn: enter ? 1 : 0, trend })
  if (slot.char !== char) setSlot({ char, previous: slot.char, turn: slot.turn + 1, trend })
  return (
    <span className="relative inline-block [clip-path:inset(0)]">
      <span key={`in-${slot.turn}`} className={slot.turn > 0 ? `inline-block savings-digit-in-${slot.trend}` : "inline-block"}>
        {slot.char}
      </span>
      {slot.previous !== null && (
        <span
          key={`out-${slot.turn}`}
          className={`absolute inset-0 savings-digit-out-${slot.trend}`}
          onAnimationEnd={() => setSlot((current) => (current.turn === slot.turn ? { ...current, previous: null } : current))}
        >
          {slot.previous}
        </span>
      )}
    </span>
  )
}

/**
 * `text`, one slot per character. Characters that change roll the way `trend` says. With `enter`, the figure also
 * rolls in when it first appears; either way, a slot added later (the figure gained a digit) rolls in.
 */
export function RollingDigits({ text, trend, enter = false }: { text: string; trend: Trend; enter?: boolean }) {
  const [shown, setShown] = useState(false)
  useEffect(() => setShown(true), [])
  const chars = [...text]
  return (
    <span aria-hidden="true" data-rolling-digits="">
      {chars.map((char, index) => (
        <DigitSlot key={chars.length - index} char={char} trend={trend} enter={enter || shown} />
      ))}
    </span>
  )
}
