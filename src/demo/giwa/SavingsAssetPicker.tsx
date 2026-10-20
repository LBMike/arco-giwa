// The token picker the Savings deposit and withdraw screens open on their coin: every stablecoin on every chain it is
// issued on, each with its chain's badge and the wallet's balance, the coins the wallet holds first (largest first). A
// search and a network menu (All Networks, then the chains with a balance, then the others) narrow the list. A coin the
// vault cannot take yet is listed as coming soon and cannot be picked.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Check, ChevronDown, Search, Wallet, X } from "lucide-react"
import { SavingsDialog } from "./SavingsDialog"
import { ChainIcon, ChainStack, CoinMark } from "./SavingsCoinMark"
import { chainName, chainsWithBalance, pickerSections, SAVINGS_CHAINS, type SavingsAssetChoice, type SavingsChainId } from "./savings-assets"
import { tokenAmount, usd } from "./savings-format"

const SOFT = "text-[var(--color-arco-text-soft)]"
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

type NetworkValue = SavingsChainId | "all"

function MenuItem({ checked, onSelect, icon, children }: { checked: boolean; onSelect: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-page)] focus-visible:bg-[var(--color-arco-page)] focus-visible:outline-none`}
    >
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
      {checked && <Check aria-hidden="true" className="size-4 shrink-0" />}
    </button>
  )
}

/** The network menu in the search field. While open it handles its own Escape (the dialog leaves it to it). */
function NetworkFilter({ value, onChange, withBalance }: { value: NetworkValue; onChange: (value: NetworkValue) => void; withBalance: readonly SavingsChainId[] }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const others = SAVINGS_CHAINS.map((chain) => chain.id).filter((id) => !withBalance.includes(id))
  const label = value === "all" ? "All Networks" : chainName(value)

  const items = () => Array.from(wrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
  // Opening moves focus to the checked network; a press outside the menu closes it.
  useEffect(() => {
    if (!open) return
    const list = items()
    ;(list.find((item) => item.getAttribute("aria-checked") === "true") ?? list[0])?.focus()
    function onPointer(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    return () => document.removeEventListener("mousedown", onPointer)
  }, [open])

  function choose(next: NetworkValue) {
    onChange(next)
    setOpen(false)
    buttonRef.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (event.key === "Escape") {
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
      return
    }
    if (event.key === "Tab") {
      setOpen(false)
      return
    }
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      list[(at + step + list.length) % list.length]?.focus()
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      ;(event.key === "Home" ? list[0] : list[list.length - 1])?.focus()
    }
  }

  return (
    <div ref={wrapRef} className="relative shrink-0" data-escape-layer={open ? "" : undefined} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Network: ${label}`}
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex h-9 items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)] pl-2 pr-1.5 ring-1 ring-[var(--color-arco-border)] hover:bg-[var(--color-arco-chip)] ${FOCUS}`}
      >
        {value === "all" ? <ChainStack size={16} /> : <span aria-hidden="true" className="inline-flex"><ChainIcon chain={value} size={18} /></span>}
        <ChevronDown aria-hidden="true" className={`size-4 ${SOFT}`} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Networks"
          className="absolute right-0 top-full z-20 mt-2 w-56 rounded-[16px] bg-[var(--color-arco-surface)] p-1.5 shadow-[var(--shadow-savings-popover)] ring-1 ring-[var(--color-arco-border)]"
        >
          <MenuItem checked={value === "all"} onSelect={() => choose("all")} icon={<ChainStack size={16} />}>
            All Networks
          </MenuItem>
          {withBalance.length > 0 && <p className={`px-2.5 pb-1 pt-2.5 text-[11px] ${SOFT}`}>With balance</p>}
          {withBalance.map((id) => (
            <MenuItem key={id} checked={value === id} onSelect={() => choose(id)} icon={<span aria-hidden="true" className="inline-flex"><ChainIcon chain={id} size={18} /></span>}>
              {chainName(id)}
            </MenuItem>
          ))}
          {others.length > 0 && <p className={`px-2.5 pb-1 pt-2.5 text-[11px] ${SOFT}`}>{withBalance.length > 0 ? "Other Networks" : "Networks"}</p>}
          {others.map((id) => (
            <MenuItem key={id} checked={value === id} onSelect={() => choose(id)} icon={<span aria-hidden="true" className="inline-flex"><ChainIcon chain={id} size={18} /></span>}>
              {chainName(id)}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  )
}

function ChoiceRow({ choice, selected, onSelect }: { choice: SavingsAssetChoice; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        disabled={!choice.available}
        aria-pressed={selected}
        data-choice={choice.key}
        onClick={onSelect}
        className={`flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left hover:bg-[var(--color-arco-page)] aria-pressed:bg-[var(--color-arco-page)] disabled:cursor-not-allowed disabled:hover:bg-transparent ${FOCUS}`}
      >
        <span className={choice.available ? "inline-flex" : "inline-flex opacity-50"}>
          <CoinMark src={choice.logo} label={choice.symbol} chain={choice.chain} size={40} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[15px] font-medium leading-5 ${choice.available ? "text-[var(--color-arco-ink)]" : SOFT}`}>{choice.symbol}</span>
          <span className={`block text-[13px] leading-5 ${SOFT}`}>
            <span className="sr-only">on </span>
            {choice.chainName}
          </span>
        </span>
        {choice.available ? (
          <span className="shrink-0 text-right tabular-nums">
            <span className="block text-[15px] font-medium leading-5 text-[var(--color-arco-ink)]">
              <span className="sr-only">Balance </span>
              {choice.balance !== null ? tokenAmount(choice.balance, 2) : "—"}
            </span>
            {choice.usd !== null && <span className={`block text-[13px] leading-5 ${SOFT}`}>{usd(choice.usd)}</span>}
          </span>
        ) : (
          <span className={`shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] font-medium ${SOFT}`}>Coming soon</span>
        )}
        {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-[var(--color-arco-ink)]" />}
      </button>
    </li>
  )
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mt-3 first:mt-0">
      <h3 id={id} className={`flex items-center gap-1.5 px-2 pb-1 text-xs ${SOFT}`}>
        {icon}
        {title}
      </h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  )
}

