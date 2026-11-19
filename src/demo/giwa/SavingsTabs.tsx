// The Savings account tabs above the card: Stablecoins (one account, the coins it takes stacked), Crypto Native (one
// tab for all its coins: their marks stacked, the lowest to the highest APY, and a menu to pick one) and Gold (one
// account, ArcoGOLD, the gold coins it takes stacked, no menu). Only the coins
// that can be saved today are shown: a coming-soon account has no mark, no part in the range and no row in the menu.
// The row scrolls sideways when the accounts outgrow the column.
//
// The Crypto Native menu: from `sm` a list under the tab (drawn in a portal, since the tab row clips what overflows it);
// on a phone a bottom sheet. Each row is a coin's mark, name and APY; the open account's row is checked. A coin added
// to the Vault Config gets a row with no change here (its name comes from COIN_NAMES, or is its symbol).

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { BottomSheet } from "./BottomSheet"
import { SAVINGS_COINS } from "./savings-assets"
import { SAVINGS_GOLD_COINS, savingsAssetCategory, savingsGoldCoin, savingsMarkIsRound } from "./savings-category"
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

/**
 * The gold coins the gold account takes, one mark per coin (PAXG, then XAUT): the coins the Vault Config lists for it
 * (PAXG or tPAXG alike), each with its own mark. Also the coins beside "Available Gold" on the card (SavingsPage.tsx).
 */
export function savingsGoldMarks(accounts: readonly Pick<SavingsAccount, "symbol" | "icon">[]): CoinMark[] {
  return SAVINGS_GOLD_COINS.filter((coin) => accounts.some((account) => savingsGoldCoin(account.symbol)?.symbol === coin.symbol)).map(
    (coin) => ({ symbol: coin.symbol, logo: coin.logo }),
  )
}

/** A tab's coins, overlapping as they are, with no ring around them, the first on top (as the card's coin stack). */
function StackedMarks({ coins }: { coins: readonly CoinMark[] }) {
  return (
    <span className="flex items-center" aria-hidden="true">
      {coins.map((coin, index) => (
        <span key={coin.symbol} className={`relative inline-flex${index > 0 ? " -ml-1.5" : ""}`} style={{ zIndex: coins.length - index }}>
          {/* A mark that is not a disc (XAUT's gem) is not cropped round, as on the card's coin stack. */}
          <BrandMark src={coin.logo ?? undefined} label={coin.symbol} size={20} shape={savingsMarkIsRound(coin.symbol) ? "round" : "rounded"} />
        </span>
      ))}
    </span>
  )
}

// The tabs share the row's width equally (it spans the card's width): each grows from nothing (flex 1 0 0%) but never
// below its own content (min-w-max), so a rate or a coin is never cut. Where the row cannot hold every tab at an equal
// share (Crypto Native's range is the widest), a tab keeps its content width and the others share what is left; where
// it cannot hold them at all (phones), the row scrolls sideways as before. Inside a tab the name sits left and the
// coins with their rate right (the button's ml-auto), so the selected look is the same size whatever the tab's width.
const GROUP =
  "-mb-px flex min-w-max flex-[1_0_0%] items-end gap-0.5 rounded-t-[22px] border-x border-t border-[var(--color-arco-border)] bg-[var(--color-arco-page)] px-1.5 pt-2"
const PILL_BASE =
  "ml-auto inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-t-[16px] px-2.5 text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] motion-reduce:transition-none"
const PILL_ON = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const PILL_OFF = "text-[var(--color-arco-text-soft)] hover:bg-[var(--color-arco-chip)]"
const APY = "tabular-nums text-[var(--color-arco-text-soft)]"

/** Full names for the menu rows; a coin not listed here shows its symbol alone. */
const COIN_NAMES: Record<string, string> = { ETH: "Ethereum", XRP: "XRP", BTC: "Bitcoin", SOL: "Solana" }

export function savingsCoinName(symbol: string): string {
  return COIN_NAMES[symbol.toUpperCase()] ?? symbol
}

/**
 * The lowest to the highest APY among the accounts, as they are written ("3.86% ~ 4.57%"); one figure when they are
 * the same or there is one account; null when no account has a figure (an APY shown as a dash has no part in it).
 */
export function savingsApyRange(accounts: readonly Pick<SavingsAccount, "apy">[]): string | null {
  const rated = accounts
    .map((account) => ({ text: account.apy, value: Number.parseFloat(account.apy) }))
    .filter((entry) => Number.isFinite(entry.value))
  if (rated.length === 0) return null
  const low = rated.reduce((a, b) => (b.value < a.value ? b : a))
  const high = rated.reduce((a, b) => (b.value > a.value ? b : a))
  return low.value === high.value ? low.text : `${low.text} ~ ${high.text}`
}

