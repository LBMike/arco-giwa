import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react"
import { KeyRound, PlugZap, ShieldOff } from "lucide-react"
import { formatDuration, formatUtc } from "../stocks-admin/format"
import { Button, Card, DataList, EmptyRow, FOCUS_RING, Field, Fields, Mono, Notice, Pill, ResourceMeta, Time, errorCopy, type Tone } from "../stocks-admin/ui"
import { newLimitIdempotencyKey, readTradingLimitHistory, readTradingLimits, sendTradingLimitChange } from "./client"
import {
  HISTORY_LIMIT,
  LIMIT_CASH_UNIT,
  capText,
  cashText,
  checkCapInput,
  describeChange,
  describeEvent,
  limitStatus,
  onWord,
  sideWord,
  usedShare,
  type LimitStatus,
} from "./parse"
import { LIMITS_INITIAL, checkDraft, commandFor, limitsReducer, type DraftPatch, type LimitCommandState, type LimitDraft, type LimitOutcome, type LimitsState } from "./state"
import type { StocksAdminError, StocksLimitsPanelProps, TradingLimitRow, TradingSide } from "./types"

export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000

/** A new session or API base starts empty: one session's limits never show under another. */
export function StocksLimitsPanel(props: StocksLimitsPanelProps) {
  return <LimitsScope key={JSON.stringify([props.apiBase, props.session?.id ?? null])} {...props} />
}

/** Re-renders on an interval so "resets in" moves on; every render samples the clock itself. */
function useTicker(intervalMs: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}

function LimitsScope({
  apiBase,
  session,
  canControl,
  fetch,
  now = Date.now,
  onSignInRequired,
  newIdempotencyKey = newLimitIdempotencyKey,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}: StocksLimitsPanelProps) {
  const [state, dispatch] = useReducer(limitsReducer, LIMITS_INITIAL)
  // A rotated token keeps the data; the scope key above resets it for a different session.
  const token = useRef<string | null>(session?.accessToken ?? null)
  token.current = session?.accessToken ?? null
  const reads = useRef<AbortController | null>(null)
  const sending = useRef<AbortController | null>(null)
  // One change at a time, also across two clicks that land before the next render.
  const inflight = useRef(false)
  const alive = useRef(true)
  const signedIn = session !== null
  useTicker(30_000)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      reads.current?.abort()
      sending.current?.abort()
    }
  }, [])

  const load = useCallback(async () => {
    reads.current?.abort()
    const controller = new AbortController()
    reads.current = controller
    dispatch({ type: "limits/start" })
    dispatch({ type: "history/start" })
    const common = { apiBase, accessToken: token.current, signal: controller.signal, fetch }
    const [limits, history] = await Promise.all([readTradingLimits(common), readTradingLimitHistory(common)])
    if (controller.signal.aborted || !alive.current) return
    const at = now()
    dispatch(limits.ok ? { type: "limits/loaded", data: limits.data, meta: limits.meta, at } : { type: "limits/failed", error: limits.error })
    dispatch(history.ok ? { type: "history/loaded", data: history.data, meta: history.meta, at } : { type: "history/failed", error: history.error })
  }, [apiBase, fetch, now])

  useEffect(() => {
    if (signedIn) void load()
  }, [load, signedIn])

  const run = useCallback(
    async (next: LimitCommandState) => {
      inflight.current = true
      const controller = new AbortController()
      sending.current = controller
      // No answer in time is an unknown outcome (the change may have been recorded), never a refusal.
      const timer = setTimeout(() => controller.abort(), commandTimeoutMs)
      const result = await sendTradingLimitChange({ apiBase, accessToken: token.current, signal: controller.signal, fetch, symbol: next.symbol, side: next.side, command: next.command })
      clearTimeout(timer)
      inflight.current = false
      if (!alive.current) return
      dispatch({ type: "result", key: next.command.idempotencyKey, result })
      // A saved change and a version conflict both mean the stored setting moved on: read it again.
      if (result.ok || (result.error.status === 409 && result.error.code === "LIMIT_VERSION_CONFLICT")) void load()
    },
    [apiBase, fetch, commandTimeoutMs, load],
  )

  return (
    <LimitsView
      state={state}
      signedIn={signedIn}
      canControl={canControl}
      now={now()}
      onRefresh={() => void load()}
      onEdit={(symbol, side) => dispatch({ type: "edit", symbol, side })}
      onDraft={(patch) => dispatch({ type: "draft", patch })}
      onReview={() => dispatch({ type: "review" })}
      onBack={() => dispatch({ type: "back" })}
      onCancel={() => dispatch({ type: "cancel" })}
      onConfirm={() => {
        if (inflight.current || state.command !== null || !canControl) return
        const next = commandFor(state.draft, newIdempotencyKey())
        if (next === null) return
        dispatch({ type: "send", command: next })
        void run(next)
      }}
      onRetry={() => {
        const current = state.command
        if (inflight.current || current === null || current.phase !== "unknown") return
        dispatch({ type: "retry" })
        // The frozen change and key: if the first attempt was recorded, the server replays it instead of recording twice.
        void run({ ...current, phase: "sending", attempts: current.attempts + 1, error: null })
      }}
      onDiscard={() => {
        dispatch({ type: "discard" })
        void load()
      }}
      onDismiss={() => dispatch({ type: "dismiss" })}
      onSignInRequired={onSignInRequired}
    />
  )
}

