import { useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { BreakdownRow, ProductDetailData } from '../data/acapix-detail'
import { aumLabel } from '../data/products'
import { resolveDonutTotal, resolveSliceValue } from '../giwa/display-profile'

// Donut segment palette for the Industry tab (Figma node 40:3523, dark→light).
const DONUT = [
  'var(--color-arco-chart-1)',
  'var(--color-arco-chart-2)',
  'var(--color-arco-chart-3)',
  'var(--color-arco-chart-4)',
  'var(--color-arco-chart-5)',
  'var(--color-arco-chart-6)',
  'var(--color-arco-chart-7)',
  'var(--color-arco-chart-8)',
  'var(--color-arco-chart-9)',
]

// Exposure stacked-bar / dot palette in Figma row order (node 7:229, light→dark).
const EXPOSURE_COLORS = [
  'var(--color-arco-chart-9)',
  'var(--color-arco-chart-8)',
  'var(--color-arco-chart-7)',
  'var(--color-arco-chart-6)',
  'var(--color-arco-chart-4)',
  'var(--color-arco-chart-5)',
  'var(--color-arco-chart-3)',
  'var(--color-arco-chart-2)',
  'var(--color-arco-chart-1)',
  'var(--color-arco-chart-10)',
]

// Shared Value-column header for every Portfolio view (Snapshot, Industry, Exposure) —
// one source of truth so the tables can't drift apart again.
const VALUE_HEADER = 'Value (USD)'

type Tab = 'snapshot' | 'industry' | 'exposure'

const TAB_LABEL: Record<Tab, string> = { snapshot: 'Snapshot', industry: 'Industry', exposure: 'Exposure' }

// Value text for a row: explicit value / (% × AUM) / "—", formatted with aumLabel — the
// one money formatter shared by every Portfolio view so their Value columns can't drift.
function valueText(row: BreakdownRow, aum: number | null): string {
  const value = resolveSliceValue(row, aum)
  return value != null ? aumLabel(value) : '—'
}

const ROW_HIGHLIGHT = 'bg-[var(--color-row-hover-weak)]'
const TOOLTIP_CLASS =
  'rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2.5 py-1.5 text-xs whitespace-nowrap'

function TooltipCard({ row, aum }: { row: BreakdownRow; aum: number | null }) {
  return (
    <div className={TOOLTIP_CLASS} style={{ boxShadow: 'var(--shadow-table)' }}>
      <span className="font-medium text-[var(--color-arco-ink)]">{row.label}</span>
      <span className="text-[var(--color-arco-muted)]">
        {' · '}
        {valueText(row, aum)}
        {' · '}
        {row.pct}%
      </span>
    </div>
  )
}

export function PortfolioCard({
  portfolio,
  enabledViews,
  aum = null,
  percentLabel = '% of NAV',
  stacked = false,
  exposureHeading = 'Exposure by Protocol',
  exposureColumnLabel = 'Portfolio',
}: {
  // `snapshot` is optional so legacy callers (no snapshot data) are unaffected; `total`
  // is widened to allow null (GIWA config → donut total falls back to the AUM).
  portfolio: Omit<ProductDetailData['portfolio'], 'total'> & { total?: number | null; snapshot?: BreakdownRow[] }
  // Per-vault config (GIWA admin) can enable/disable views. Absent => industry+exposure on
  // and snapshot off (legacy behavior). Snapshot is OPT-IN (=== true); industry/exposure
  // are OPT-OUT (!== false). The API guarantees at least one view stays enabled.
  enabledViews?: { snapshot?: boolean; industry?: boolean; exposure?: boolean }
  // GIWA-only: parsed admin AUM (fills unset slice values via % × AUM) + the "% of AUM"
  // header. Legacy callers pass neither → explicit values + "% of NAV", byte-identical.
  aum?: number | null
  percentLabel?: string
  // Force the single-column (stacked) donut+table layout regardless of viewport. Default false =
  // the viewport-based md:2-col (byte-identical for the product page). Set by narrow-container
  // callers (Savings 505px column) where md: (768px viewport) would wrongly go side-by-side.
  stacked?: boolean
  // Read-only underlying funds use allocation segments instead of DeFi protocols.
  exposureHeading?: string
  exposureColumnLabel?: string
}) {
  const tabs: Tab[] = [
    ...(enabledViews?.snapshot === true ? (['snapshot'] as Tab[]) : []),
    ...(enabledViews?.industry !== false ? (['industry'] as Tab[]) : []),
    ...(enabledViews?.exposure !== false ? (['exposure'] as Tab[]) : []),
  ]
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'industry')
  const activeTab = tabs.includes(tab) ? tab : (tabs[0] ?? 'industry')
  const snapshotRows = portfolio.snapshot ?? []

  return (
    <div className="rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Portfolio</h3>
        <div className="text-right text-xs text-[var(--color-arco-muted)]">
          <span className="text-[var(--color-arco-up)]">Updated</span> {portfolio.updatedAt}
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--color-arco-muted)]">{portfolio.note}</p>

      {/* tabs */}
      <div className="mt-4 flex items-center gap-5 border-b border-[var(--color-arco-border)]">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-current={activeTab === t ? 'true' : undefined}
            className={`relative -mb-px py-2 text-sm ${
              activeTab === t
                ? 'font-medium text-[var(--color-arco-ink)]'
                : 'text-[var(--color-arco-muted)]'
            }`}
          >
            {TAB_LABEL[t]}
            {activeTab === t && (
              <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-arco-ink)]" />
            )}
          </button>
        ))}
      </div>

      {activeTab === 'snapshot' ? (
        snapshotRows.length > 0 ? (
          <PieBreakdown heading="Snapshot" rows={snapshotRows} total={null} aum={aum} percentLabel={percentLabel} stacked={stacked} />
        ) : (
          <EmptyBreakdown />
        )
      ) : activeTab === 'industry' ? (
        portfolio.industry.length > 0 ? (
          <PieBreakdown
            heading="Industry Weightings"
            rows={portfolio.industry}
            total={portfolio.total ?? null}
            aum={aum}
            percentLabel={percentLabel}
            stacked={stacked}
          />
        ) : (
          <EmptyBreakdown />
        )
      ) : portfolio.exposure.length > 0 ? (
        <ExposureView rows={portfolio.exposure} aum={aum} percentLabel={percentLabel} heading={exposureHeading} columnLabel={exposureColumnLabel} />
      ) : (
        <EmptyBreakdown />
      )}
    </div>
  )
}

