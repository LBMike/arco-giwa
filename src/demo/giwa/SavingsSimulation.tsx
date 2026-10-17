// The Simulation section: an initial and a recurring deposit, what they would earn at today's APY over five years, and
// the earnings curve. Pointing at the curve (or the arrow keys on it) shows the figures for that month.

import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { SavingsInfoTip } from "./SavingsInfoTip"
import { addMonths, groupDigits, horizonLong, horizonShort, monthLabel, usd, usdCompact } from "./savings-format"
import { DEPOSIT_FREQUENCIES, SIMULATION_YEARS, niceTicks, simulateSavings, type DepositFrequency } from "./savings-simulation"
import { sanitizeAmountInput } from "./savings-transfer"

const PLOT_W = 1000
const PLOT_H = 300
const PLOT_TOP = 12
const FIELD =
  "flex min-h-11 items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] pl-4 pr-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-[var(--color-arco-ink)]"

function MoneyField({
  label,
  info,
  value,
  onChange,
  trailing,
}: {
  label: string
  info: string
  value: string
  onChange: (value: string) => void
  trailing?: ReactNode
}) {
  const id = useId()
  // Thousands separators only while the field is not being typed in: a typed comma may be a decimal comma.
  const [focused, setFocused] = useState(false)
  return (
    <div className="min-w-0">
      <span className="flex items-center gap-1 pb-1.5 pl-1 text-[13px] text-[var(--color-arco-text-soft)]">
        <label htmlFor={id}>{label}</label>
        <SavingsInfoTip label={`About ${label.toLowerCase()}`} text={info} />
      </span>
      <div className={FIELD}>
        <span aria-hidden="true" className="text-sm text-[var(--color-arco-text-soft)]">
          $
        </span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={focused ? value : groupDigits(value)}
          placeholder="0"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(sanitizeAmountInput(event.target.value, 2))}
          className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]"
        />
        {trailing}
      </div>
    </div>
  )
}

