// One transaction in a modal, the way a swap review reads: what the user pays and receives, each step as it happens
// (approve, confirm in the wallet, pending with a timer), then a result screen. The Savings, Funds and Stocks panels open
// it from their primary action and pass their own words, so the steps and the success screen say what that product did.
//
// Leaf module: react, react-dom and lucide-react only. Keyboard model as in BottomSheet: focus moves to Close on open,
// Tab / Shift+Tab stay inside, Escape closes, keys that belong to another layer opened on top (the wallet's own modal,
// often in a shadow root) are left alone, and focus goes back to the opener on close. It is portalled to <body> and
// re-wrapped in `arco-demo` so the theme tokens resolve, and sits above the mobile bottom sheets (z-50).

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { AlertCircle, ArrowRight, Check, Clock, Loader2, X } from "lucide-react"

export type FlowStepState = "upcoming" | "wallet" | "processing" | "done" | "failed"

export type FlowStep = Readonly<{
  id: string
  /** Before it starts and once it is done: "Approve USDC", "Confirm deposit". */
  label: string
  /** While the wallet is asked: "Approve USDC in your wallet". */
  walletLabel: string
  /** Sent, and waiting for GIWA (for Stocks, also the settlement): "Deposit pending…". */
  processingLabel: string
  /** One line under the step while it is active. */
  hint?: string | null
  /** A short answer under the step while the wallet is asked ("Why do I have to approve?"). */
  help?: Readonly<{ question: string; answer: string }> | null
  /** Decorative: the token the step moves. */
  icon?: ReactNode
  state: FlowStepState
}>

export type FlowAmount = Readonly<{
  caption: string
  /** Null while the amount is not known: only the symbol is shown. */
  amount: string | null
  symbol: string
  sub?: string | null
  /** Decorative: the token's mark. */
  icon?: ReactNode
}>

export type FlowToken = Readonly<{ amount: string; symbol: string; icon?: ReactNode }>

export type FlowResult = Readonly<{
  /** success: done. pending: accepted, the rest follows later. held: stopped for review. */
  tone: "success" | "pending" | "held"
  title: string
  /** "1,000 USDC → 998.21 aUSD", shown when both sides are given. */
  from?: FlowToken | null
  to?: FlowToken | null
  message: string
  explorerHref?: string | null
}>

export type FlowNote = Readonly<{ message: string; action?: Readonly<{ label: string; onClick: () => void }> | null }>

export type TransactionFlowProps = {
  title: string
  pay: FlowAmount
  receive?: FlowAmount | null
  steps: readonly FlowStep[]
  result: FlowResult | null
  /** Why the failed step stopped. With it come Try again (when `onRetry` is given) and Close. */
  error: string | null
  /** A notice under the steps while it is still going (e.g. the settlement is slow). */
  note?: FlowNote | null
  onClose: () => void
  onRetry?: (() => void) | null
  doneLabel?: string
  explorerLabel?: string
}

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const BUTTON = `inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-card)] px-4 text-sm font-medium ${FOCUS_RING}`
const BUTTON_PRIMARY = `${BUTTON} bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]`
const BUTTON_SECONDARY = `${BUTTON} border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)]`
const TEXT_SOFT = "text-[var(--color-arco-text-soft)]"
// calc(env(...)) needs real spaces, so it is applied via inline style (Tailwind arbitrary values escape them).
const SAFE_AREA_PB = "calc(env(safe-area-inset-bottom) + 1.25rem)"
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

