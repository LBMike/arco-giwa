import { Fragment, type ReactNode } from "react"
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, HelpCircle, RefreshCw, XCircle } from "lucide-react"
import { formatBaseUnits, formatDuration, formatElapsed, formatUtc, formatUtcMs, shortId } from "./format"
import type { StateCategory } from "./states"
import type { Loaded, ResourceState, StocksAdminError } from "./types"

/** Client-side age after which loaded data is labelled as possibly outdated. */
export const STALE_AFTER_MS = 60_000

export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

export type Tone = "positive" | "negative" | "attention" | "active" | "neutral"

export function toneOf(category: StateCategory): Tone {
  if (category === "completed") return "positive"
  if (category === "closed") return "neutral"
  if (category === "waiting" || category === "processing") return "active"
  return "attention"
}

const PILL_TONE: Record<Tone, string> = {
  positive: "border-[var(--color-arco-up)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]",
  negative: "border-[var(--color-arco-down)] bg-[var(--color-arco-surface)] text-[var(--color-arco-down)]",
  attention: "border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-ink)]",
  active: "border-[var(--color-arco-border)] bg-[var(--color-arco-chip)] text-[var(--color-arco-text-soft)]",
  neutral: "border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-text-soft)]",
}

function ToneIcon({ tone }: { tone: Tone }) {
  const className = "size-3.5 shrink-0"
  if (tone === "positive") return <CheckCircle2 aria-hidden="true" className={`${className} text-[var(--color-arco-up)]`} />
  if (tone === "negative") return <XCircle aria-hidden="true" className={className} />
  if (tone === "attention") return <AlertTriangle aria-hidden="true" className={className} />
  if (tone === "active") return <Clock3 aria-hidden="true" className={className} />
  return <CircleDashed aria-hidden="true" className={className} />
}