export type LimitsViewProps = {
  readonly state: LimitsState
  readonly signedIn: boolean
  readonly canControl: boolean
  readonly now: number
  readonly onRefresh: () => void
  readonly onEdit: (symbol: string, side: TradingSide) => void
  readonly onDraft: (patch: DraftPatch) => void
  readonly onReview: () => void
  readonly onBack: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly onRetry: () => void
  readonly onDiscard: () => void
  readonly onDismiss: () => void
  readonly onSignInRequired?: () => void
}

const ACCESS_COPY = {
  signed_out: { title: "Operator session required", body: "Sign in with an operator wallet. Trading limits are read with that session and the server's stocks:read permission.", Icon: KeyRound },
  unauthorized: { title: "Session missing or expired (401)", body: "The server did not accept the session. Sign in again.", Icon: KeyRound },
  forbidden: { title: "No Stocks read permission (403)", body: "The server did not grant stocks:read to this session.", Icon: ShieldOff },
  disabled: {
    title: "Trading limits are not turned on for this server",
    body: "The limits routes are not registered: the API runs without STOCKS_TRADING_LIMITS=1, or the Stocks runtime is not connected. Until they are turned on no per-stock limit applies; Trading control still does.",
    Icon: PlugZap,
  },
} as const

function accessKind(signedIn: boolean, error: StocksAdminError | null): keyof typeof ACCESS_COPY | null {
  if (!signedIn || error?.kind === "unauthenticated") return "signed_out"
  if (error?.kind === "unauthorized" || error?.kind === "forbidden" || error?.kind === "disabled") return error.kind
  return null
}

const STATUS: Record<LimitStatus, { label: string; tone: Tone }> = {
  on: { label: "On", tone: "positive" },
  off: { label: "Off", tone: "negative" },
  cap_reached: { label: "Cap reached", tone: "attention" },
}

function target(symbol: string, side: TradingSide): string {
  return `${symbol} ${sideWord(side)}`
}

