import type { ReactNode } from "react"

// Pulsing placeholder block. Fill is a token (subtle grey on the light page); animate-pulse is
// built into Tailwind (no config change). Size + radius come via className. aria-hidden — the
// page-level skeleton region (below) owns the screen-reader "loading" announcement.
export function GiwaSkeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse bg-[var(--color-arco-border)] ${className}`} />
}

// role=status + aria-busy so screen readers announce loading once; visual blocks stay aria-hidden.
function SkeletonRegion({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

// Echoes the Investor (Products) layout: static <h1>, then featured carousel + strategy cards +
// filter bar + table (header + ~6 rows, each a circle + bars) as pulse placeholders.
export function ProductsSkeleton() {
  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-3xl font-semibold text-[var(--color-arco-ink)]">Products</h1>
      </section>

      <SkeletonRegion label="Loading products…" className="space-y-8">
        {/* featured carousel */}
        <GiwaSkeleton className="h-[189px] w-full rounded-[8px]" />

        {/* strategy cards */}
        <section className="space-y-3">
          <div className="flex gap-3 overflow-hidden">
            {[0, 1, 2].map((i) => (
              <GiwaSkeleton key={i} className="h-[136px] min-w-[240px] flex-1 rounded-[12px]" />
            ))}
          </div>
        </section>

        {/* all products: heading + filter bar + table */}
        <section className="space-y-4">
          <GiwaSkeleton className="h-6 w-32 rounded-[var(--radius-pill)]" />
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex flex-wrap items-center gap-2.5">
              {[0, 1, 2, 3].map((i) => (
                <GiwaSkeleton key={i} className="h-11 w-28 rounded-[5px]" />
              ))}
            </div>
          </div>
          <div
            className="w-full overflow-x-auto rounded-2xl bg-[var(--color-arco-surface)] p-4 sm:p-6"
          >
            {/* header row */}
            <div className="flex items-center gap-6 border-y border-[var(--color-arco-border)] px-1.5 py-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <GiwaSkeleton key={i} className="h-3 w-16 rounded-full" />
              ))}
            </div>
            {/* rows: circle + a couple of bars */}
            <div className="flex flex-col">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="flex h-[72px] items-center gap-3 border-b border-[var(--color-arco-border)] px-4"
                >
                  <GiwaSkeleton className="size-9 shrink-0 rounded-full" />
                  <GiwaSkeleton className="h-3 w-32 rounded-full" />
                  <GiwaSkeleton className="ml-auto h-3 w-20 rounded-full" />
                  <GiwaSkeleton className="h-3 w-14 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </section>
      </SkeletonRegion>
    </div>
  )
}

// Echoes the Savings body (hero stays in the page): account-selector row (~4 cards) + detail
// (invest-panel block + section blocks). Rendered inside the page's max-w column.
export function SavingsSkeleton() {
  return (
    <SkeletonRegion label="Loading savings accounts…" className="space-y-8">
      {/* account selector: label + row of cards */}
      <div className="w-full space-y-2">
        <GiwaSkeleton className="h-3 w-28 rounded-full" />
        <div className="flex gap-2 overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <GiwaSkeleton key={i} className="h-[112px] w-[112px] shrink-0 rounded-[10px]" />
          ))}
        </div>
      </div>
      {/* detail: invest panel + section blocks */}
      <div className="space-y-10">
        <GiwaSkeleton className="h-[460px] w-full rounded-[var(--radius-strategy)]" />
        <GiwaSkeleton className="h-[240px] w-full rounded-[var(--radius-strategy)]" />
        <GiwaSkeleton className="h-[300px] w-full rounded-[var(--radius-strategy)]" />
      </div>
    </SkeletonRegion>
  )
}
