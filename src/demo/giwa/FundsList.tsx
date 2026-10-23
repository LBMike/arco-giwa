// The funds list on the Funds page, after ember.so/earn: tabs for All Funds, Credit and Equity, then one rounded row
// per fund with its name (and the kind of fund under it), Risk profile, AUM, APY and network. A row opens the fund;
// AUM and APY sort the list.

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Link } from "react-router-dom"
import { ArrowDown, ArrowUp, ArrowUpDown, ChartCandlestick, ChevronRight, Feather, Sparkles, type LucideIcon } from "lucide-react"
import { FundMark } from "./FundMark"
import { FUNDS_TABS, lineupForTab, nextTabIndex, sortLineup, type FundsTab, type LineupFund, type LineupSort } from "./funds-lineup"
import { RiskProfile } from "./RiskProfile"
import { giwaProductPath } from "./routes"
import { nextSort } from "./sort"

const TAB_ICONS: Record<FundsTab, LucideIcon> = { all: Sparkles, credit: Feather, equity: ChartCandlestick }

// Fund · Risk profile · AUM · APY · Network · chevron. On a phone: fund, risk and APY, at fixed widths so the header
// and the rows line up.
const COLS = "grid-cols-[minmax(0,1fr)_80px_88px] sm:grid-cols-[minmax(220px,2.2fr)_1fr_1fr_1fr_0.7fr_20px]"
const SOFT = "text-[var(--color-arco-chip-ink)]"
const HEAD = `whitespace-nowrap text-sm font-normal ${SOFT}`
const WIDE_ONLY = "hidden sm:flex"

export function FundsList({ funds }: { funds: readonly LineupFund[] }) {
  const [tab, setTab] = useState<FundsTab>("all")
  const [sort, setSort] = useState<LineupSort | null>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const baseId = useId()
  const panelId = `${baseId}-panel`
  const rows = useMemo(() => sortLineup(lineupForTab(tab, funds), sort), [funds, tab, sort])

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, at: number) {
    const next = nextTabIndex(at, event.key)
    if (next === null) return
    event.preventDefault()
    const target = FUNDS_TABS[next]!
    setTab(target.id)
    tabRefs.current[target.id]?.focus()
  }

  return (
    <section aria-labelledby={`${baseId}-title`} className="w-full space-y-6">
      <h2 id={`${baseId}-title`} className="sr-only">
        All funds
      </h2>
      <div role="tablist" aria-label="Fund types" className="-m-1 flex gap-2 overflow-x-auto p-1">
        {FUNDS_TABS.map((entry, at) => {
          const Icon = TAB_ICONS[entry.id]
          const selected = entry.id === tab
          return (
            <button
              key={entry.id}
              ref={(node) => {
                tabRefs.current[entry.id] = node
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${entry.id}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(entry.id)}
              onKeyDown={(event) => onTabKey(event, at)}
              className={`flex min-w-[112px] flex-col items-center gap-2 rounded-[16px] px-4 py-3.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] ${
                selected ? "bg-[var(--color-arco-chip)] text-[var(--color-arco-ink)]" : `${SOFT} hover:text-[var(--color-arco-ink)]`
              }`}
            >
              <Icon aria-hidden="true" className="size-5" />
              {entry.label}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={`${baseId}-tab-${tab}`} data-testid="funds-list">
        <div className={`grid ${COLS} items-center gap-x-4 border-b border-[var(--color-arco-border)] px-5 pb-3`}>
          <span className={HEAD}>Fund</span>
          <span className={HEAD}>Risk profile</span>
          <SortHeader label="AUM" sortKey="aum" sort={sort} onSort={setSort} className={WIDE_ONLY} />
          <SortHeader label="APY" sortKey="apy" sort={sort} onSort={setSort} className="flex justify-end sm:justify-start" />
          <span className={`${HEAD} ${WIDE_ONLY}`}>Network</span>
          <span aria-hidden="true" className={WIDE_ONLY} />
        </div>

        {rows.length === 0 ? (
          <p className={`px-5 py-12 text-center text-sm ${SOFT}`}>No funds of this type yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((entry) => (
              <FundRow key={entry.fund.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string
  sortKey: LineupSort["key"]
  sort: LineupSort | null
  onSort: (next: LineupSort) => void
  className: string
}) {
  const dir = sort?.key === sortKey ? sort.dir : undefined
  const Icon = dir === "desc" ? ArrowDown : dir === "asc" ? ArrowUp : ArrowUpDown
  return (
    <span className={className}>
      <button
        type="button"
        aria-label={dir ? `${label}, sorted ${dir === "desc" ? "high to low" : "low to high"}` : `Sort by ${label}`}
        onClick={() => onSort(sort ? nextSort(sort, sortKey) : { key: sortKey, dir: "desc" })}
        className={`${HEAD} inline-flex items-center gap-1 rounded-[var(--radius-control)] hover:text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]`}
      >
        {label}
        <Icon aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  )
}

function FundRow({ entry }: { entry: LineupFund }) {
  const { fund } = entry
  return (
    <li
      data-testid="fund-row"
      className={`group relative grid ${COLS} min-h-[68px] items-center gap-x-4 rounded-[var(--radius-funds-row)] border border-[var(--color-funds-row-line)] bg-[var(--color-arco-surface)] px-5 py-3 transition-colors hover:bg-[var(--color-funds-row-hover)] has-[a:focus-visible]:outline has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-[var(--color-arco-ink)]`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <FundMark fund={fund} size={40} />
        <div className="min-w-0">
          {/* The name's link covers the whole row; the Risk profile sits above it. */}
          <Link
            to={giwaProductPath(fund.id)}
            className="block truncate text-base font-medium leading-5 text-[var(--color-arco-ink)] outline-none after:absolute after:inset-0 after:rounded-[var(--radius-funds-row)]"
          >
            {fund.symbol}
            <span aria-hidden="true" className="hidden px-1.5 text-[var(--color-arco-chip-ink)] sm:inline">
              ·
            </span>
            {/* On a phone the row is narrow: the symbol shows, the name is still read out. */}
            <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">{fund.name}</span>
          </Link>
          <span className={`mt-0.5 block truncate text-sm leading-5 ${SOFT}`}>{entry.type}</span>
        </div>
      </div>

      {/* A grid item keeps its z-index without being positioned, so on a phone the risk card can open across the row;
          an open card lifts its row above the rows below it. */}
      <div className="z-10 flex justify-self-start hover:z-20 focus-within:z-20 has-[[data-open=true]]:z-30 sm:relative">
        <RiskProfile profile={entry.risk} />
      </div>

      <div className={`${WIDE_ONLY} font-mono text-base text-[var(--color-arco-ink)]`}>
        <span className="sr-only">AUM </span>
        {fund.aum.value}
      </div>

      <div className="flex flex-col items-end sm:items-start">
        <span className="font-mono text-base font-medium text-[var(--color-arco-up-text)]">{fund.metric.value}</span>
        <span className={`text-[11px] leading-4 ${SOFT}`}>{fund.metric.label}</span>
      </div>

      <div className={WIDE_ONLY}>
        <span title="GIWA" className="inline-flex size-5">
          <span className="sr-only">Network </span>
          <img src="/logos/giwa.png" alt="GIWA" width={20} height={20} className="rounded-full object-contain" />
        </span>
      </div>

      <ChevronRight aria-hidden="true" className={`${WIDE_ONLY} size-5 ${SOFT} transition-transform group-hover:translate-x-0.5`} />
    </li>
  )
}