/** Pure view of the panel state (rendered directly by tests). */
export function LimitsView(props: LimitsViewProps) {
  const { state, signedIn, canControl, now, onRefresh, onSignInRequired } = props
  const access = accessKind(signedIn, state.limits.error)
  if (access !== null) {
    const copy = ACCESS_COPY[access]
    return (
      <section role={access === "signed_out" ? "status" : "alert"} data-testid="stocks-limits-access" className="w-full rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] p-6">
        <copy.Icon aria-hidden="true" className="size-5 text-[var(--color-arco-ink)]" />
        <h2 className="mt-2 text-sm font-semibold text-[var(--color-arco-ink)]">{copy.title}</h2>
        <p className="mt-1 max-w-[640px] text-xs leading-5 text-[var(--color-arco-text-soft)]">{copy.body}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {onSignInRequired && (access === "signed_out" || access === "unauthorized") && <Button onClick={onSignInRequired}>Sign in with operator wallet</Button>}
          {access !== "signed_out" && <Button onClick={onRefresh}>Check again</Button>}
        </div>
      </section>
    )
  }
  const read = state.limits.value?.data ?? null
  const description = (
    <>
      Turn buying or selling of each stock on or off, and cap what all wallets together may trade on a side in one day (00:00 to 24:00 KST). A change applies to new
      quotes and orders at once; orders already created are not cancelled. Trading control still comes first: while it pauses trading, nothing trades.
    </>
  )
  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-testid="stocks-limits">
      <Card title="Trading limits" description={description}>
        <div className="flex min-w-0 flex-col gap-3">
          <ResourceMeta state={state.limits} now={now} onRefresh={onRefresh} what="trading limits" />
          {read && <DayLine start={read.window.start} resetsAt={read.window.resetsAt} now={now} />}
          {state.outcome && <OutcomeNotice outcome={state.outcome} onDismiss={props.onDismiss} />}
          {state.command && <CommandNotice command={state.command} onRetry={props.onRetry} onDiscard={props.onDiscard} />}
          {read === null ? (
            <EmptyRow>{state.limits.phase === "error" ? "The limits could not be read." : "Reading the limits…"}</EmptyRow>
          ) : (
            <DataList
              label="Trading limits"
              wideClass="lg:grid-cols-[minmax(0,0.6fr)_minmax(0,0.5fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,0.7fr)]"
              columns={[
                { key: "stock", header: "Stock" },
                { key: "side", header: "Side" },
                { key: "status", header: "Status" },
                { key: "today", header: "Today" },
                { key: "cap", header: "Daily cap" },
                { key: "last", header: "Last change" },
                { key: "action", header: "Actions", visuallyHiddenHeader: true, align: "end" },
              ]}
              rows={read.items.map((row) => {
                const status = STATUS[limitStatus(row)]
                const editing = state.draft?.symbol === row.symbol && state.draft.side === row.side
                return {
                  key: `${row.symbol}:${row.side}`,
                  current: editing,
                  cells: {
                    stock: <span className="font-mono font-semibold">{row.symbol}</span>,
                    side: <span className="font-semibold">{sideWord(row.side)}</span>,
                    status: <Pill tone={status.tone}>{status.label}</Pill>,
                    today: <TodayCell row={row} />,
                    cap: <span className="font-mono">{capText(row.dailyCashLimit)}</span>,
                    last: <LastChange row={row} />,
                    action: canControl ? (
                      <Button onClick={() => props.onEdit(row.symbol, row.side)} disabled={state.command !== null || state.limits.phase !== "ready" || editing} label={`Change the ${target(row.symbol, row.side)} limit`}>
                        Change
                      </Button>
                    ) : null,
                  },
                }
              })}
            />
          )}
          {state.draft && canControl && <Editor draft={state.draft} {...props} />}
          {!canControl && read && (
            <Notice tone="info" title="Read only for this operator">
              The signed-in operator has stocks:read but not stocks:control, so changes are not offered here. The server enforces the same rule.
            </Notice>
          )}
        </div>
      </Card>
      <HistoryCard state={state} now={now} />
    </div>
  )
}

function DayLine({ start, resetsAt, now }: { start: string; resetsAt: string; now: number }) {
  const left = Date.parse(resetsAt) - now
  if (left <= 0) {
    return (
      <Notice tone="attention" title="A new day started at 00:00 KST">
        The usage shown is from the previous day. Refresh to read today&apos;s.
      </Notice>
    )
  }
  return (
    <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">
      Today counts from <span className="font-mono">{formatUtc(start)}</span> and resets at <span className="font-mono">{formatUtc(resetsAt)}</span> (00:00 KST, in {formatDuration(left)}).
    </p>
  )
}

function TodayCell({ row }: { row: TradingLimitRow }) {
  return (
    <span className="text-xs">
      <span className="font-mono">{cashText(row.usedToday)}</span>
      <span className="block text-[11px] text-[var(--color-arco-text-soft)]">
        {row.dailyCashLimit === null ? "used · no cap" : `used of ${capText(row.dailyCashLimit)} (${usedShare(row.usedToday, row.dailyCashLimit)})`}
      </span>
    </span>
  )
}

function LastChange({ row }: { row: TradingLimitRow }) {
  if (row.version === 0 || row.updatedAt === null || row.operatorId === null) return <span className="text-[var(--color-arco-text-soft)]">Default (never changed): on, no cap</span>
  return (
    <span className="min-w-0">
      <span className="block">
        v{row.version} · <Time iso={row.updatedAt} /> · <Mono value={row.operatorId} />
      </span>
    </span>
  )
}

