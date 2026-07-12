import { BrandMark } from "../components/BrandMark"
import type { SavingsAccount } from "./savings"

// "Savings accounts" selector (Figma 369:3878): a horizontal, scrollable row of accept-asset cards
// — icon top-left, APY% top-right, symbol bottom-left. The selected (real) card is wider (144px)
// with a green accent border; a dummy card is displayed but DISABLED (dimmed, "coming soon"), never
// selectable and with no detail. Cards fit the 505px column at desktop; overflow-x-auto covers
// narrower viewports.
export function SavingsAccountSelector({
  accounts,
  selectedKey,
  onSelect,
}: {
  accounts: SavingsAccount[]
  selectedKey: string | null
  onSelect: (account: SavingsAccount) => void
}) {
  return (
    <div className="w-full space-y-2">
      <p className="text-xs font-medium text-[var(--color-arco-muted)]">Savings accounts</p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {accounts.map((account) => {
          if (account.disabled) {
            return (
              <div
                key={account.key}
                aria-disabled="true"
                title="Coming soon"
                className="relative h-[112px] w-[112px] shrink-0 rounded-[10px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] opacity-50"
                style={{ boxShadow: "var(--shadow-savings-card)" }}
              >
                <SavingsCardFace account={account} />
                <span className="absolute bottom-3 right-3 text-[10px] leading-none text-[var(--color-arco-muted)]">
                  coming soon
                </span>
              </div>
            )
          }
          const selected = account.key === selectedKey
          return (
            <button
              key={account.key}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(account)}
              className={`relative h-[112px] shrink-0 rounded-[10px] bg-[var(--color-arco-surface)] text-left ${
                selected
                  ? "w-[144px] border border-[var(--color-arco-savings-accent)]"
                  : "w-[112px] border border-[var(--color-arco-border)]"
              }`}
              style={{ boxShadow: "var(--shadow-savings-card)" }}
            >
              <SavingsCardFace account={account} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Shared card face: icon (34px, letter fallback), APY top-right, symbol bottom-left — positions
// mirror the Figma card geometry.
function SavingsCardFace({ account }: { account: SavingsAccount }) {
  return (
    <>
      <div className="absolute left-[13px] top-[11px] size-[34px]">
        <BrandMark src={account.icon ?? undefined} label={account.symbol} size={34} />
      </div>
      <span className="absolute right-[14px] top-[14px] text-xs text-[var(--color-arco-muted)]">{account.apy}</span>
      <span className="absolute bottom-[17px] left-[16px] text-sm font-medium text-[var(--color-arco-ink)]">
        {account.symbol}
      </span>
    </>
  )
}
