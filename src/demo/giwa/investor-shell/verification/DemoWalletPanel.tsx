// DEMO ONLY: the demo wallet's window, floating over the preview at the bottom right (?wallet=demo). It stands in for a
// wallet's own popup: a request from the page (connect, approve, deposit, withdraw) waits here for Confirm or Reject.
// Otherwise it shows the demo account's balances, the auto-confirm switch and Reset. Never rendered by the app.
//
// It is its own layer (role="dialog", above the app's full-screen dialogs) and never takes focus, so the app's own
// focus handling is what you see.

import { useState, useSyncExternalStore } from "react"
import { ChevronDown } from "lucide-react"
import { shortAddress, type DemoPrompt, type DemoWallet } from "./demo-wallet"

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const SOFT = "text-[var(--color-arco-text-soft)]"
const PRIMARY = `inline-flex min-h-10 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-arco-ink)] px-4 text-sm font-medium text-[var(--color-arco-on-dark)] ${FOCUS}`
const SECONDARY = `inline-flex min-h-10 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-4 text-sm font-medium text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-border)] ${FOCUS}`

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="space-y-1.5 rounded-[12px] bg-[var(--color-arco-surface-muted)] p-3 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-3">
          <dt className={SOFT}>{label}</dt>
          <dd className="text-right tabular-nums text-[var(--color-arco-ink)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Prompt({ prompt, waiting, wallet }: { prompt: DemoPrompt; waiting: number; wallet: DemoWallet }) {
  return (
    <div className="border-t border-[var(--color-arco-border)] px-4 pb-4 pt-3">
      <p className={`text-xs ${SOFT}`}>{prompt.kind === "connect" ? "Connection request" : "Transaction request"}</p>
      <p className="mt-1 text-base font-medium leading-6 text-[var(--color-arco-ink)]">{prompt.title}</p>
      {prompt.detail !== null && <p className={`mt-0.5 text-sm ${SOFT}`}>{prompt.detail}</p>}
      <div className="mt-3">
        <Rows rows={prompt.rows} />
      </div>
      {waiting > 0 && <p className={`mt-2 text-xs ${SOFT}`}>{waiting} more waiting</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className={SECONDARY} onClick={() => wallet.reject(prompt.id)}>
          Reject
        </button>
        <button type="button" className={PRIMARY} onClick={() => wallet.confirm(prompt.id)}>
          {prompt.kind === "connect" ? "Connect" : "Confirm"}
        </button>
      </div>
    </div>
  )
}

function Details({ wallet }: { wallet: DemoWallet }) {
  const view = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot)
  const [resetting, setResetting] = useState(false)
  const { chain } = view
  const rows: (readonly [string, string])[] = [
    ["ETH (gas)", chain.native],
    ...chain.assets.map((asset) => [asset.symbol, asset.amount] as const),
    ...chain.shares.map((share) => [share.symbol, share.amount] as const),
  ]
  if (chain.pendingWithdrawals > 0) rows.push(["Withdrawal requests", String(chain.pendingWithdrawals)])
  return (
    <div className="border-t border-[var(--color-arco-border)] px-4 pb-4 pt-3">
      <Rows rows={rows} />
      <label className="mt-3 flex min-h-10 cursor-pointer items-center justify-between gap-3 text-sm text-[var(--color-arco-ink)]">
        <span>
          Auto-confirm
          <span className={`block text-xs ${SOFT}`}>Requests confirm themselves after a moment.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={view.autoConfirm}
          onChange={(event) => wallet.setAutoConfirm(event.target.checked)}
          className={`size-4 shrink-0 accent-[var(--color-arco-ink)] ${FOCUS}`}
        />
      </label>
      {resetting ? (
        <div className="mt-3 rounded-[12px] border border-[var(--color-arco-border)] p-3">
          <p className="text-sm text-[var(--color-arco-ink)]">Reset the demo? Balances go back to the start and the page disconnects.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className={SECONDARY} onClick={() => setResetting(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={PRIMARY}
              onClick={() => {
                setResetting(false)
                wallet.reset()
              }}
            >
              Reset
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={`${SECONDARY} mt-3 w-full`} onClick={() => setResetting(true)}>
          Reset demo
        </button>
      )}
      <p className={`mt-3 text-[11px] leading-4 ${SOFT}`}>Demo only: no real wallet, chain or funds. Explorer links will not open.</p>
    </div>
  )
}

export function DemoWalletPanel({ wallet }: { wallet: DemoWallet }) {
  const view = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot)
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="arco-demo">
      <section
        role="dialog"
        aria-label="Demo wallet"
        data-testid="demo-wallet"
        className="fixed bottom-4 right-4 z-[70] w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)] shadow-[var(--shadow-table)]"
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="flex min-h-12 w-full items-center gap-2 px-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
        >
          <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-ink)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-arco-on-dark)]">
            DEMO
          </span>
          <span className="text-sm font-medium">Demo wallet</span>
          <span className={`ml-auto text-xs tabular-nums ${SOFT}`}>{view.connected ? shortAddress(view.account) : "Not connected"}</span>
          <ChevronDown aria-hidden="true" className={`size-4 shrink-0 ${SOFT} transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
        </button>
        <div aria-live="polite">{view.prompt !== null && <Prompt prompt={view.prompt} waiting={view.waiting} wallet={wallet} />}</div>
        {view.prompt === null && expanded && <Details wallet={wallet} />}
      </section>
    </div>
  )
}