const amountOf = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function SavingsSimulation({
  apyPercent,
  startingBalance,
  maxDeposit,
}: {
  apyPercent: number | null
  /** The savings balance already held (USD); 0 before a wallet is connected. */
  startingBalance: number
  /** What MAX fills in (the wallet's coins in USD), or null to hide MAX. */
  maxDeposit: number | null
}) {
  const [initial, setInitial] = useState("1000")
  const [recurring, setRecurring] = useState("500")
  const [frequency, setFrequency] = useState<DepositFrequency>("monthly")
  const [hover, setHover] = useState<number | null>(null)
  // Said aloud only when the month is moved with the keyboard, never on pointer moves.
  const [spoken, setSpoken] = useState("")
  const [start] = useState(() => new Date())
  const plotRef = useRef<HTMLDivElement>(null)
  const frequencyId = useId()
  const gradientId = useId()
  const clipId = useId()
  const hintId = useId()

  const points = useMemo(
    () =>
      simulateSavings({
        apyPercent: apyPercent ?? 0,
        startingBalance,
        initialDeposit: amountOf(initial),
        recurringDeposit: amountOf(recurring),
        frequency,
        years: SIMULATION_YEARS,
      }),
    [apyPercent, startingBalance, initial, recurring, frequency],
  )
  const lastMonth = points.length - 1
  const final = points[lastMonth]!
  const shown = hover !== null ? points[hover]! : final
  const horizon = hover !== null ? horizonShort(hover) : horizonLong(SIMULATION_YEARS)
  const known = apyPercent !== null

  const ticks = niceTicks(Math.max(final.earned, 1), 6)
  const yMax = ticks[ticks.length - 1]! || 1
  const xOf = (month: number) => (month / lastMonth) * PLOT_W
  const yOf = (earned: number) => PLOT_TOP + (1 - Math.max(0, earned) / yMax) * (PLOT_H - PLOT_TOP)
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xOf(point.month).toFixed(1)} ${yOf(point.earned).toFixed(1)}`).join(" ")
  const area = `${line} L${PLOT_W} ${PLOT_H} L0 ${PLOT_H} Z`
  const hoverX = hover !== null ? xOf(hover) : PLOT_W

  function monthAt(clientX: number): number | null {
    const box = plotRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return null
    const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return Math.max(1, Math.round(fraction * lastMonth))
  }
  function onPointer(event: PointerEvent<HTMLDivElement>) {
    setHover(monthAt(event.clientX))
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const current = hover ?? lastMonth
    const next =
      event.key === "ArrowLeft" ? current - 1 : event.key === "ArrowRight" ? current + 1 : event.key === "Home" ? 1 : event.key === "End" ? lastMonth : null
    if (next === null) return
    event.preventDefault()
    const month = Math.min(lastMonth, Math.max(1, next))
    const point = points[month]!
    setHover(month)
    setSpoken(`${monthLabel(addMonths(start, month))}: earn ${usd(point.earned)}, balance ${usd(point.balance)}`)
  }

  return (
    <div className="w-full">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)] lg:items-end">
        <MoneyField
          label="Initial deposit"
          info="What you would put in today."
          value={initial}
          onChange={setInitial}
          trailing={
            maxDeposit !== null && maxDeposit > 0 ? (
              <button
                type="button"
                onClick={() => setInitial(String(Math.floor(maxDeposit * 100) / 100))}
                className="inline-flex min-h-8 items-center rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)] px-2.5 text-[11px] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)] hover:bg-[var(--color-arco-page)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
              >
                MAX
              </button>
            ) : null
          }
        />
        <MoneyField
          label="Recurring deposit"
          info="What you would add on a schedule."
          value={recurring}
          onChange={setRecurring}
          trailing={
            <span className="relative inline-flex">
              <label htmlFor={frequencyId} className="sr-only">
                How often
              </label>
              <select
                id={frequencyId}
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as DepositFrequency)}
                className="min-h-8 appearance-none rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)] pl-2.5 pr-7 text-[11px] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
              >
                {DEPOSIT_FREQUENCIES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-[var(--color-arco-text-soft)]" />
            </span>
          }
        />
        <div className="grid grid-cols-2 rounded-[16px] border border-[var(--color-arco-border)]">
          <div className="min-w-0 px-4 py-3">
            <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-arco-text-soft)]">
              <span aria-hidden="true" className="size-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-up)]" />
              Earn over {horizon}
            </p>
            <p className="mt-0.5 truncate text-xl font-medium tabular-nums text-[var(--color-arco-ink)]">{known ? usd(shown.earned) : "—"}</p>
          </div>
          <div className="min-w-0 border-l border-[var(--color-arco-border)] px-4 py-3">
            <p className="text-[13px] text-[var(--color-arco-text-soft)]">Balance in {horizon}</p>
            <p className="mt-0.5 truncate text-xl font-medium tabular-nums text-[var(--color-arco-ink)]">{known ? usd(shown.balance) : "—"}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-[16px] bg-[var(--color-arco-page)] px-3 pb-3 pt-4 sm:px-4">
        {!known ? (
          <p className="flex h-[220px] items-center justify-center text-sm text-[var(--color-arco-text-soft)]">The APY is not known yet.</p>
        ) : (
          <>
            <div className="flex gap-2">
              <div
                ref={plotRef}
                tabIndex={0}
                role="group"
                aria-label={`Projected earnings over ${horizonLong(SIMULATION_YEARS)}`}
                aria-describedby={hintId}
                onPointerMove={onPointer}
                onPointerDown={onPointer}
                onPointerLeave={() => setHover(null)}
                onKeyDown={onKey}
                onBlur={() => setHover(null)}
                className="relative h-[200px] min-w-0 flex-1 touch-pan-y outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-arco-ink)] sm:h-[260px]"
              >
                <span id={hintId} className="sr-only">
                  Use the left and right arrow keys to see each month.
                </span>
                <span className="sr-only" aria-live="polite" aria-atomic="true">
                  {spoken}
                </span>
                <svg aria-hidden="true" viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-savings-earn-area)" />
                      <stop offset="100%" stopColor="var(--color-savings-earn-area)" stopOpacity={0} />
                    </linearGradient>
                    <clipPath id={clipId}>
                      <rect x={0} y={-PLOT_TOP} width={hoverX} height={PLOT_H + PLOT_TOP * 2} />
                    </clipPath>
                  </defs>
                  {ticks.map((tick) => (
                    <line
                      key={tick}
                      x1={0}
                      x2={PLOT_W}
                      y1={yOf(tick)}
                      y2={yOf(tick)}
                      stroke="var(--color-arco-border)"
                      strokeDasharray="4 6"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <path d={area} fill={`url(#${gradientId})`} clipPath={`url(#${clipId})`} />
                  <path d={line} fill="none" stroke="var(--color-arco-up)" strokeOpacity={0.3} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <path d={line} fill="none" stroke="var(--color-arco-up)" strokeWidth={1.5} clipPath={`url(#${clipId})`} vectorEffect="non-scaling-stroke" />
                </svg>
                {hover !== null && (
                  <>
                    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-[var(--color-arco-ink-40)]" style={{ left: `${(hover / lastMonth) * 100}%` }} />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-pill)] bg-[var(--color-arco-up)] ring-2 ring-[var(--color-arco-surface)]"
                      style={{ left: `${(hover / lastMonth) * 100}%`, top: `${(yOf(points[hover]!.earned) / PLOT_H) * 100}%` }}
                    />
                  </>
                )}
              </div>
              <div aria-hidden="true" className="relative h-[200px] w-12 shrink-0 sm:h-[260px]">
                {ticks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute right-0 -translate-y-1/2 text-[11px] tabular-nums text-[var(--color-arco-muted)]"
                    style={{ top: `${(yOf(tick) / PLOT_H) * 100}%` }}
                  >
                    {usdCompact(tick)}
                  </span>
                ))}
              </div>
            </div>
            <div aria-hidden="true" className="relative mr-14 mt-2 h-6">
              {Array.from({ length: SIMULATION_YEARS + 1 }, (_, year) => (
                <span
                  key={year}
                  className={`absolute top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-[var(--color-arco-muted)] ${
                    year === 0 ? "" : year === SIMULATION_YEARS ? "-translate-x-full" : "-translate-x-1/2"
                  }`}
                  style={{ left: `${(year / SIMULATION_YEARS) * 100}%` }}
                >
                  {start.getFullYear() + year}
                </span>
              ))}
              {hover !== null && (
                <span
                  className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-pill)] bg-[var(--color-arco-ink)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-arco-on-dark)]"
                  style={{ left: `${(hover / lastMonth) * 100}%` }}
                >
                  {monthLabel(addMonths(start, hover))}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