/** Status label: always text + icon, never colour alone. */
export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 rounded-[var(--radius-pill)] border px-2 py-0.5 text-[11px] font-medium leading-4 ${PILL_TONE[tone]}`}
    >
      <ToneIcon tone={tone} />
      {/* min-w-0: a long state name (FUNDING_REVIEW_REQUIRED) wraps inside the pill instead of running past its border. */}
      <span className="min-w-0 break-words">{breakAtUnderscores(children)}</span>
    </span>
  )
}

/** A narrow pill breaks a state name after an underscore (FUNDING_REVIEW_ / REQUIRED), not mid-word. The text is unchanged. */
function breakAtUnderscores(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !children.includes("_")) return children
  const parts = children.split("_")
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? (
        <>
          _<wbr />
        </>
      ) : null}
    </Fragment>
  ))
}

/** Section card. Its heading is h2 under the console's h1; cards nested inside the order detail pass 3. */
export function Card({ title, description, actions, children, headingLevel = 2 }: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  headingLevel?: 2 | 3 | 4
}) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4"
  return (
    <section className="w-full min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Heading className="text-sm font-semibold text-[var(--color-arco-ink)]">{title}</Heading>
          {description && <div className="mt-1 text-xs leading-5 text-[var(--color-arco-text-soft)]">{description}</div>}
        </div>
        {actions}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Exact amount: scaled value with unit, plus the raw integer base units the server returned. */
export function Amount({ value, scale, unit, showBase = true }: { value: string; scale: number; unit: string; showBase?: boolean }) {
  const formatted = formatBaseUnits(value, scale)
  if (formatted === null) return <span className="font-mono text-xs text-[var(--color-arco-down)]">Invalid amount</span>
  return (
    <span className="inline-block min-w-0 max-w-full">
      <span className="break-words font-mono text-xs text-[var(--color-arco-ink)]">
        {/* Long amounts may wrap only after a thousands separator, never inside a digit group. */}
        {formatted.split(",").map((group, index) => (
          <Fragment key={index}>
            {index > 0 && (
              <>
                ,<wbr />
              </>
            )}
            {group}
          </Fragment>
        ))}{" "}
        <span className="whitespace-nowrap text-[var(--color-arco-text-soft)]">{unit}</span>
      </span>
      {showBase && (
        <span className="block font-mono text-[11px] text-[var(--color-arco-text-soft)]">
          <span className="break-all">{value}</span> <span className="whitespace-nowrap">base units · scale {scale}</span>
        </span>
      )}
    </span>
  )
}

/** Identifier (hash, address, id). `short` keeps the full value in title and accessible name. */
export function Mono({ value, short = false }: { value: string; short?: boolean }) {
  if (!short) return <span className="break-all font-mono text-xs text-[var(--color-arco-ink)]">{value}</span>
  const label = shortId(value)
  return (
    <span title={value} className="font-mono text-xs text-[var(--color-arco-ink)]">
      <span aria-hidden={label !== value}>{label}</span>
      {label !== value && <span className="sr-only">{value}</span>}
    </span>
  )
}

export function Time({ iso, now, elapsed = false }: { iso: string; now?: number; elapsed?: boolean }) {
  return (
    <span className="text-xs text-[var(--color-arco-ink)]">
      <time dateTime={iso} className="font-mono">{formatUtc(iso)}</time>
      {elapsed && now !== undefined && (
        <span className="block text-[11px] text-[var(--color-arco-text-soft)]">{formatElapsed(iso, now)}</span>
      )}
    </span>
  )
}

export function Fields({ children }: { children: ReactNode }) {
  return <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">{children}</dl>
}

export function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)]">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-xs text-[var(--color-arco-ink)]">{children}</dd>
    </div>
  )
}

export function Notice({ tone, title, children, live = false }: { tone: "error" | "attention" | "info"; title: string; children?: ReactNode; live?: boolean }) {
  const border =
    tone === "error"
      ? "border-[var(--color-arco-down)]"
      : tone === "attention"
        ? "border-dashed border-[var(--color-arco-ink)]"
        : "border-[var(--color-arco-border)]"
  const Icon = tone === "error" ? XCircle : tone === "attention" ? AlertTriangle : HelpCircle
  return (
    <div
      role={live ? (tone === "error" ? "alert" : "status") : undefined}
      className={`flex w-full min-w-0 gap-2 rounded-[var(--radius-card)] border bg-[var(--color-arco-surface)] p-3 ${border}`}
    >
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${tone === "error" ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}`} />
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${tone === "error" ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}`}>{title}</p>
        {children && <div className="mt-1 text-xs leading-5 text-[var(--color-arco-text-soft)]">{children}</div>}
      </div>
    </div>
  )
}

export function Button({ children, onClick, label, disabled = false }: { children: ReactNode; onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-arco-ink)] disabled:cursor-not-allowed disabled:text-[var(--color-arco-muted)] ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

/**
 * Busy is aria-disabled, not `disabled`: a natively disabled button drops keyboard focus to <body> the moment Enter starts
 * the read. The click guard keeps one read per activation (load/refreshDetail have no in-flight guard of their own).
 */
export function RefreshButton({ onClick, busy, what }: { onClick: () => void; busy: boolean; what: string }) {
  return (
    <button
      type="button"
      aria-label={`Refresh ${what}`}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!busy) onClick()
      }}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-arco-ink)] aria-disabled:cursor-not-allowed aria-disabled:text-[var(--color-arco-muted)] ${FOCUS_RING}`}
    >
      <RefreshCw aria-hidden="true" className="size-3.5" />
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  )
}

export function errorCopy(error: StocksAdminError): { title: string; body: string } {
  const suffix = [error.status, error.code].filter((part) => part !== null).join(" · ")
  switch (error.kind) {
    case "configuration":
      return { title: "Stocks admin API is not configured", body: "No request was sent. Nothing new is shown." }
    case "network":
      return { title: "Could not reach the API", body: "The request failed before a response arrived. Nothing new is shown." }
    case "server":
      return { title: `Server error${suffix ? ` (${suffix})` : ""}`, body: "The Stocks API failed to answer. Nothing new is shown." }
    case "invalid":
      return { title: "Response did not match the Stocks admin contract", body: "The response was rejected and none of it is shown." }
    case "not_found":
      return { title: "Order not found in this deployment", body: "The server returned ORDER_NOT_FOUND for this order id." }
    case "aborted":
      return { title: "Request cancelled", body: "The request was cancelled before it finished." }
    default:
      return { title: `Request rejected${suffix ? ` (${suffix})` : ""}`, body: "The server rejected the request. Nothing new is shown." }
  }
}