function EmptyBreakdown() {
  return <p className="mt-6 text-sm text-[var(--color-arco-muted)]">No breakdown data yet.</p>
}

// One shared breakdown table for every Portfolio view (Snapshot, Industry, Exposure). The
// header and each row are subgrids of a SINGLE column grid, so the auto Value/percent tracks
// size to the widest cell across the whole table and every value's RIGHT edge lines up —
// independent per-row grids used to let short values ("$121M") drift. `tabular-nums` keeps
// digits equal-width so decimals don't jitter the columns. Per-view visuals (dot palette,
// label/percent color, percent precision) are props; the *layout* is single-source so the
// three views can't diverge again.
function BreakdownTable({
  columnLabel,
  percentLabel,
  rows,
  aum,
  colors,
  labelClass,
  percentClass,
  percentText,
  active,
  setActive,
}: {
  columnLabel: string
  percentLabel: string
  rows: BreakdownRow[]
  aum: number | null
  colors: string[]
  labelClass: string
  percentClass: string
  percentText: (row: BreakdownRow) => string
  active: number | null
  setActive: (index: number | null) => void
}) {
  return (
    <div className="grid w-full grid-cols-[1fr_auto_auto] gap-x-4">
      <div className="col-span-3 grid min-h-[31px] grid-cols-subgrid items-center text-[11px] uppercase tracking-wide text-[var(--color-arco-muted)]">
        <span>{columnLabel}</span>
        <span className="text-right tabular-nums">{VALUE_HEADER}</span>
        <span className="text-right tabular-nums">{percentLabel}</span>
      </div>
      <ul className="contents">
        {rows.map((r, i) => (
          <li
            key={r.label}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            className={`col-span-3 grid min-h-[40px] grid-cols-subgrid items-center border-t border-[var(--color-arco-border)] py-2 text-sm ${
              active === i ? ROW_HIGHLIGHT : ''
            }`}
          >
            <span className={`flex items-center gap-2 ${labelClass}`}>
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ background: colors[i % colors.length] }}
              />
              {r.label}
            </span>
            <span className="text-right font-mono tabular-nums text-[var(--color-arco-ink)]">
              {valueText(r, aum)}
            </span>
            <span className={`text-right font-mono tabular-nums ${percentClass}`}>
              {percentText(r)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Pie donut + weightings table (Snapshot & Industry share this rendering) ───
function PieBreakdown({
  heading,
  rows,
  total,
  aum,
  percentLabel,
  stacked,
}: {
  heading: string
  rows: BreakdownRow[]
  total: number | null
  aum: number | null
  percentLabel: string
  stacked?: boolean
}) {
  // First column header: keep "Industry" for the Industry tab; neutral "Segment" elsewhere.
  const columnLabel = heading === 'Industry Weightings' ? 'Industry' : 'Segment'
  const [active, setActive] = useState<number | null>(null)
  const donutTotal = resolveDonutTotal(total, rows, aum)
  return (
    <>
      <p className="mt-4 text-[11px] uppercase tracking-wide text-[var(--color-arco-muted)]">
        {heading}
      </p>
      <div className={`mt-3 grid grid-cols-1 gap-6 ${stacked ? "" : "md:grid-cols-[280px_1fr]"} md:items-center`}>
        {/* touch-pan-y: recharts preventDefaults touchmove for the tooltip, trapping page scroll;
            allow vertical drags to scroll the page (tooltips still fire on tap). */}
        <div className="relative mx-auto h-[190px] w-[190px] touch-pan-y">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                dataKey="pct"
                nameKey="label"
                innerRadius={60}
                outerRadius={95}
                paddingAngle={1}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                onMouseEnter={(_, i: number) => setActive(i)}
                onMouseLeave={() => setActive(null)}
              >
                {rows.map((_, i) => (
                  <Cell
                    key={i}
                    fill={DONUT[i % DONUT.length]}
                    fillOpacity={active == null || active === i ? 1 : 0.4}
                  />
                ))}
              </Pie>
              <Tooltip
                cursor={false}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                content={(props: any) =>
                  props?.active && props?.payload?.length ? (
                    <TooltipCard row={props.payload[0].payload as BreakdownRow} aum={aum} />
                  ) : null
                }
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-arco-muted)]">
              TOTAL
            </span>
            <span className="font-mono text-sm font-medium text-[var(--color-arco-ink)]">
              {donutTotal != null ? aumLabel(donutTotal) : '—'}
            </span>
          </div>
        </div>

        <BreakdownTable
          columnLabel={columnLabel}
          percentLabel={percentLabel}
          rows={rows}
          aum={aum}
          colors={DONUT}
          labelClass="text-[var(--color-arco-text-soft)]"
          percentClass="text-[var(--color-arco-text-soft)]"
          percentText={(r) => `${r.pct}%`}
          active={active}
          setActive={setActive}
        />
      </div>
    </>
  )
}

// ── Exposure tab: protocol stacked bar + table (Figma node 7:229) ────────────
function ExposureView({
  rows,
  aum,
  percentLabel,
  heading,
  columnLabel,
}: {
  rows: BreakdownRow[]
  aum: number | null
  percentLabel: string
  heading: string
  columnLabel: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const [showTip, setShowTip] = useState(false)
  // Segment horizontal centers (% of bar width) for positioning the hover tooltip.
  let acc = 0
  const centers = rows.map((r) => {
    const center = acc + r.pct / 2
    acc += r.pct
    return center
  })
  return (
    <>
      <div className="mt-4 flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-arco-muted)]">
          {heading}
        </span>
        <span className="inline-flex size-4 items-center justify-center rounded-[6px] bg-[var(--color-arco-chip)] text-[10px] leading-none text-[var(--color-arco-text-soft)]">
          i
        </span>
      </div>

      {/* stacked bar — each segment width = % of AUM; segment hover shows tooltip + highlights row */}
      <div className="relative mt-3">
        <div className="flex h-6 w-full overflow-hidden rounded-[var(--radius-pill)]">
          {rows.map((r, i) => (
            <span
              key={r.label}
              onMouseEnter={() => {
                setActive(i)
                setShowTip(true)
              }}
              onMouseLeave={() => {
                setActive(null)
                setShowTip(false)
              }}
              style={{
                width: `${r.pct}%`,
                background: EXPOSURE_COLORS[i % EXPOSURE_COLORS.length],
                opacity: active == null || active === i ? 1 : 0.4,
              }}
            />
          ))}
        </div>
        {showTip && active != null && (
          <div
            className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2"
            style={{ left: `${centers[active]}%` }}
          >
            <TooltipCard row={rows[active]} aum={aum} />
          </div>
        )}
      </div>

      {/* table — row hover highlights the segment; shares the pie views' aligned layout */}
      <div className="mt-4">
        <BreakdownTable
          columnLabel={columnLabel}
          percentLabel={percentLabel}
          rows={rows}
          aum={aum}
          colors={EXPOSURE_COLORS}
          labelClass="text-[var(--color-arco-text)]"
          percentClass="text-[var(--color-arco-chart-4)]"
          percentText={(r) => `${r.pct.toFixed(2)}%`}
          active={active}
          setActive={setActive}
        />
      </div>
    </>
  )
}
