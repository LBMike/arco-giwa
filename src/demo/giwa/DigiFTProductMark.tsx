import { BrandMark } from "../components/BrandMark"
import type { DigiFTReferenceAsset } from "./digift-reference-assets"

// Visual derivatives of the seven product marks in the DigiFT Product Snapshot,
// page 3. The full source slide is intentionally not bundled with the app.
const MARK_STRIP = "/logos/digift-reference-marks-2026-09.png"
const JX_MARK = "/logos/digift-jx-mark-2026-09.png"

type Mark = { src: string; viewBox: string; width: number; height: number }

const MARKS: Record<string, Mark> = {
  CMBMINT: { src: MARK_STRIP, viewBox: "54 291 230 236", width: 1914, height: 822 },
  ULTRA: { src: MARK_STRIP, viewBox: "316 291 230 236", width: 1914, height: 822 },
  TKStable: { src: MARK_STRIP, viewBox: "578 291 231 236", width: 1914, height: 822 },
  CMBBOND: { src: MARK_STRIP, viewBox: "840 290 233 237", width: 1914, height: 822 },
  JX: { src: JX_MARK, viewBox: "221 218 811 811", width: 1254, height: 1254 },
  kTW50: { src: MARK_STRIP, viewBox: "1366 290 231 237", width: 1914, height: 822 },
  GOLDX: { src: MARK_STRIP, viewBox: "1627 290 232 237", width: 1914, height: 822 },
}

export function DigiFTProductMark({ asset, size = 35 }: { asset: DigiFTReferenceAsset; size?: number }) {
  const mark = MARKS[asset.symbol]
  if (!mark) return <BrandMark label={asset.symbol} size={size} />

  return (
    <svg
      role="img"
      aria-label={`${asset.symbol} product mark`}
      width={size}
      height={size}
      viewBox={mark.viewBox}
      className="shrink-0 overflow-hidden rounded-full"
    >
      <title>{asset.symbol}</title>
      <image href={mark.src} width={mark.width} height={mark.height} />
    </svg>
  )
}