// useLayoutEffect warns when rendered on the server (the static-markup tests); there it has nothing to place anyway.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

const SM_QUERY = "(min-width: 640px)"
const MENU_WIDTH = 260
const ROW =
  "flex min-h-12 w-full items-center gap-3 rounded-[12px] px-3 text-left text-sm text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)] focus-visible:bg-[var(--color-arco-chip)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

/** The list under the tab from `sm`; below it, the bottom sheet. Without matchMedia (tests, old browsers): the list. */
function wideViewport(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(SM_QUERY).matches
}

function CoinRows({
  accounts,
  selectedKey,
  onPick,
}: {
  accounts: readonly SavingsAccount[]
  selectedKey: string | null
  onPick: (account: SavingsAccount) => void
}) {
  return (
    <>
      {accounts.map((account) => {
        const selected = account.key === selectedKey
        const name = savingsCoinName(account.symbol)
        return (
          <button key={account.key} type="button" role="menuitemradio" aria-checked={selected} data-coin={account.symbol} onClick={() => onPick(account)} className={ROW}>
            <BrandMark src={account.icon ?? undefined} label={account.symbol} size={24} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{name}</span>
              {name !== account.symbol && <span className="text-xs text-[var(--color-arco-text-soft)]">{account.symbol}</span>}
            </span>
            <span className="tabular-nums">{account.apy}</span>
            <Check aria-hidden="true" className={`size-4 shrink-0 ${selected ? "" : "invisible"}`} />
          </button>
        )
      })}
    </>
  )
}

function CryptoNativeTab({
  accounts,
  selectedKey,
  onSelect,
}: {
  accounts: readonly SavingsAccount[]
  selectedKey: string | null
  onSelect: (account: SavingsAccount) => void
}) {
  const id = useId()
  const menuId = `${id}-menu`
  const [open, setOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = accounts.find((account) => account.key === selectedKey) ?? null
  const range = savingsApyRange(accounts)

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const pick = (account: SavingsAccount) => {
    setSheetOpen(false)
    close(true)
    onSelect(account)
  }

  // Under the tab, kept inside the window.
  const anchorPlace = () => {
    if (!buttonRef.current) return
    const anchor = buttonRef.current.getBoundingClientRect()
    const next = { left: Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8)), top: anchor.bottom + 6 }
    setPlace((current) => (current && current.left === next.left && current.top === next.top ? current : next))
  }
  // Before the open list is painted: placed; then focus on the open account's row (or the first).
  useIsomorphicLayoutEffect(() => {
    if (open) anchorPlace()
    else setPlace(null)
  }, [open])
  const placed = place !== null
  useEffect(() => {
    if (!open || !placed) return
    const rows = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    const current = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
    ;(current ?? rows?.[0])?.focus({ preventScroll: true })
  }, [open, placed])

  // While the list is open: a press elsewhere closes it; a scroll or a resize keeps it under the tab.
  useEffect(() => {
    if (!open) return
    const onPress = (event: Event) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPress)
    window.addEventListener("resize", anchorPlace)
    window.addEventListener("scroll", anchorPlace, true)
    return () => {
      document.removeEventListener("pointerdown", onPress)
      window.removeEventListener("resize", anchorPlace)
      window.removeEventListener("scroll", anchorPlace, true)
    }
  }, [open])

  // Arrow keys, Home and End move between the rows of whichever menu they are pressed in (the list or the sheet).
  const onRowKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => {
      event.preventDefault()
      rows[(index + rows.length) % rows.length]?.focus()
    }
    if (event.key === "ArrowDown") go(at + 1)
    else if (event.key === "ArrowUp") go(at - 1)
    else if (event.key === "Home") go(0)
    else if (event.key === "End") go(rows.length - 1)
  }
  // The list also closes on Escape and on Tab. Focus goes back to the tab first, so Tab moves on from the tab and not
  // from the end of the page, where the list's portal is. (The sheet has its own Escape and keeps Tab inside itself.)
  const onListKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onRowKeys(event)
    if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    } else if (event.key === "Tab") close(true)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-crypto-tab=""
        data-selected={selected !== null}
        aria-haspopup="menu"
        aria-expanded={open || sheetOpen}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          // One or the other, never both (the window may have crossed `sm` since the last press).
          if (wideViewport()) {
            setSheetOpen(false)
            setOpen((current) => !current)
          } else {
            setOpen(false)
            setSheetOpen(true)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && wideViewport()) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={`${PILL_BASE} ${selected ? PILL_ON : PILL_OFF}`}
      >
        {/* Stacked as the Stablecoins tab stacks its coins: no ring, the first on top. */}
        <span className="flex items-center" aria-hidden="true">
          {accounts.map((account, index) => (
            <span key={account.key} className={`relative inline-flex${index > 0 ? " -ml-1.5" : ""}`} style={{ zIndex: accounts.length - index }}>
              <BrandMark src={account.icon ?? undefined} label={account.symbol} size={20} />
            </span>
          ))}
        </span>
        {/* Read out in full; the figures on show are for the eye ("~" reads poorly). */}
        <span className="sr-only">
          {`Crypto Native: ${accounts.map((account) => account.symbol).join(", ")}`}
          {range ? `, ${range.replace(" ~ ", " to ")} APY` : ""}
          {selected ? `; ${selected.symbol} selected` : ""}
        </span>
        {range && (
          <span aria-hidden="true" className={APY}>
            {range}
          </span>
        )}
        <ChevronDown aria-hidden="true" className={`size-4 text-[var(--color-arco-text-soft)] transition-transform duration-150 motion-reduce:transition-none${open ? " rotate-180" : ""}`} />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          // .arco-demo: the portal is outside the app's root, where the tokens are set.
          <div className="arco-demo">
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label="Crypto Native"
              onKeyDown={onListKeys}
              style={{ left: place?.left ?? 0, top: place?.top ?? 0, width: MENU_WIDTH, visibility: place ? "visible" : "hidden" }}
              className="fixed z-50 max-h-[60vh] overflow-y-auto rounded-[16px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-1.5 shadow-[var(--shadow-savings-popover)]"
            >
              <CoinRows accounts={accounts} selectedKey={selectedKey} onPick={pick} />
            </div>
          </div>,
          document.body,
        )}

      <BottomSheet id={`${id}-sheet`} open={sheetOpen} onClose={() => setSheetOpen(false)} label="Crypto Native" returnFocusTo={buttonRef}>
        <div role="menu" aria-label="Crypto Native" onKeyDown={onRowKeys} className="pb-2">
          <CoinRows accounts={accounts} selectedKey={selectedKey} onPick={pick} />
        </div>
      </BottomSheet>
    </>
  )
}

