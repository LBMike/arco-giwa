import { BrandMark } from "../components/BrandMark"
import { categoryTitle } from "./fund-categories"
import { FirmMark, FundMark } from "./FundMark"
import { metricCaption, type ListedFund } from "./listed-funds"
import { RiskTag, vaultCategoryRisk } from "./RiskTag"

// A listed (not yet deployed) fund in the Funds table, laid out exactly like a deployed vault row.
export function ListedFundRow({
  fund,
  gridColumnsClassName,
  onSelect,
}: {
  fund: ListedFund
  gridColumnsClassName: string
  onSelect: () => void
}) {
  const risk = vaultCategoryRisk(fund.category)
  const caption = metricCaption(fund.metric)
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="listed-fund-row"
      aria-label={`View ${fund.symbol}: ${fund.name}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={
        "group relative grid min-h-[72px] cursor-pointer items-center border-b border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-1.5 py-3 outline-none transition-colors hover:bg-[var(--color-arco-surface-muted)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-arco-ink-40)] " +
        gridColumnsClassName
      }
    >
      <div className="relative z-10 flex items-center gap-2.5 pl-1">
        <FundMark fund={fund} size={35} />
        <div className="flex flex-col">
          <span className="text-base font-medium leading-5 text-[var(--color-arco-ink)]" title={fund.name}>
            {fund.symbol}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {risk && <RiskTag level={risk} />}
            <span className="whitespace-nowrap rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
              {categoryTitle(fund.category)}
            </span>
          </span>
        </div>
      </div>

      <div className="relative z-10 flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]">
          <BrandMark src="/logos/usdc.svg" label="USDC" size={18} />
          USDC
        </span>
      </div>

      <div className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 px-1">
        <FirmMark party={fund.manager} />
        <span className="truncate text-xs text-[var(--color-arco-text-soft)]">{fund.manager.name}</span>
      </div>

      <div className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 px-1">
        <BrandMark src={fund.issuer.logo} label={fund.issuer.name} size={20} />
        <span className="truncate text-xs text-[var(--color-arco-text-soft)]">{fund.issuer.name}</span>
      </div>

      <div className="relative z-10 text-center tabular-nums text-sm text-[var(--color-arco-ink)]">{fund.aum.value}</div>
      <RateCell value={fund.metric.value} caption={caption} />
      <div className="relative z-10 flex justify-center">
        <span title="GIWA" className="inline-flex shrink-0" style={{ width: 20, height: 20 }}>
          <img src="/logos/giwa.png" alt="GIWA" width={20} height={20} className="rounded-full object-contain" />
        </span>
      </div>
    </div>
  )
}

/** The APY column: the rate, with what it is and its date underneath when known. */
export function RateCell({ value, caption }: { value: string; caption?: string | null }) {
  // A long caption wraps before the date, never inside it.
  const at = caption ? caption.lastIndexOf(" · ") : -1
  const what = caption && at > 0 ? caption.slice(0, at) : caption
  const when = caption && at > 0 ? caption.slice(at + 3) : null
  return (
    <div className="relative z-10 flex min-w-0 flex-col items-center text-center tabular-nums">
      <span className="text-sm text-[var(--color-arco-ink)]">{value}</span>
      {caption && (
        <span className="line-clamp-2 max-w-full text-[10px] leading-[14px] text-[var(--color-arco-muted)]" title={caption}>
          {what}
          {when && (
            <>
              {" · "}
              <span className="whitespace-nowrap">{when}</span>
            </>
          )}
        </span>
      )}
    </div>
  )
}
