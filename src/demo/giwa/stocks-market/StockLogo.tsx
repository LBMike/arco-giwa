import { useState } from "react"
import { stockLogoPath } from "./curated"
const BOX = { 32: "size-8 text-sm", 40: "size-10 text-base", 48: "size-12 text-lg" } as const
/**
 * Curated same-origin file first, then the profile logoUrl the market client already validated, then the ticker's first
 * letter. Decorative: the ticker is always adjacent text.
 */
export function StockLogo({ symbol, size = 40, apiLogoUrl = null }: { symbol: string; size?: 32 | 40 | 48; apiLogoUrl?: string | null }) {
  const curated = stockLogoPath(symbol)
  const src = curated ?? apiLogoUrl
  const [failed, setFailed] = useState<string | null>(null)
  return <span className={`inline-flex ${BOX[size]} shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-arco-surface)] ring-1 ring-[var(--color-arco-border)]`}>
    {src && failed !== src
      ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(src)} className="size-full object-contain" {...(curated ? {} : { referrerPolicy: "no-referrer" as const, crossOrigin: "anonymous" as const })} />
      : <span data-logo-fallback="" aria-hidden="true" className="flex size-full items-center justify-center bg-[var(--color-arco-chip)] font-medium text-[var(--color-arco-chip-ink)]">{symbol.slice(0, 1)}</span>}
  </span>
}
