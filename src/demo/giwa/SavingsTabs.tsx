// The Savings account tabs above the card: Stablecoins (one account, the coins it takes stacked) and Crypto Native (one
// chip per coin). A coming-soon account is shown dimmed and cannot be picked. The row scrolls sideways when the accounts
// outgrow the column.

import { BrandMark } from "../components/BrandMark"
import { SAVINGS_COINS } from "./savings-assets"
import { savingsAssetCategory } from "./savings-category"
import type { SavingsAccount } from "./savings"

type CoinMark = { symbol: string; logo: string | null }

/**
 * The coins the stablecoin account takes, one mark per coin: every coin its deposit and withdraw screens offer, with
 * the marks they show (savings-assets.ts), then any other stablecoin the Vault Config lists for it.
 */
function stablecoinMarks(accounts: readonly SavingsAccount[]): CoinMark[] {
  const marks: CoinMark[] = SAVINGS_COINS.map((coin) => ({ symbol: coin.symbol, logo: coin.logo }))
  const listed = new Set(marks.map((mark) => mark.symbol.toUpperCase()))
  for (const account of accounts) {
    const coin = account.symbol.toUpperCase()
    if (listed.has(coin)) continue
    listed.add(coin)
    marks.push({ symbol: account.symbol, logo: account.icon })
  }
  return marks
}

const GROUP =
  "-mb-px flex shrink-0 items-end gap-1 rounded-t-[22px] border-x border-t border-[var(--color-arco-border)] bg-[var(--color-arco-page)] px-2 pt-2"
const PILL_BASE =
  "inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-t-[16px] px-3 text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] motion-reduce:transition-none"
const PILL_ON = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const PILL_OFF = "text-[var(--color-arco-text-soft)] hover:bg-[var(--color-arco-chip)]"
const APY = "tabular-nums text-[var(--color-arco-text-soft)]"

function GroupLabel({ label }: { label: string }) {
  return <span className="flex min-h-11 items-center whitespace-nowrap px-2 text-[13px] font-medium text-[var(--color-arco-text-soft)]">{label}</span>
}

export function SavingsTabs({
  accounts,
  selectedKey,
  onSelect,
}: {
  accounts: readonly SavingsAccount[]
  selectedKey: string | null
  onSelect: (account: SavingsAccount) => void
}) {
  const stable = accounts.filter((account) => savingsAssetCategory(account.symbol) === "stablecoins")
  const crypto = accounts.filter((account) => savingsAssetCategory(account.symbol) === "crypto-native")
  const stableDefault = stable.find((account) => !account.disabled) ?? null
  const stableSelected = stable.some((account) => account.key === selectedKey)
  const stableCoins = stablecoinMarks(stable)

  return (
    <nav aria-label="Savings accounts" className="flex w-full items-end gap-2 overflow-x-auto border-b border-[var(--color-arco-border)] px-1">
      {stable.length > 0 && (
        <div className={GROUP}>
          <GroupLabel label="Stablecoins" />
          <button
            type="button"
            aria-pressed={stableSelected}
            disabled={stableDefault === null}
            onClick={() => stableDefault && onSelect(stableDefault)}
            className={`${PILL_BASE} ${stableSelected ? PILL_ON : PILL_OFF} disabled:opacity-50`}
          >
            {/* The marks overlap as they are, with no ring around them, the first on top (as the card's coin stack). */}
            <span className="flex items-center" aria-hidden="true">
              {stableCoins.map((coin, index) => (
                <span
                  key={coin.symbol}
                  className={`relative inline-flex${index > 0 ? " -ml-1.5" : ""}`}
                  style={{ zIndex: stableCoins.length - index }}
                >
                  <BrandMark src={coin.logo ?? undefined} label={coin.symbol} size={20} />
                </span>
              ))}
            </span>
            <span className="sr-only">{stableCoins.map((coin) => coin.symbol).join(", ")}</span>
            {stableDefault && <span className={APY}>{stableDefault.apy}</span>}
          </button>
        </div>
      )}
      {crypto.length > 0 && (
        <div className={GROUP}>
          <GroupLabel label="Crypto Native" />
          {crypto.map((account) => {
            const selected = account.key === selectedKey
            return (
              <button
                key={account.key}
                type="button"
                aria-pressed={selected}
                disabled={account.disabled}
                title={account.disabled ? "Coming soon" : undefined}
                onClick={() => onSelect(account)}
                className={`${PILL_BASE} ${selected ? PILL_ON : PILL_OFF} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <BrandMark src={account.icon ?? undefined} label={account.symbol} size={20} />
                <span>{account.symbol}</span>
                <span className={APY}>{account.disabled ? "Soon" : account.apy}</span>
              </button>
            )
          })}
        </div>
      )}
    </nav>
  )
}