export function SavingsAssetPicker({
  open,
  onClose,
  title = "Select a token",
  choices,
  selected,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  title?: string
  choices: readonly SavingsAssetChoice[]
  /** The option in use. */
  selected: string
  onSelect: (key: string) => void
}) {
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [network, setNetwork] = useState<NetworkValue>("all")
  // Every opening starts on the whole list.
  useEffect(() => {
    if (!open) return
    setQuery("")
    setNetwork("all")
  }, [open])

  const { held, other } = pickerSections(choices, { chain: network, query })
  const row = (choice: SavingsAssetChoice) => (
    <ChoiceRow key={choice.key} choice={choice} selected={choice.key === selected} onSelect={() => onSelect(choice.key)} />
  )
  return (
    <SavingsDialog open={open} onClose={onClose} labelledBy={titleId} size="narrow" initialFocus={searchRef}>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-medium text-[var(--color-arco-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] ${SOFT} hover:bg-[var(--color-arco-border)] ${FOCUS}`}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="mt-4 flex h-12 items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-page)] pl-4 pr-1.5 ring-1 ring-[var(--color-arco-border)] focus-within:ring-[var(--color-arco-ink)]">
          <Search aria-hidden="true" className={`size-4 shrink-0 ${SOFT}`} />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search token"
            placeholder="Search token"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]"
          />
          <NetworkFilter value={network} onChange={setNetwork} withBalance={chainsWithBalance(choices)} />
        </div>
        <div className="-mx-1 mt-4 max-h-[min(420px,55vh)] overflow-y-auto px-1">
          {held.length > 0 && (
            <Section title="Your tokens" icon={<Wallet aria-hidden="true" className="size-3.5" />}>
              {held.map(row)}
            </Section>
          )}
          {other.length > 0 && <Section title={held.length > 0 ? "Other tokens" : "Tokens"}>{other.map(row)}</Section>}
          {held.length + other.length === 0 && (
            <p className={`px-2 py-8 text-center text-sm ${SOFT}`}>
              No tokens match{query.trim() !== "" ? ` “${query.trim()}”` : ""}
              {network !== "all" ? ` on ${chainName(network)}` : ""}.
            </p>
          )}
        </div>
      </div>
    </SavingsDialog>
  )
}
