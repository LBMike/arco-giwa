import { BrandMark } from "../components/BrandMark"
import type { DigiFTReferenceAsset } from "./digift-reference-assets"

// Show the compact emblem inside each official firm wordmark at the same 20px
// size used for firm logos in the deployed-product rows. Wellington has a
// text-only wordmark, so its W is used as the compact mark.
const EMBLEMS: Record<string, { viewBox: string; width: number; height: number }> = {
  "/logos/digift-manager-cmbi.jpg": { viewBox: "0 0 82 82", width: 326, height: 82 },
  "/logos/digift-manager-wellington.jpg": { viewBox: "90 145 130 130", width: 1280, height: 529 },
  "/logos/digift-manager-taikang.png": { viewBox: "145 494 1000 1000", width: 4948, height: 1957 },
  "/logos/digift-manager-sbi.jpg": { viewBox: "0 0 67 46", width: 284, height: 46 },
  "/logos/digift-manager-kgi.svg": { viewBox: "0 0 44 44", width: 248, height: 44 },
  "/logos/digift-manager-ocbc.png": { viewBox: "0 0 312 312", width: 1160, height: 312 },
  "/logos/digift-manager-lionglobal.png": { viewBox: "0 0 142 142", width: 277, height: 201 },
}

export function DigiFTFirmMark({ asset }: { asset: DigiFTReferenceAsset }) {
  const emblem = EMBLEMS[asset.managerLogoPath]
  if (!emblem) return <BrandMark label={asset.manager} size={20} />
  return (
    <svg
      role="img"
      aria-label={`${asset.manager} logo`}
      width={20}
      height={20}
      viewBox={emblem.viewBox}
      className="shrink-0 overflow-hidden rounded-full"
    >
      <title>{asset.manager}</title>
      <image href={asset.managerLogoPath} width={emblem.width} height={emblem.height} />
    </svg>
  )
}