function Editor({ draft, onDraft, onReview, onBack, onCancel, onConfirm }: { draft: LimitDraft } & LimitsViewProps) {
  const ids = useId()
  const check = checkDraft(draft)
  const name = target(draft.symbol, draft.side)
  const side = sideWord(draft.side)
  const capCheck = draft.noCap ? null : checkCapInput(draft.capText)
  return (
    <section aria-labelledby={`${ids}-title`} data-testid="stocks-limits-editor" className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-3">
      <h3 id={`${ids}-title`} className="text-xs font-semibold text-[var(--color-arco-ink)]">
        {draft.reviewing ? `Review the ${name} change` : `Change the ${name} limit`}
      </h3>
      {draft.reviewing && check.ok ? (
        <div className="flex min-w-0 flex-col gap-3" data-testid="stocks-limits-review">
          <Fields>
            <Field label={`Now (version ${draft.basis.version})`} wide>
              {onWord(draft.basis.enabled)} · {capText(draft.basis.dailyCashLimit)}
            </Field>
            <Field label={`After saving (version ${draft.basis.version + 1})`} wide>
              {onWord(check.enabled)} · {capText(check.dailyCashLimit)}
            </Field>
            <Field label="Change" wide>
              {describeChange(draft.basis, check)}
            </Field>
          </Fields>
          {check.enabled && check.dailyCashLimit !== null && BigInt(draft.basis.usedToday) >= BigInt(check.dailyCashLimit) && (
            <Notice tone="attention" title="At or below what today already used">
              {name} has already taken {cashText(draft.basis.usedToday)} today, so new {side} orders are refused until 00:00 KST.
            </Notice>
          )}
          <Notice tone="info" title="When it applies">
            New {side} quotes and orders follow it at once; orders already created are not cancelled. The server saves it only if this limit is still version{" "}
            {draft.basis.version}; otherwise nothing changes.
          </Notice>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onConfirm}>Confirm change</Button>
            <Button onClick={onBack}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[var(--color-arco-ink)]">
              <input
                type="checkbox"
                role="switch"
                checked={draft.enabled}
                aria-checked={draft.enabled}
                onChange={(event) => onDraft({ enabled: event.target.checked })}
                className={`size-4 accent-[var(--color-arco-ink)] ${FOCUS_RING}`}
              />
              Take new {side} orders
            </label>
            <p className="mt-1 text-[11px] leading-4 text-[var(--color-arco-text-soft)]">
              Off refuses new {side} quotes and orders. A direct {draft.side === "BUY" ? "payment" : "escrow"} that arrives anyway is held for review (SIDE_DISABLED).
            </p>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)]">Daily cap, all wallets together</legend>
            <label className="inline-flex items-center gap-2 text-xs text-[var(--color-arco-ink)]">
              <input type="checkbox" checked={draft.noCap} onChange={(event) => onDraft({ noCap: event.target.checked })} className={`size-4 accent-[var(--color-arco-ink)] ${FOCUS_RING}`} />
              No cap
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <input
                id={`${ids}-cap`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                aria-label={`Daily cap in ${LIMIT_CASH_UNIT}`}
                value={draft.noCap ? "" : draft.capText}
                disabled={draft.noCap}
                aria-invalid={draft.showErrors && capCheck !== null && !capCheck.ok}
                aria-describedby={`${ids}-cap-help ${ids}-cap-error`}
                onChange={(event) => onDraft({ capText: event.target.value })}
                className={`w-full min-w-0 max-w-[240px] rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 py-1.5 font-mono text-xs text-[var(--color-arco-ink)] disabled:text-[var(--color-arco-muted)] ${FOCUS_RING}`}
              />
              <span className="text-xs text-[var(--color-arco-text-soft)]">{LIMIT_CASH_UNIT}</span>
            </div>
            <p id={`${ids}-cap-help`} className="text-[11px] leading-4 text-[var(--color-arco-text-soft)]">
              {draft.noCap
                ? `No daily cap: while it is on, this side takes any amount.`
                : capCheck?.ok
                  ? `= ${capText(capCheck.baseUnits)} a day (${capCheck.baseUnits} base units). An order that would pass it is refused; a direct ${draft.side === "BUY" ? "payment" : "escrow"} is held (DAILY_LIMIT_REACHED).`
                  : `Whole ${LIMIT_CASH_UNIT} with up to 6 decimals, for example 50000.`}
            </p>
            <p id={`${ids}-cap-error`} className="text-[11px] text-[var(--color-arco-down)]" aria-live="polite">
              {draft.showErrors && capCheck !== null && !capCheck.ok ? capCheck.message : ""}
            </p>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onReview}>Review change</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  )
}

function CommandNotice({ command, onRetry, onDiscard }: { command: LimitCommandState; onRetry: () => void; onDiscard: () => void }) {
  const name = target(command.symbol, command.side)
  const change = `${onWord(command.command.enabled)} · ${capText(command.command.dailyCashLimit)}`
  if (command.phase === "sending") {
    return (
      <Notice tone="info" title={`Saving the ${name} change…`} live>
        {name} → {change}
        {command.attempts > 1 ? ` (attempt ${command.attempts}, same change key)` : ""}. Waiting for the server&apos;s answer.
      </Notice>
    )
  }
  return (
    <Notice tone="attention" title={`The ${name} change was not confirmed`} live>
      <span className="block">
        {command.error ? `${errorCopy(command.error).title}. ` : ""}It may or may not have been saved. Retry sends the same change with the same key, so it is saved at most
        once. Discard reads the limits again without sending it.
      </span>
      <span className="mt-2 flex flex-wrap gap-2">
        <Button onClick={onRetry}>Retry</Button>
        <Button onClick={onDiscard}>Discard and read again</Button>
      </span>
    </Notice>
  )
}