function GroupLabel({ label }: { label: string }) {
  return <span className="flex min-h-11 items-center whitespace-nowrap px-1.5 text-[13px] font-medium text-[var(--color-arco-text-soft)]">{label}</span>
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
  // Only what can be saved today: a coming-soon coin is left out until it is supported.
  const crypto = accounts.filter((account) => savingsAssetCategory(account.symbol) === "crypto-native" && !account.disabled)
  const stableDefault = stable.find((account) => !account.disabled) ?? null
  const stableSelected = stable.some((account) => account.key === selectedKey)
  const stableCoins = stablecoinMarks(stable)
  // The gold account: one vault (ArcoGOLD) whichever gold coin pays in, so one tab like Stablecoins.
  const gold = accounts.filter((account) => savingsAssetCategory(account.symbol) === "gold")
  const goldDefault = gold.find((account) => !account.disabled) ?? null
  const goldSelected = gold.some((account) => account.key === selectedKey)
  const goldCoins = savingsGoldMarks(gold)

  return (
    // Edge to edge with the card. overflow-y-hidden: the tabs' -mb-px (over the row's bottom line) made the row 1px
    // taller than its box, so a sideways-scrolling row also scrolled up and down and showed a scrollbar at its right end.
    <nav aria-label="Savings accounts" className="flex w-full items-end gap-1.5 overflow-x-auto overflow-y-hidden border-b border-[var(--color-arco-border)]">
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
            <StackedMarks coins={stableCoins} />
            <span className="sr-only">{stableCoins.map((coin) => coin.symbol).join(", ")}</span>
            {stableDefault && <span className={APY}>{stableDefault.apy}</span>}
          </button>
        </div>
      )}
      {crypto.length > 0 && (
        <div className={GROUP}>
          <GroupLabel label="Crypto Native" />
          <CryptoNativeTab accounts={crypto} selectedKey={selectedKey} onSelect={onSelect} />
        </div>
      )}
      {gold.length > 0 && (
        <div className={GROUP}>
          <GroupLabel label="Gold" />
          <button
            type="button"
            data-gold-tab=""
            aria-pressed={goldSelected}
            disabled={goldDefault === null}
            onClick={() => goldDefault && onSelect(goldDefault)}
            className={`${PILL_BASE} ${goldSelected ? PILL_ON : PILL_OFF} disabled:opacity-50`}
          >
            <StackedMarks coins={goldCoins} />
            <span className="sr-only">{goldCoins.map((coin) => coin.symbol).join(", ")}</span>
            {goldDefault && <span className={APY}>{goldDefault.apy}</span>}
          </button>
        </div>
      )}
    </nav>
  )
}
