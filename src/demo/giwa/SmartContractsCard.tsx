import { ChevronDown, ExternalLink } from "lucide-react"
import { GiwaNetworkIcon } from "./components"
import { GIWA_EXPLORER } from "./config"
import type { HexAddress } from "./types"

// GIWA product-detail "Smart Contracts" card — links each vault address to the GIWA explorer.
// Lifted verbatim from ProductDetailPage so the Savings page (Phase 4) reuses the SAME card.
// NOTE: distinct from the legacy components/SmartContractsCard.tsx (etherscan) — never swap them.
export function SmartContractsCard({ rows }: { rows: Array<{ label: string; address: HexAddress | null }> }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-arco-surface)]" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="flex items-center justify-between border-b border-[var(--color-arco-border)] px-4 py-3">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Smart Contracts</h3>
        <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]">
          <GiwaNetworkIcon size={14} />
          GIWA Sepolia
          <ChevronDown className="size-3" />
        </span>
      </div>
      <dl>
        {rows.map((row, index) => (
          <div
            key={row.label}
            className={`flex items-center justify-between gap-3 px-4 py-3 ${index > 0 ? "border-t border-[var(--color-arco-border)]" : ""}`}
          >
            <dt className="text-sm text-[var(--color-arco-text-soft)]">{row.label}</dt>
            <dd>
              {row.address ? (
                <a
                  href={`${GIWA_EXPLORER}/address/${row.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-[var(--color-arco-ink)] underline"
                >
                  {shortAddr(row.address)}
                  <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="font-mono text-xs text-[var(--color-arco-muted)]">—</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function shortAddr(address: string | null): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"
}