/** Loaded-at line with refresh and stale/failed-refresh labelling. */
export function ResourceMeta<T>({ state, now, onRefresh, what }: { state: ResourceState<T>; now: number; onRefresh: () => void; what: string }) {
  const value: Loaded<T> | null = state.value
  const age = value ? now - value.loadedAt : null
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-4 text-[var(--color-arco-text-soft)]">
          {value ? (
            <>
              Loaded <span className="font-mono">{formatUtcMs(value.loadedAt)}</span>
              {age !== null && age >= 0 && <> ({formatDuration(age)} ago)</>} · server response{" "}
              <span className="font-mono">{formatUtc(value.meta.observedAt)}</span>
            </>
          ) : state.phase === "loading" ? (
            "Loading…"
          ) : (
            "Not loaded"
          )}
        </p>
        <RefreshButton onClick={onRefresh} busy={state.phase === "loading"} what={what} />
      </div>
      {state.phase === "error" && state.error && (
        <Notice tone="error" title={errorCopy(state.error).title} live>
          {value
            ? `${errorCopy(state.error).body} The data below is from the last successful load at ${formatUtcMs(value.loadedAt)}.`
            : errorCopy(state.error).body}
        </Notice>
      )}
      {state.phase !== "error" && value && age !== null && age > STALE_AFTER_MS && (
        <Notice tone="attention" title="Loaded more than 60 seconds ago">
          Refresh before relying on these values.
        </Notice>
      )}
    </div>
  )
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-border)] p-3 text-xs text-[var(--color-arco-text-soft)]">{children}</p>
}

export type DataColumn = {
  readonly key: string
  readonly header: string
  /** Header is announced but not shown (e.g. an actions column). */
  readonly visuallyHiddenHeader?: boolean
  readonly align?: "end"
}

export type DataRow = {
  readonly key: string
  readonly cells: Readonly<Record<string, ReactNode>>
  readonly current?: boolean
}

/**
 * Accessible table that stacks into labelled cells on narrow screens and becomes grid rows at
 * `wideClass` (a complete literal like "lg:grid-cols-[…]" so Tailwind can see it). No
 * horizontal scrolling at any width.
 */
export function DataList({ label, columns, rows, wideClass, stackClass = "sm:grid-cols-2" }: {
  label: string
  columns: readonly DataColumn[]
  rows: readonly DataRow[]
  wideClass: string
  stackClass?: string
}) {
  const breakpoint = wideClass.slice(0, wideClass.indexOf(":"))
  const showHeader = { sm: "sm:grid", md: "md:grid", lg: "lg:grid", xl: "xl:grid", "2xl": "2xl:grid" }[breakpoint] ?? "md:grid"
  const hideLabel = { sm: "sm:hidden", md: "md:hidden", lg: "lg:hidden", xl: "xl:hidden", "2xl": "2xl:hidden" }[breakpoint] ?? "md:hidden"
  const alignEnd = { sm: "sm:text-right", md: "md:text-right", lg: "lg:text-right", xl: "xl:text-right", "2xl": "2xl:text-right" }[breakpoint] ?? "md:text-right"
  return (
    <div role="table" aria-label={label} className="w-full min-w-0">
      <div role="rowgroup" className={`hidden ${showHeader} ${wideClass} gap-3 border-b border-[var(--color-arco-border)] pb-2`}>
        {columns.map((column) => (
          <div
            key={column.key}
            role="columnheader"
            className={`text-[11px] font-medium text-[var(--color-arco-text-soft)] ${column.align === "end" ? "text-right" : ""} ${column.visuallyHiddenHeader ? "sr-only" : ""}`}
          >
            {column.header}
          </div>
        ))}
      </div>
      <div role="rowgroup">
        {rows.map((row) => (
          <div
            key={row.key}
            role="row"
            aria-current={row.current ? "true" : undefined}
            className={`grid grid-cols-1 gap-x-4 gap-y-2 border-t border-[var(--color-arco-border)] py-3 first:border-t-0 ${stackClass} ${wideClass} ${
              row.current ? "bg-[var(--color-arco-surface-muted)]" : ""
            }`}
          >
            {columns.map((column) => (
              <div key={column.key} role="cell" className={`min-w-0 text-xs text-[var(--color-arco-ink)] ${column.align === "end" ? alignEnd : ""}`}>
                {!column.visuallyHiddenHeader && (
                  <span className={`mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)] ${hideLabel}`}>
                    {column.header}
                  </span>
                )}
                {row.cells[column.key]}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
