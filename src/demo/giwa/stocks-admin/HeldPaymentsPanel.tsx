import { useCallback, useEffect, useReducer, useRef } from "react"
import { KeyRound, PlugZap, ShieldOff } from "lucide-react"
import { stocksAdminGet } from "./client"
import { CASH_SCALE, CASH_UNIT, formatCount, formatUtcMs, QUANTITY_SCALE } from "./format"
import { HELD_INITIAL, HELD_PAGE_SIZE, HELD_REASON_LABEL, heldPath, heldReducer, HOLD_LABEL, parseHeldPage, type HeldPayment, type HeldState } from "./held"
import { CUSTODY_STATUS, FUNDING_STATUS, lookupStatus } from "./states"
import type { StocksAdminError, StocksAdminFetch, StocksAdminSession } from "./types"
import { Amount, Button, Card, DataList, EmptyRow, FOCUS_RING, Mono, Notice, Pill, RefreshButton, Time, errorCopy, toneOf } from "./ui"

export type HeldPaymentsPanelProps = {
  readonly apiBase: string
  /** The host's SIWE operator session; null sends nothing. */
  readonly session: StocksAdminSession | null
  readonly fetch?: StocksAdminFetch
  readonly now?: () => number
  /** Link for a transaction hash (the host knows the explorer); without it the hash is shown only. */
  readonly explorerTxUrl?: (txHash: string) => string
  readonly onSignInRequired?: () => void
}

/** A new session or API base starts from an empty list: one session's rows never show under another. */
export function HeldPaymentsPanel(props: HeldPaymentsPanelProps) {
  return <HeldPaymentsScope key={JSON.stringify([props.apiBase, props.session?.id ?? null])} {...props} />
}

function HeldPaymentsScope({ apiBase, session, fetch, now = Date.now, explorerTxUrl, onSignInRequired }: HeldPaymentsPanelProps) {
  const [state, dispatch] = useReducer(heldReducer, HELD_INITIAL)
  // A rotated token keeps the list; the scope key above resets it for a different session.
  const token = useRef<string | null>(session?.accessToken ?? null)
  token.current = session?.accessToken ?? null
  const inflight = useRef<AbortController | null>(null)
  const signedIn = session !== null

  const load = useCallback(
    async (cursor: string | null) => {
      inflight.current?.abort()
      const controller = new AbortController()
      inflight.current = controller
      const append = cursor !== null
      dispatch({ type: "start", append })
      const result = await stocksAdminGet({ apiBase, path: heldPath(cursor), accessToken: token.current, signal: controller.signal, parse: parseHeldPage, fetch })
      if (controller.signal.aborted) return
      if (result.ok) dispatch({ type: "loaded", page: result.data, append, at: now() })
      else dispatch({ type: "failed", error: result.error, append })
    },
    [apiBase, fetch, now],
  )

  useEffect(() => {
    if (signedIn) void load(null)
    return () => inflight.current?.abort()
  }, [load, signedIn])

  return (
    <HeldPaymentsView
      state={state}
      signedIn={signedIn}
      now={now()}
      explorerTxUrl={explorerTxUrl}
      onRefresh={() => void load(null)}
      onLoadOlder={() => {
        if (state.nextCursor !== null) void load(state.nextCursor)
      }}
      onSignInRequired={onSignInRequired}
    />
  )
}

export type HeldPaymentsViewProps = {
  readonly state: HeldState
  readonly signedIn: boolean
  readonly now: number
  readonly explorerTxUrl?: (txHash: string) => string
  readonly onRefresh: () => void
  readonly onLoadOlder: () => void
  readonly onSignInRequired?: () => void
}

const ACCESS_COPY = {
  signed_out: { title: "Operator session required", body: "Sign in with an operator wallet. Held payments are read with that session and the server's stocks:read permission.", Icon: KeyRound },
  unauthorized: { title: "Session missing or expired (401)", body: "The server did not accept the session. Sign in again.", Icon: KeyRound },
  forbidden: { title: "No Stocks read permission (403)", body: "The server did not grant stocks:read to this session.", Icon: ShieldOff },
  disabled: { title: "Stocks admin API is not enabled on this server", body: "The held payments route is not registered (the Stocks runtime is not connected).", Icon: PlugZap },
} as const

function accessKind(signedIn: boolean, error: StocksAdminError | null): keyof typeof ACCESS_COPY | null {
  if (!signedIn || error?.kind === "unauthenticated") return "signed_out"
  if (error?.kind === "unauthorized" || error?.kind === "forbidden" || error?.kind === "disabled") return error.kind
  return null
}

function statusOf(item: HeldPayment) {
  return lookupStatus(item.side === "BUY" ? FUNDING_STATUS : CUSTODY_STATUS, item.status)
}

