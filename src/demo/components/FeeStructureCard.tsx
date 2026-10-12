import { ArrowUpRight } from 'lucide-react'

// Fee structure card: Management / Performance figures, a one-line note, and a "Read more" link
// when the product has a document to point to. A fee that is not published shows "—".
export function FeeStructureCard({
  fee,
  href = null,
}: {
  fee: { management: number | null; performance: number | null; note: string }
  href?: string | null
}) {
  return (
    <div className="rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">
            Fee structure
          </h3>
          <p className="mt-1 text-xs text-[var(--color-arco-muted)]">
            {fee.note}
          </p>
        </div>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex shrink-0 items-center gap-0.5 text-xs text-[var(--color-arco-text-soft)]"
          >
            Read more
            <ArrowUpRight className="size-3" />
          </a>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Fee label="Management" value={fee.management} sub="annual on AUM" />
        <Fee label="Performance" value={fee.performance} sub="on yield/raw performance" />
      </div>
    </div>
  )
}

function Fee({
  label,
  value,
  sub,
}: {
  label: string
  value: number | null
  sub: string
}) {
  return (
    <div>
      <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
      <p className="mt-1 font-mono text-xl font-medium text-[var(--color-arco-ink)]">
        {value != null ? `${value}%` : '—'}
      </p>
      <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">{sub}</p>
    </div>
  )
}
