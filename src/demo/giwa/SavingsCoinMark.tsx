// A coin's mark with its chain's badge at the lower left (GIWA, Ethereum or XRPL), as the Savings deposit and withdraw
// screens and their token picker show a coin. The badge shrinks with a small mark (a wallet step's).

import { BrandMark, NetworkIcon } from "../components/BrandMark"
import { GiwaNetworkIcon } from "./components"
import { SAVINGS_CHAINS, type SavingsChainId } from "./savings-assets"

export function ChainIcon({ chain, size }: { chain: SavingsChainId; size: number }) {
  if (chain === "giwa") return <GiwaNetworkIcon size={size} />
  return <NetworkIcon network={chain === "ethereum" ? "Ethereum" : "XRPL"} size={size} />
}

/** The three chains' badges overlapping: "All Networks". */
export function ChainStack({ size = 16 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center">
      {SAVINGS_CHAINS.map((chain, index) => (
        <span key={chain.id} className={`inline-flex rounded-[var(--radius-pill)] ring-2 ring-[var(--color-arco-surface)]${index > 0 ? " -ml-1.5" : ""}`}>
          <ChainIcon chain={chain.id} size={size} />
        </span>
      ))}
    </span>
  )
}

export function CoinMark({ src, label, chain = "giwa", size = 36 }: { src: string | undefined; label: string; chain?: SavingsChainId; size?: number }) {
  const small = size < 32
  return (
    <span className="relative inline-flex shrink-0">
      <BrandMark src={src} label={label} size={size} />
      <span
        className={`absolute inline-flex items-center justify-center overflow-hidden bg-[var(--color-arco-surface)] ring-1 ring-[var(--color-arco-border)] ${
          small ? "-bottom-0.5 -left-0.5 size-2.5 rounded-[3px]" : "-bottom-1 -left-1 size-4 rounded-[5px]"
        }`}
      >
        <ChainIcon chain={chain} size={small ? 9 : 14} />
      </span>
    </span>
  )
}