function rejectedCopy(error: StocksAdminError): { title: string; body: string } {
  if (error.kind === "forbidden") return { title: "No permission to change limits (403)", body: "The server did not grant stocks:control to this session. Nothing was changed." }
  if (error.kind === "unauthorized") return { title: "Session expired (401)", body: "Sign in again. Nothing was changed." }
  if (error.kind === "disabled") return { title: "Trading limits are not turned on (404)", body: "The limits routes are not registered on this server. Nothing was changed." }
  if (error.code === "LIMIT_IDEMPOTENCY_CONFLICT") return { title: "The change key was already used (409)", body: "The server refused it. Nothing was changed; start the change again." }
  if (error.kind === "request" && error.status === 400) return { title: "The server refused the input (400)", body: "Nothing was changed. Check the cap." }
  const copy = errorCopy(error)
  return { title: copy.title, body: "Nothing was changed." }
}

function OutcomeNotice({ outcome, onDismiss }: { outcome: LimitOutcome; onDismiss: () => void }) {
  const name = target(outcome.symbol, outcome.side)
  const close = (
    <span className="mt-2 flex flex-wrap gap-2">
      <Button onClick={onDismiss}>Close</Button>
    </span>
  )
  let body: { tone: "error" | "attention" | "info"; title: string; text: ReactNode }
  if (outcome.kind === "saved") {
    const { change, state, replayed } = outcome.change
    body = {
      tone: "info",
      title: replayed ? `Already saved earlier: ${name}` : `Saved: ${name}`,
      text: (
        <>
          {replayed && "The server returned this change's original record; nothing was saved twice. "}
          Version {change.version}: {describeEvent(change)}.{state.version > change.version ? ` A later change (version ${state.version}) is already recorded.` : ""}
        </>
      ),
    }
  } else if (outcome.kind === "conflict") {
    body = { tone: "attention", title: `${name} was changed by someone else first`, text: "The server refused this change and nothing changed. The current setting was read again; start again if it is still needed." }
  } else if (outcome.kind === "changed_while_editing") {
    body = { tone: "attention", title: `${name} changed while you were editing`, text: "Nothing was sent. Start again from the current setting." }
  } else {
    const copy = rejectedCopy(outcome.error)
    body = { tone: "error", title: copy.title, text: copy.body }
  }
  return (
    <Notice tone={body.tone} title={body.title} live>
      <span className="block">{body.text}</span>
      {close}
    </Notice>
  )
}

function HistoryCard({ state, now }: { state: LimitsState; now: number }) {
  const history = state.history
  const items = history.value?.data.items ?? null
  return (
    <Card title="Change history" description={`The newest ${HISTORY_LIMIT} changes of this deployment, newest first. Records cannot be edited or deleted.`}>
      {history.phase === "error" && history.error && (
        <div className="mb-3">
          <Notice tone="error" title={errorCopy(history.error).title} live>
            {items ? "Reading the history again failed; the list below is from the last successful read." : "The change history could not be read."}
          </Notice>
        </div>
      )}
      {items === null ? (
        history.phase === "error" ? null : <EmptyRow>Reading the change history…</EmptyRow>
      ) : items.length === 0 ? (
        <EmptyRow>No change has been recorded yet: every side runs with the default (on, no cap).</EmptyRow>
      ) : (
        <DataList
          label="Trading limit changes"
          wideClass="lg:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.4fr)]"
          columns={[
            { key: "time", header: "Time" },
            { key: "target", header: "Stock and side" },
            { key: "change", header: "Change" },
            { key: "operator", header: "Operator" },
            { key: "reason", header: "Reason" },
          ]}
          rows={items.map((event) => ({
            key: event.id,
            cells: {
              time: <Time iso={event.createdAt} now={now} elapsed />,
              target: (
                <span>
                  <span className="font-semibold">{target(event.symbol, event.side)}</span>
                  <span className="block font-mono text-[11px] text-[var(--color-arco-text-soft)]">v{event.version}</span>
                </span>
              ),
              change: <span>{describeEvent(event)}</span>,
              operator: <Mono value={event.operatorId} />,
              reason: <span className="break-words">{event.reason}</span>,
            },
          }))}
        />
      )}
    </Card>
  )
}