/** "00:14", "01:05": how long a step has been pending. */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`
}

function stepText(step: FlowStep): string {
  return step.state === "wallet" ? step.walletLabel : step.state === "processing" ? step.processingLabel : step.label
}

/** Seconds each processing step has been processing, ticking once a second while one is (nothing on the server). */
function useElapsed(steps: readonly FlowStep[]): Readonly<Record<string, number>> {
  const started = useRef(new Map<string, number>())
  const [now, setNow] = useState<number | null>(null)
  const processing = steps.filter((step) => step.state === "processing").map((step) => step.id).join("\n")
  useEffect(() => {
    const ids = processing === "" ? [] : processing.split("\n")
    for (const id of [...started.current.keys()]) if (!ids.includes(id)) started.current.delete(id)
    if (ids.length === 0) return
    const stamp = Date.now()
    for (const id of ids) if (!started.current.has(id)) started.current.set(id, stamp)
    setNow(stamp)
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [processing])
  const elapsed: Record<string, number> = {}
  if (now !== null) for (const [id, at] of started.current) elapsed[id] = (now - at) / 1_000
  return elapsed
}

function AmountRow({ amount }: { amount: FlowAmount }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className={`text-sm ${TEXT_SOFT}`}>{amount.caption}</p>
        <p className="mt-1 break-words text-[28px] font-medium leading-tight tabular-nums text-[var(--color-arco-ink)]">
          {amount.amount === null ? amount.symbol : `${amount.amount} ${amount.symbol}`}
        </p>
        {amount.sub ? <p className={`mt-1 text-sm tabular-nums ${TEXT_SOFT}`}>{amount.sub}</p> : null}
      </div>
      {amount.icon ? (
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center">
          {amount.icon}
        </span>
      ) : null}
    </div>
  )
}

function StepIcon({ step }: { step: FlowStep }) {
  const base = "flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)]"
  if (step.state === "processing") {
    return (
      <span aria-hidden="true" className={base}>
        <Loader2 className="size-4 animate-spin text-[var(--color-arco-ink)] motion-reduce:animate-none" />
      </span>
    )
  }
  if (step.state === "failed") {
    return (
      <span aria-hidden="true" className={base}>
        <X className="size-4 text-[var(--color-arco-down)]" />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className={`${base} ${step.state === "wallet" ? "" : "opacity-50 grayscale"}`}>
      {step.icon ?? <span className="size-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-muted)]" />}
    </span>
  )
}

function StepRow({ step, last, seconds }: { step: FlowStep; last: boolean; seconds: number | null }) {
  const active = step.state === "wallet" || step.state === "processing"
  const strong = active || step.state === "failed"
  return (
    <li className="flex gap-3" aria-current={active ? "step" : undefined} data-step={step.id} data-state={step.state}>
      <div className="flex flex-col items-center">
        <StepIcon step={step} />
        {last ? null : <span aria-hidden="true" className="my-1 h-4 w-px bg-[var(--color-arco-border)]" />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-1"}`}>
        <div className="flex min-h-7 items-center justify-between gap-3">
          <p className={`text-sm ${strong ? "font-medium text-[var(--color-arco-ink)]" : TEXT_SOFT}`}>{stepText(step)}</p>
          {step.state === "done" ? (
            <span className="inline-flex shrink-0 items-center">
              <Check aria-hidden="true" className="size-4 text-[var(--color-arco-up)]" />
              <span className="sr-only">Done</span>
            </span>
          ) : null}
          {step.state === "failed" ? <span className="sr-only">Failed</span> : null}
          {step.state === "processing" && seconds !== null ? (
            <span className={`shrink-0 text-xs tabular-nums ${TEXT_SOFT}`}>{formatElapsed(seconds)}</span>
          ) : null}
        </div>
        {active && step.hint ? <p className={`text-xs leading-5 ${TEXT_SOFT}`}>{step.hint}</p> : null}
        {step.state === "wallet" && step.help ? (
          <details className="text-xs leading-5">
            <summary className={`w-fit cursor-pointer list-none font-medium text-[var(--color-arco-ink)] underline underline-offset-2 [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
              {step.help.question}
            </summary>
            <p className={`mt-1 ${TEXT_SOFT}`}>{step.help.answer}</p>
          </details>
        ) : null}
      </div>
    </li>
  )
}

function TokenAmount({ token }: { token: FlowToken }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {token.icon ? (
        <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center">
          {token.icon}
        </span>
      ) : null}
      <span>{`${token.amount} ${token.symbol}`}</span>
    </span>
  )
}

function ResultView({ result, doneLabel, explorerLabel, onDone }: { result: FlowResult; doneLabel: string; explorerLabel: string; onDone: () => void }) {
  const mark = "flex size-16 items-center justify-center rounded-[var(--radius-pill)]"
  return (
    <div className="flex flex-col items-center pb-1 pt-4 text-center">
      {result.tone === "success" ? (
        <span aria-hidden="true" className={`${mark} bg-[var(--color-arco-up)] text-[var(--color-arco-on-dark)]`}>
          <Check className="size-8" strokeWidth={3} />
        </span>
      ) : result.tone === "pending" ? (
        <span aria-hidden="true" className={`${mark} bg-[var(--color-arco-chip)] text-[var(--color-arco-ink)]`}>
          <Clock className="size-8" />
        </span>
      ) : (
        <span aria-hidden="true" className={`${mark} bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-ink)] ring-1 ring-[var(--color-arco-ink-40)]`}>
          <AlertCircle className="size-8" />
        </span>
      )}
      <p className="mt-5 text-lg font-medium text-[var(--color-arco-ink)]">{result.title}</p>
      {result.from && result.to ? (
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm tabular-nums text-[var(--color-arco-ink)]">
          <TokenAmount token={result.from} />
          <ArrowRight aria-hidden="true" className={`size-4 ${TEXT_SOFT}`} />
          <span className="sr-only">to</span>
          <TokenAmount token={result.to} />
        </p>
      ) : null}
      <p className={`mt-3 max-w-[320px] text-sm leading-6 ${TEXT_SOFT}`}>{result.message}</p>
      {result.explorerHref ? (
        <a
          href={result.explorerHref}
          target="_blank"
          rel="noreferrer"
          className={`mt-4 text-sm font-medium text-[var(--color-arco-ink)] underline underline-offset-2 ${FOCUS_RING}`}
        >
          {explorerLabel}
        </a>
      ) : null}
      <div className="mt-6 flex w-full">
        <button type="button" onClick={onDone} className={BUTTON_PRIMARY}>
          {doneLabel}
        </button>
      </div>
    </div>
  )
}

/** The modal's content. Rendered on its own by the tests (no portal on the server). */
export function TransactionFlowCard({
  title,
  pay,
  receive = null,
  steps,
  result,
  error,
  note = null,
  onClose,
  onRetry = null,
  doneLabel = "Done",
  explorerLabel = "View on GIWA explorer",
  titleId,
  closeRef,
}: TransactionFlowProps & { titleId?: string; closeRef?: RefObject<HTMLButtonElement> }) {
  const elapsed = useElapsed(steps)
  const current = steps.find((step) => step.state === "wallet" || step.state === "processing") ?? null
  // Steps and the result are said here; an error announces itself (role="alert").
  const announcement = result !== null ? `${result.title} ${result.message}` : current !== null && error === null ? stepText(current) : ""
  return (
    <div className="w-full" data-testid="transaction-flow" data-outcome={result?.tone ?? (error !== null ? "failed" : "running")}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-base font-medium text-[var(--color-arco-ink)]">
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-pill)] ${TEXT_SOFT} hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)] ${FOCUS_RING}`}
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      {result !== null ? (
        <ResultView result={result} doneLabel={doneLabel} explorerLabel={explorerLabel} onDone={onClose} />
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-5">
            <AmountRow amount={pay} />
            {receive !== null ? <AmountRow amount={receive} /> : null}
          </div>
          <div aria-hidden="true" className="my-5 h-px bg-[var(--color-arco-border)]" />
          <ol aria-label="Transaction steps" className="flex flex-col">
            {steps.map((step, index) => (
              <StepRow key={step.id} step={step} last={index === steps.length - 1} seconds={elapsed[step.id] ?? null} />
            ))}
          </ol>
          {note !== null && error === null ? (
            <div className={`mt-5 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface-muted)] p-3 text-sm leading-6 ${TEXT_SOFT}`}>
              <p>{note.message}</p>
              {note.action ? (
                <div className="mt-3 flex">
                  <button type="button" onClick={note.action.onClick} className={BUTTON_SECONDARY}>
                    {note.action.label}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {error !== null ? (
            <>
              <div role="alert" className="mt-5 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-down)] p-3 text-sm leading-6 text-[var(--color-arco-ink)]">
                <AlertCircle aria-hidden="true" className="mt-1 size-4 shrink-0 text-[var(--color-arco-down)]" />
                <span className="break-words">{error}</span>
              </div>
              <div className="mt-4 flex gap-3">
                {onRetry ? (
                  <button type="button" onClick={onRetry} className={BUTTON_PRIMARY}>
                    Try again
                  </button>
                ) : null}
                <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
                  Close
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  )
}

function isOtherLayer(element: Element): boolean {
  return element.shadowRoot !== null || element.closest('[aria-modal="true"], [role="dialog"]') !== null
}

/** Focusable and not disabled (a control inside a disabled fieldset has no disabled attribute of its own). */
function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.closest("fieldset[disabled]") === null)
}

export type TransactionFlowModalProps = TransactionFlowProps & {
  open: boolean
  /** A tap outside closes it. Only once it has finished: a stray tap must never stop a flow in progress. */
  dismissible?: boolean
  /** Where focus goes on close when the control that opened it is gone or disabled. Falls back to #giwa-main. */
  returnFocusTo?: RefObject<HTMLElement | null>
}

export function TransactionFlowModal({ open, dismissible = false, returnFocusTo, ...card }: TransactionFlowModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [visible, setVisible] = useState(false)
  // Latest callbacks, read by the effects below without re-running them.
  const onCloseRef = useRef(card.onClose)
  const returnRef = useRef(returnFocusTo)
  useIsomorphicLayoutEffect(() => {
    onCloseRef.current = card.onClose
    returnRef.current = returnFocusTo
  })

  // Open: remember the opener, focus Close, fade in. Closed or removed: focus goes back to the opener.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    closeRef.current?.focus({ preventScroll: true })
    const raf = window.requestAnimationFrame(() => setVisible(true))
    return () => {
      window.cancelAnimationFrame(raf)
      setVisible(false)
      const active = document.activeElement
      const lost = active === null || active === document.body || !active.isConnected || (dialogRef.current?.contains(active) ?? false)
      if (!lost) return
      for (const target of [opener, returnRef.current?.current ?? null, document.getElementById("giwa-main")]) {
        if (target === null || !target.isConnected) continue
        target.focus({ preventScroll: true })
        if (document.activeElement === target) return
      }
    }
  }, [open])

  // Body-scroll lock while open.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Escape + focus trap, in the capture phase on window so a bottom sheet underneath (its own trap listens on document)
  // never sees keys meant for this dialog. Keys that belong to a layer on top (the wallet's modal) are left alone.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current
      if (dialog === null) return
      const active = document.activeElement
      if (active !== null && active !== document.body && !dialog.contains(active) && isOtherLayer(active)) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab") return
      event.stopPropagation()
      const focusable = tabbable(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const inside = active !== null && active !== dialog && dialog.contains(active)
      const atEdge = event.shiftKey ? active === first : active === last
      if (!inside || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open])

  if (!open || typeof document === "undefined") return null
  return createPortal(
    <div className="arco-demo">
      <div
        className={`fixed inset-0 z-[60] flex items-end justify-center bg-[var(--color-arco-overlay)] transition-opacity duration-200 ease-out motion-reduce:transition-none sm:items-center sm:p-4 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        onMouseDown={(event) => {
          // A press on the backdrop keeps focus in the dialog; it closes only a finished flow.
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          if (dismissible) onCloseRef.current()
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`max-h-[92vh] w-full overflow-y-auto overscroll-contain rounded-t-[var(--radius-strategy)] bg-[var(--color-arco-surface)] px-5 pt-3 outline-none transition-transform duration-200 ease-out motion-reduce:transition-none sm:max-w-[420px] sm:rounded-[var(--radius-strategy)] ${
            visible ? "translate-y-0" : "translate-y-3"
          }`}
          style={{ paddingBottom: SAFE_AREA_PB, boxShadow: "var(--shadow-control)" }}
        >
          <TransactionFlowCard {...card} titleId={titleId} closeRef={closeRef} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