/** Pure view of the panel state (rendered directly by tests). */
export function HeldPaymentsView({ state, signedIn, now, explorerTxUrl, onRefresh, onLoadOlder, onSignInRequired }: HeldPaymentsViewProps) {
  const access = accessKind(signedIn, state.error)
  if (access !== null) {
    const copy = ACCESS_COPY[access]
    return (
      <section role={access === "signed_out" ? "status" : "alert"} data-testid="stocks-held-access" className="w-full rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] p-6">
        <copy.Icon aria-hidden="true" className="size-5 text-[var(--color-arco-ink)]" />
        <h2 className={`mt-2 text-sm font-semibold text-[var(--color-arco-ink)] ${FOCUS_RING}`}>{copy.title}</h2>
        <p className="mt-1 max-w-[640px] text-xs leading-5 text-[var(--color-arco-text-soft)]">{copy.body}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {onSignInRequired && (access === "signed_out" || access === "unauthorized") && <Button onClick={onSignInRequired}>Sign in with operator wallet</Button>}
          {access !== "signed_out" && <Button onClick={onRefresh}>Check access again</Button>}
        </div>
      </section>
    )
  }
  const description = (
    <>
      Direct Buy payments and direct Sell escrows the server recorded without creating an order, newest first. They do not appear in Orders.
      Returning or refunding them is not available in this console.
    </>
  )
  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-testid="stocks-held">
      <Card title="Held payments" description={description} actions={<RefreshButton onClick={onRefresh} busy={state.phase === "loading"} what="held payments" />}>
        {state.phase === "error" && state.error ? (
          <Notice tone="error" title={errorCopy(state.error).title} live>
            {errorCopy(state.error).body}
          </Notice>
        ) : state.phase !== "ready" ? (
          <EmptyRow>Loading held payments…</EmptyRow>
        ) : state.items.length === 0 ? (
          <EmptyRow>The server returned no held payments for this deployment.</EmptyRow>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">
              {formatCount(String(state.items.length))} shown{state.loadedAt !== null ? <> · first page loaded <span className="font-mono">{formatUtcMs(state.loadedAt)}</span></> : null}.
            </p>
            <DataList
              label="Held payments"
              wideClass="lg:grid-cols-[minmax(0,1fr)_minmax(0,0.5fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]"
              columns={[
                { key: "time", header: "Time" },
                { key: "side", header: "Side" },
                { key: "wallet", header: "Wallet" },
                { key: "amount", header: "Amount" },
                { key: "reason", header: "Reason" },
                { key: "status", header: "Status" },
                { key: "tx", header: "Transaction" },
              ]}
              rows={state.items.map((item) => {
                const status = statusOf(item)
                return {
                  key: `${item.side}:${item.id}`,
                  cells: {
                    time: <Time iso={item.createdAt} now={now} elapsed />,
                    side: <span className="font-mono font-semibold">{item.side === "BUY" ? "Buy" : "Sell"}</span>,
                    wallet: <Mono value={item.wallet} short />,
                    amount:
                      item.side === "BUY" ? (
                        <Amount value={item.cashAmount ?? "0"} scale={CASH_SCALE} unit={CASH_UNIT} />
                      ) : (
                        <Amount value={item.quantity ?? "0"} scale={QUANTITY_SCALE} unit="NVDA" />
                      ),
                    reason: item.hold ? (
                      <span>
                        <span className="font-semibold">{HOLD_LABEL[item.hold]}</span> <span className="block font-mono text-[11px] text-[var(--color-arco-text-soft)]">{item.hold}</span>
                      </span>
                    ) : (
                      <span>
                        {HELD_REASON_LABEL[item.reason] ?? "Recorded without an order"} <span className="block font-mono text-[11px] text-[var(--color-arco-text-soft)]">{item.reason}</span>
                      </span>
                    ),
                    status: <Pill tone={toneOf(status.category)}>{status.label}</Pill>,
                    tx: explorerTxUrl ? (
                      <a href={explorerTxUrl(item.txHash)} target="_blank" rel="noreferrer" className={`underline ${FOCUS_RING}`}>
                        <Mono value={item.txHash} short />
                      </a>
                    ) : (
                      <Mono value={item.txHash} short />
                    ),
                  },
                }
              })}
            />
            {state.appendError && (
              <Notice tone="error" title={errorCopy(state.appendError).title} live>
                The older page could not be loaded. The rows above are unchanged.
              </Notice>
            )}
            {state.nextCursor !== null && (
              <div>
                <Button onClick={onLoadOlder} disabled={state.appending}>
                  {state.appending ? "Loading older…" : `Load ${HELD_PAGE_SIZE} older`}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
