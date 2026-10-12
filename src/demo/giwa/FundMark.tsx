import { BrandMark } from "../components/BrandMark"
import type { FundParty, ListedFund } from "./listed-funds"

// Product marks. RRDY, CMBBOND, kTW50 and JX are DigiFT's token marks; HOME is NUVA's nvHOME vault
// mark. A missing file falls back to BrandMark's initial badge.
const MARK_FILES: Record<string, string> = {
  RRDY: "/logos/rrdy.png",
  CMBBOND: "/logos/cmbbond.png",
  HOME: "/logos/nuva-home.svg",
  JX: "/logos/jx.png",
  kTW50: "/logos/ktw50.png",
}

export function fundMarkSrc(symbol: string): string | undefined {
  return MARK_FILES[symbol]
}

export function FundMark({ fund, size = 35 }: { fund: Pick<ListedFund, "symbol">; size?: number }) {
  return <BrandMark src={fundMarkSrc(fund.symbol)} label={fund.symbol} size={size} />
}

// The compact emblem inside a firm's official wordmark, at the size the deployed rows use for firm
// logos. A firm without an entry shows its logo file whole.
const EMBLEMS: Record<string, { viewBox: string; width: number; height: number }> = {
  "/logos/digift-manager-cmbi.jpg": { viewBox: "0 0 82 82", width: 326, height: 82 },
  "/logos/digift-manager-sbi.jpg": { viewBox: "0 0 67 46", width: 284, height: 46 },
  "/logos/digift-manager-kgi.svg": { viewBox: "0 0 44 44", width: 248, height: 44 },
}

export function FirmMark({ party, size = 20 }: { party: FundParty; size?: number }) {
  const emblem = party.logo ? EMBLEMS[party.logo] : undefined
  if (!emblem) return <BrandMark src={party.logo} label={party.name} size={size} />
  return (
    <svg
      role="img"
      aria-label={`${party.name} logo`}
      width={size}
      height={size}
      viewBox={emblem.viewBox}
      className="shrink-0 overflow-hidden rounded-full"
    >
      <title>{party.name}</title>
      <image href={party.logo} width={emblem.width} height={emblem.height} />
    </svg>
  )
}
