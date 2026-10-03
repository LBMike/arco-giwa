import { BrandMark } from "../components/BrandMark"
import type { DigiFTReferenceAsset } from "./digift-reference-assets"
import { DigiFTProductMark } from "./DigiFTProductMark"
import { DigiFTFirmMark } from "./DigiFTFirmMark"
import { RiskTag, digiftCategoryRisk } from "./RiskTag"

function displayAum(value: string): string {
  return value.replace(/^USD /, "$").replace(" billion", "B").replace(" million", "M")
}

export function DigiFTReferenceRow({
  asset,
  gridColumnsClassName,
  onSelect,
}: {
  asset: DigiFTReferenceAsset
  gridColumnsClassName: string
  onSelect: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="digift-reference-row"
      aria-label={"View " + asset.symbol + " reference profile: " + asset.name}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={"group relative grid min-h-[84px] cursor-pointer items-center border-b border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-1.5 py-3 outline-none transition-colors hover:bg-[var(--color-arco-surface-muted)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-arco-ink-40)] " + gridColumnsClassName}
    >
      <div className="relative z-10 flex min-w-0 items-center gap-2.5 pl-1">
        <DigiFTProductMark asset={asset} size={35} />
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-base font-medium leading-5 text-[var(--color-arco-ink)]" title={asset.name}>{asset.symbol}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <RiskTag level={digiftCategoryRisk(asset.category)} />
            <span className="whitespace-nowrap rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
              {asset.category}
            </span>
          </span>
        </div>
      </div>

      <div className="relative z-10 flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]" title={`USDC is a preview base asset; source exposure: ${asset.baseAsset}`}>
          <BrandMark src="/logos/usdc.svg" label="USDC" size={18} />
          USDC
        </span>
      </div>

      <div className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 px-1" title="Displayed managing firm; product roles are detailed in each profile">
        <DigiFTFirmMark asset={asset} />
        <span className="truncate text-xs text-[var(--color-arco-text-soft)]">{asset.manager}</span>
      </div>

      <div className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 px-1" title="DigiFT is a preview issuer; legal issuer not verified in source">
        <BrandMark src="/logos/DigFT.png" label="DigiFT" size={20} />
        <span className="truncate text-xs text-[var(--color-arco-text-soft)]">DigiFT</span>
      </div>

      <div className="relative z-10 flex min-w-0 flex-col items-center text-center tabular-nums">
        <span
          className="text-sm text-[var(--color-arco-ink)]"
          title={asset.aum ?? asset.aumEstimate?.value ?? undefined}
        >
          {asset.aum ? displayAum(asset.aum) : asset.aumEstimate ? displayAum(asset.aumEstimate.value) : "—"}
        </span>
      </div>

      <div className="relative z-10 flex min-w-0 flex-col items-center text-center tabular-nums">
        <span className="max-w-full truncate text-sm text-[var(--color-arco-ink)]" title={asset.metricValue}>{asset.metricLabel === "Benchmark" ? "—" : asset.metricValue}</span>
        <span className="max-w-full truncate text-[10px] text-[var(--color-arco-muted)]" title={asset.metricLabel + (asset.metricAsOf ? " · " + asset.metricAsOf : "")}>
          {asset.metricLabel === "Benchmark" ? asset.metricValue : asset.metricLabel}
          {asset.metricAsOf && " · " + asset.metricAsOf}
        </span>
      </div>

      <div className="relative z-10 flex justify-center" title="GIWA is a preview network; this product is not deployed">
        <img src="/logos/giwa.png" alt="GIWA" width={20} height={20} className="rounded-full object-contain" />
      </div>
    </div>
  )
}
