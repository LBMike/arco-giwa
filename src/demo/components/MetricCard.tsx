import { type ReactNode } from 'react'

// Single overview metric tile. `value` is a derived display string (never a raw
// number); `change` / `sub` / `children` are optional decorations.

export function MetricCard({
  label,
  value,
  change,
  sub,
  children,
}: {
  label: string
  value?: string
  /** signed change in percent; renders a colored caption when present */
  change?: number
  /** small caption under the value (e.g. "Today") */
  sub?: string
  /** custom value content (e.g. network icons) instead of a string value */
  children?: ReactNode
}) {
  const up = change !== undefined && change >= 0
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--color-arco-muted)]">
        {label}
      </p>
      {value !== undefined && (
        <p className="mt-1.5 font-mono text-lg font-medium text-[var(--color-arco-ink)]">
          {value}
        </p>
      )}
      {children && <div className="mt-2">{children}</div>}
      {sub && (
        <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">{sub}</p>
      )}
      {change !== undefined && (
        <p
          className={`mt-0.5 font-mono text-xs ${
            up ? 'text-[var(--color-arco-up)]' : 'text-[var(--color-arco-down)]'
          }`}
        >
          {up ? '▲' : '▼'} {Math.abs(change)}%
        </p>
      )}
    </div>
  )
}
