// Presentational pieces of the GIWA invest panel (card, segmented tab bar, amount block and fields, info rows, CTA and
// notice classes), shared by GiwaInvestPanel and the Stocks trade panel.
//
// Leaf module: imports only react and lucide-react. Nothing from ./wallet, ./contracts or ./components, so a Stocks
// feature can use these without loading the wallet SDK. Every optional prop defaults to the GIWA invest panel's own
// markup: GiwaInvestPanel passes none of them and renders byte-identical HTML.

import { useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react"
import { ArrowDown, ChevronDown, Copy } from "lucide-react"

/** The panel card. GiwaInvestPanel prefixes the sidebar variant's sticky offset. */
export const INVEST_PANEL_CARD = "rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]"

/** Segmented tab bar: the pill track, one tab, and its active / inactive states. */
export const INVEST_TAB_TRACK = "rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-sm"
export const INVEST_TAB = "rounded-[var(--radius-pill)] py-1.5"
export const INVEST_TAB_ACTIVE = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
export const INVEST_TAB_INACTIVE = "text-[var(--color-arco-muted)]"

/** Full-width primary action: base, busy and ready states. */
export const INVEST_CTA = "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-card)] py-3 text-sm font-medium"
export const INVEST_CTA_BUSY = "bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-muted)]"
export const INVEST_CTA_READY = "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)] disabled:opacity-50"

/** Bordered notice box (icon + text); the tone class (text colour) is appended by the caller. */
export const INVEST_NOTICE = "mt-4 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3 text-xs"

/**
 * Secondary text token. "muted" is the GIWA invest panel's own; "soft" is the readable text token for surfaces that keep
 * the muted token for placeholders only (the Stocks trade panel).
 */
export type InvestPanelTone = "muted" | "soft"
const SECONDARY: Record<InvestPanelTone, string> = {
  muted: "text-[var(--color-arco-muted)]",
  soft: "text-[var(--color-arco-text-soft)]",
}

/** The GIWA invest panel's keystroke filter: "" or a non-negative decimal (mid-typing "1." allowed). */
const PLAIN_DECIMAL = (next: string) => /^\d*\.?\d*$/.test(next)

export type AmountFieldProps = {
  caption: ReactNode
  symbol: string
  icon?: ReactNode
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  balance?: string
  onMax?: () => void
  subValue?: string
  /** Input id. When set, the caption is rendered as the input's <label>. */
  id?: string
  ariaLabel?: string
  /** Keystroke filter; a change that fails it is dropped and the controlled input keeps its value. Default: plain decimal. */
  filter?: (next: string) => boolean
  /** The token chip's copy-address button. Default true. */
  copyButton?: boolean
  /** Display-only amount: the value is text, and no <input> is rendered. */
  display?: boolean
  /** Text before the balance. Default "Balance". */
  balanceLabel?: string
  /** Secondary text token for the caption, balance, copy icon and sub-value. Default "muted". */
  tone?: InvestPanelTone
  /** Shown after the symbol inside the token chip (e.g. a test-value marker). */
  symbolNote?: ReactNode
  /** Extra classes for the field root (e.g. a focus-within ring). */
  className?: string
  /** Extra classes for the MAX button (e.g. a focus ring). */
  maxClassName?: string
  inputRef?: Ref<HTMLInputElement>
  /** Extra input attributes (describedby, invalid, placeholder, autocomplete…), applied after the defaults. */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "readOnly" | "inputMode" | "className" | "id">
}

export function AmountField({
  caption,
  symbol,
  icon,
  value,
  onChange,
  readOnly,
  balance,
  onMax,
  subValue,
  id,
  ariaLabel,
  filter = PLAIN_DECIMAL,
  copyButton = true,
  display = false,
  balanceLabel = "Balance",
  tone = "muted",
  symbolNote,
  className,
  maxClassName,
  inputRef,
  inputProps,
}: AmountFieldProps) {
  const secondary = SECONDARY[tone]
  const captionClass = `text-xs ${secondary}`
  return (
    <div className={className ? `p-3 ${className}` : "p-3"}>
      <div className="flex items-center justify-between gap-2">
        {id !== undefined && !display ? (
          <label htmlFor={id} className={captionClass}>
            {caption}
          </label>
        ) : (
          <p className={captionClass}>{caption}</p>
        )}
        {balance !== undefined && (
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] ${secondary}`}>
              {balanceLabel}: {balance}
            </span>
            {onMax && (
              <button
                type="button"
                onClick={onMax}
                className={`rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-arco-text-soft)]${maxClassName ? ` ${maxClassName}` : ""}`}
              >
                MAX
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-[var(--color-arco-ink)]">
          {icon}
          {symbol}
          {symbolNote}
          {copyButton && (
            <button
              type="button"
              aria-label={`Copy ${symbol} address`}
              className={`inline-flex ${secondary}`}
            >
              <Copy className="size-3.5" />
            </button>
          )}
        </span>
        {display ? (
          <p id={id} aria-label={ariaLabel} className="min-w-0 text-right tabular-nums text-lg text-[var(--color-arco-ink)] [overflow-wrap:anywhere]">
            {value}
          </p>
        ) : (
          <input
            ref={inputRef}
            id={id}
            aria-label={ariaLabel}
            inputMode="decimal"
            value={value}
            readOnly={readOnly}
            onChange={(event) => {
              const next = event.target.value
              // Reject "-", "+", "e", letters and multiple dots (and whatever `filter` refuses): a typed or pasted "-1"
              // is dropped and the controlled input keeps its prior value.
              if (filter(next)) onChange?.(next)
            }}
            className="w-full bg-transparent text-right tabular-nums text-lg text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]"
            placeholder="0.0"
            {...inputProps}
          />
        )}
      </div>
      {subValue !== undefined && (
        <p className={`mt-0.5 text-right tabular-nums text-[11px] ${secondary}`}>{subValue}</p>
      )}
    </div>
  )
}

export function AmountBlock({ children, tone = "muted", invalid = false }: { children: ReactNode; tone?: InvestPanelTone; invalid?: boolean }) {
  return (
    <div
      className={`relative divide-y divide-[var(--color-arco-border)] overflow-hidden rounded-[var(--radius-card)] border ${
        invalid ? "border-[var(--color-arco-down)]" : "border-[var(--color-arco-border)]"
      } bg-[var(--color-arco-surface)]`}
    >
      {children}
      <span className="pointer-events-none absolute left-1/2 top-1/2 z-10 inline-flex size-[21px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">
        <ArrowDown className={`size-3.5 ${SECONDARY[tone]}`} />
      </span>
    </div>
  )
}

export function InfoRow({
  label,
  value,
  expandable,
  children,
  tone = "muted",
  bodyId,
  buttonClassName,
}: {
  label: string
  value?: ReactNode
  expandable?: boolean
  children?: ReactNode
  /** Chevron token. Default "muted". */
  tone?: InvestPanelTone
  /** Expandable only: id of the body, referenced by the toggle's aria-controls. */
  bodyId?: string
  /** Expandable only: extra classes for the toggle (e.g. a focus ring). */
  buttonClassName?: string
}) {
  const [open, setOpen] = useState(false)

  if (expandable) {
    return (
      <div className="border-t border-[var(--color-arco-border)]">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls={bodyId}
          className={`flex w-full items-center justify-between py-2.5 text-sm${buttonClassName ? ` ${buttonClassName}` : ""}`}
        >
          <span className="text-[var(--color-arco-text-soft)]">{label}</span>
          <ChevronDown
            className={`size-3.5 ${SECONDARY[tone]} transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {open && children && (
          <div id={bodyId} className="pb-3">
            {children}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between border-t border-[var(--color-arco-border)] py-2.5 text-sm">
      <span className="text-[var(--color-arco-text-soft)]">{label}</span>
      <span className="tabular-nums text-[var(--color-arco-ink)]">{value}</span>
    </div>
  )
}
