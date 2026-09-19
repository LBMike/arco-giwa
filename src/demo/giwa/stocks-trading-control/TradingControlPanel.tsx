// Operator trading control panel (003F): the persisted manual gate, the runtime's new-order admission diagnostic,
// a reviewed pause/resume command and the change history. Every value is labelled with where and when it was read.
// Nothing here claims that trading is open, that in-flight work was stopped, or that a result is known when it is not.
import { useEffect, useId, useRef, useState } from "react"
import { formatUtcMs } from "../stocks-admin/format"
import { Button, Card, EmptyRow, FOCUS_RING, Field, Fields, Mono, Notice, Pill, RefreshButton, Time } from "../stocks-admin/ui"
import { MAX_VERSION, REASON_MAX_LENGTH, checkReason } from "./parse"
import { canLoadOlder, readBeforeUnresolved, retryReadiness, type RetryRefusal, type StartRefusal } from "./store"
import type {
  AbandonedCommand,
  CommandState,
  HistoryState,
  PauseReason,
  ResourceState,
  RuntimeStatus,
  StocksAdminError,
  TradingControlEvent,
  TradingControlSnapshot,
  TradingControlState,
} from "./types"

export type StartRequest = {
  readonly paused: boolean
  readonly reason: string
  readonly reviewed: { readonly version: number; readonly paused: boolean; readonly observedAt: string }
}

export type TradingControlViewProps = {
  readonly snapshot: TradingControlSnapshot
  readonly now: number
  readonly onRefresh: () => void
  readonly onLoadOlder: (beforeVersion: number) => void
  readonly onStart: (request: StartRequest) => StartRefusal | null
  readonly onRetry: () => RetryRefusal | null
  readonly onDiscard: () => void
  readonly onDismissAbandoned: () => void
  readonly onRetryAccess: () => void
  readonly onSignInRequired?: () => void
  /** Test seam: open the command card on a given step (a review captures the state shown at first render). */
  readonly initialDraft?: { readonly step: "edit" | "review"; readonly reason: string }
}

const gateWord = (paused: boolean) => (paused ? "Paused" : "Resumed")
const actionWord = (paused: boolean) => (paused ? "pause" : "resume")

export const PAUSE_REASON_COPY: Record<PauseReason, { readonly label: string; readonly detail: string }> = {
  RUNTIME_STOPPED: { label: "Runtime stopped", detail: "This API process is not running the Stocks runtime." },
  AUTODISPATCH_DISABLED: { label: "Automatic dispatch disabled", detail: "Configured off for this process. A manual resume does not change it." },
  CONFIGURED_PAUSE: { label: "Configured pause", detail: "A startup setting of this process. A manual resume does not change it." },
  OPERATOR_PAUSE: { label: "Manual pause", detail: "The operator gate, as this process last cached it." },
  OPERATOR_CONTROL_UNAVAILABLE: { label: "Manual gate unavailable to this process", detail: "Its cached view expired or the control store could not be read." },
  OBSERVER_NOT_CURRENT: { label: "Chain observation not current", detail: "The observer has not confirmed a current chain view." },
}

/** Every runtime reason except the manual gate itself (shown from the database) still blocks new orders. */
function remainingReasons(runtime: ResourceState<RuntimeStatus>): readonly PauseReason[] | null {
  return runtime.value?.data.pauseReasons.filter((reason) => reason !== "OPERATOR_PAUSE") ?? null
}
const reasonList = (reasons: readonly PauseReason[]) => reasons.map((reason) => PAUSE_REASON_COPY[reason].label).join(", ")

function readErrorCopy(error: StocksAdminError, what: string): { title: string; body: string } {
  switch (error.kind) {
    case "disabled":
      return { title: `${what} is not available on this server (404)`, body: "The route is not registered here." }
    case "server":
      return { title: `${what} unavailable${error.status ? ` (${error.status})` : ""}`, body: "The server could not provide it. The result could not be read." }
    case "network":
      return { title: "Could not reach the API", body: "The request failed before a response arrived." }
    case "invalid":
      return { title: "Response did not match the contract", body: "The response was rejected and none of it is shown." }
    case "configuration":
      return { title: "Stocks admin API is not configured", body: "No request was sent." }
    case "aborted":
      return { title: "Request cancelled", body: "The request was cancelled before it finished." }
    default:
      return { title: `Request rejected${error.status ? ` (${error.status})` : ""}`, body: "The server rejected the request." }
  }
}

export function TradingControlView(props: TradingControlViewProps) {
  const { snapshot } = props
  const disabled = snapshot.control.error?.kind === "disabled"
  const failed = [
    snapshot.control.phase === "error" && !disabled ? "trading control state" : null,
    snapshot.runtime.phase === "error" ? "runtime status" : null,
    snapshot.history.phase === "error" && !disabled ? "change history" : null,
  ].filter((item): item is string => item !== null)
  const summary = [disabled ? "Trading control is not enabled on this server (404)." : "", failed.length > 0 ? `Could not read: ${failed.join(", ")}.` : ""].filter(Boolean).join(" ")
  const beforeUnresolved = readBeforeUnresolved(snapshot)
  return (
    <section aria-labelledby="stocks-trading-control-title" className="w-full min-w-0 space-y-4" data-testid="stocks-trading-control">
      <header className="w-full min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)]">Admin · Stocks · trading control</p>
        <h2 id="stocks-trading-control-title" className="mt-1 text-lg font-medium text-[var(--color-arco-ink)]">
          Trading control
        </h2>
        <p className="mt-1 max-w-[720px] text-xs leading-5 text-[var(--color-arco-text-soft)]">
          A manual admission gate for new Stocks orders on this deployment (DEMO_TESTNET, test values only). It is not an emergency stop: pausing does not
          cancel transactions that were already approved or sent, and in-flight work may still complete. Order lookup and hash recovery stay available.
        </p>
        {/* One announcement for failed reads instead of one alert per card. */}
        <p role="status" className="sr-only">
          {snapshot.access === "ok" ? summary : ""}
        </p>
      </header>
      {snapshot.access !== "ok" ? (
        <AccessNotice access={snapshot.access} abandoned={snapshot.abandoned} onRetry={props.onRetryAccess} onSignInRequired={props.onSignInRequired} />
      ) : (
        <div className="grid w-full min-w-0 gap-4 xl:grid-cols-2">
          <GateCard control={snapshot.control} unresolved={beforeUnresolved ? (snapshot.command?.phase === "sending" ? "sending" : "unknown") : null} now={props.now} onRefresh={props.onRefresh} />
          <AdmissionCard runtime={snapshot.runtime} control={snapshot.control} gateCurrent={snapshot.control.error === null && !beforeUnresolved} />
          <div className="min-w-0 xl:col-span-2">
            <CommandCard {...props} key={snapshot.scopeKey} />
          </div>
          {snapshot.control.error?.kind !== "disabled" && (
            <div className="min-w-0 xl:col-span-2">
              <HistoryCard history={snapshot.history} onLoadOlder={props.onLoadOlder} onRefresh={props.onRefresh} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** What the page can currently read: only the command's own deployment's history can tell whether it was recorded. */
type HistoryScope = { readonly disabled: boolean; readonly shownDigest: string | null }

/** How to tell from the history whether a command with an unknown result was recorded. */
function RecordedCheck({ paused, expectedVersion, reason, deploymentDigest, scope }: { paused: boolean; expectedVersion: number; reason: string; deploymentDigest: string; scope: HistoryScope }) {
  const version = expectedVersion + 1
  if (scope.disabled) return <>The control routes are not available here, so whether this command was recorded cannot be checked from this page.</>
  if (scope.shownDigest !== null && scope.shownDigest !== deploymentDigest) {
    return (
      <>
        This command was for deployment <Mono value={deploymentDigest} short />; the history shown is for another deployment and cannot tell whether it was recorded.
      </>
    )
  }
  return (
    <>
      In the change history, a version {version} {actionWord(paused)} with the reason “<span className="break-words">{reason}</span>” means it was recorded; any other change
      at version {version} means it was not, and it can no longer be recorded.
    </>
  )
}

function AbandonedNote({ abandoned, scope }: { abandoned: AbandonedCommand; scope: HistoryScope }) {
  return (
    <>
      A {actionWord(abandoned.paused)} command sent from this page (key <Mono value={abandoned.idempotencyKey} short />) has no verified result. It may or may not have
      been recorded, and it is not resent.{" "}
      <RecordedCheck paused={abandoned.paused} expectedVersion={abandoned.expectedVersion} reason={abandoned.reason} deploymentDigest={abandoned.deploymentDigest} scope={scope} />
    </>
  )
}

function historyScope(snapshot: TradingControlSnapshot): HistoryScope {
  return { disabled: snapshot.control.error?.kind === "disabled", shownDigest: snapshot.control.value?.data.deploymentDigest ?? null }
}

function AccessNotice({ access, abandoned, onRetry, onSignInRequired }: {
  access: Exclude<TradingControlSnapshot["access"], "ok">
  abandoned: AbandonedCommand | null
  onRetry: () => void
  onSignInRequired?: () => void
}) {
  const copy = {
    signed_out: { title: "Operator session required", body: "Sign in with an operator wallet. Trading control is read and changed only with that session; the server decides its permissions." },
    unauthorized: { title: "Session not accepted (401)", body: "The server did not accept the session. Nothing from an earlier read is shown. Sign in again, then check access." },
    forbidden: {
      title: "No access to trading control (403)",
      body: "The server did not grant this session read access to trading control (stocks:read), or could not verify the session. Nothing from an earlier read is shown.",
    },
  }[access]
  return (
    <div role={access === "signed_out" ? "status" : "alert"} className="w-full rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] p-4">
      <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">{copy.title}</h3>
      <p className="mt-1 max-w-[640px] text-xs leading-5 text-[var(--color-arco-text-soft)]">{copy.body}</p>
      {abandoned && (
        <p className="mt-2 max-w-[640px] text-xs leading-5 text-[var(--color-arco-ink)]" data-testid="stocks-trading-control-abandoned">
          <AbandonedNote abandoned={abandoned} scope={{ disabled: false, shownDigest: null }} />
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {onSignInRequired && access !== "forbidden" && <Button onClick={onSignInRequired}>Sign in with operator wallet</Button>}
        {access !== "signed_out" && <Button onClick={onRetry}>Check access again</Button>}
      </div>
    </div>
  )
}

function ReadLine({ observedAt, loadedAt, busy }: { observedAt: string; loadedAt: number; busy: boolean }) {
  return (
    <p className="text-[11px] leading-4 text-[var(--color-arco-text-soft)]">
      Server response{" "}
      <time dateTime={observedAt} className="font-mono">
        {observedAt}
      </time>{" "}
      · loaded <span className="font-mono">{formatUtcMs(loadedAt)}</span>
      {busy && " · reading again…"}
    </p>
  )
}

function GateCard({ control, unresolved, now, onRefresh }: { control: ResourceState<TradingControlState>; unresolved: "sending" | "unknown" | null; now: number; onRefresh: () => void }) {
  const value = control.value
  const state = value?.data ?? null
  return (
    <Card
      title="Manual gate (database)"
      description="The persisted operator gate for new orders on this deployment. It is one of several reasons new orders can be paused."
      actions={<RefreshButton onClick={onRefresh} busy={control.phase === "loading"} what="trading control" />}
    >
      <div className="flex min-w-0 flex-col gap-3" data-testid="stocks-trading-control-gate" data-phase={control.phase}>
        {control.phase === "error" && control.error && (
          <Notice tone="error" title={control.error.kind === "disabled" ? "Trading control is not enabled on this server (404)" : readErrorCopy(control.error, "Trading control state").title}>
            {control.error.kind === "disabled"
              ? "The trading control routes are not registered here, so nothing can be paused or resumed from this page."
              : readErrorCopy(control.error, "Trading control state").body}
            {state &&
              value &&
              (control.error.kind === "disabled"
                ? ` The state below is from an earlier read at ${value.meta.observedAt}, before the routes became unavailable.`
                : ` The state below is from an earlier read at ${value.meta.observedAt}; it may no longer be current. Read it again before changing it.`)}
          </Notice>
        )}
        {unresolved === "sending" && value && (
          <Notice tone="attention" title="A command is being sent">
            The state below (read at {value.meta.observedAt}) may or may not include it. Read it again once the command is answered.
          </Notice>
        )}
        {unresolved === "unknown" && value && (
          <Notice tone="attention" title="Read before a command whose result is unknown">
            The state below was read at {value.meta.observedAt}, before that command's outcome; it may no longer be current. Read it again to check.
          </Notice>
        )}
        {!state ? (
          control.phase === "error" ? null : <EmptyRow>{control.phase === "loading" ? "Reading the current state…" : "Not read yet."}</EmptyRow>
        ) : (
          <>
            {value && <ReadLine observedAt={value.meta.observedAt} loadedAt={value.loadedAt} busy={control.phase === "loading"} />}
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={state.paused ? "attention" : "neutral"}>Manual gate: {gateWord(state.paused)}</Pill>
              <span className="text-xs text-[var(--color-arco-text-soft)]">version {state.version}</span>
            </div>
            <Fields>
              {state.version === 0 ? (
                <Field label="Last change" wide>
                  No change recorded yet. An enabled deployment starts paused at version 0 until an operator resumes it.
                </Field>
              ) : (
                <>
                  <Field label="Last change">{state.updatedAt && <Time iso={state.updatedAt} now={now} elapsed />}</Field>
                  <Field label="By operator">
                    <Mono value={state.operatorId ?? ""} />
                  </Field>
                  <Field label="Reason" wide>
                    <span className="break-words">{state.reason}</span>
                  </Field>
                </>
              )}
              <Field label="Deployment digest" wide>
                <Mono value={state.deploymentDigest} short />
              </Field>
            </Fields>
          </>
        )}
      </div>
    </Card>
  )
}

function AdmissionCard({ runtime, control, gateCurrent }: { runtime: ResourceState<RuntimeStatus>; control: ResourceState<TradingControlState>; gateCurrent: boolean }) {
  const value = runtime.value
  const status = value?.data ?? null
  const gate = control.value?.data ?? null
  // A kept value after a failed read, or one read before an unresolved command, is an earlier observation.
  const runtimeCurrent = runtime.error === null
  const others = remainingReasons(runtime) ?? []
  const cached = status?.operatorControl ?? null
  const cachedDiffers =
    cached !== null && gate !== null && (cached.status === "UNAVAILABLE" || cached.version !== gate.version || (cached.status === "PAUSED") !== gate.paused)
  return (
    <Card
      title="New-order admission (runtime diagnostic)"
      description="What one API process reported about admitting new orders. It is a diagnostic, not permission: every order is still checked by the server when it arrives."
    >
      <div className="flex min-w-0 flex-col gap-3" data-testid="stocks-trading-control-admission" data-phase={runtime.phase}>
        {runtime.phase === "error" && runtime.error && (
          <Notice tone="error" title={readErrorCopy(runtime.error, "Runtime status").title}>
            {readErrorCopy(runtime.error, "Runtime status").body} Whether new orders are admitted is not known from this page.
            {status && value && ` The report below is from an earlier read at ${value.meta.observedAt}; it may no longer be current.`}
          </Notice>
        )}
        {gate && !gate.paused && (
          <Notice
            tone="attention"
            title={
              gateCurrent
                ? "The manual gate is resumed; that alone does not resume trading"
                : `At the earlier read (${control.value?.meta.observedAt}) the manual gate was resumed; that alone does not resume trading`
            }
          >
            {status === null
              ? "Whether new orders are admitted is unknown until runtime status can be read."
              : others.length > 0
                ? runtimeCurrent
                  ? `New orders are still paused by: ${reasonList(others)}.`
                  : `As last reported (${value?.meta.observedAt}), new orders were still paused by: ${reasonList(others)}.`
                : runtimeCurrent
                  ? "This process reported no other pause reason in the report below. Every order is still checked by the server."
                  : `As last reported (${value?.meta.observedAt}), this process reported no other pause reason. Every order is still checked by the server.`}
          </Notice>
        )}
        {!status ? (
          runtime.phase === "error" ? null : <EmptyRow>{runtime.phase === "loading" ? "Reading runtime status…" : "Not read yet."}</EmptyRow>
        ) : (
          <>
            {value && <ReadLine observedAt={value.meta.observedAt} loadedAt={value.loadedAt} busy={runtime.phase === "loading"} />}
            <div className="flex flex-wrap items-center gap-2">
              {status.newOrdersPaused ? <Pill tone="attention">New orders paused</Pill> : <Pill tone="neutral">No pause reason reported</Pill>}
              <span className="text-xs text-[var(--color-arco-text-soft)]">as reported by this API process</span>
            </div>
            {status.pauseReasons.length > 0 && (
              <ul className="flex min-w-0 flex-col gap-1.5" aria-label="Pause reasons">
                {status.pauseReasons.map((reason) => (
                  <li key={reason} className="min-w-0 text-xs text-[var(--color-arco-ink)]" data-reason={reason}>
                    <span className="font-medium">{PAUSE_REASON_COPY[reason].label}</span>{" "}
                    <span className="text-[var(--color-arco-text-soft)]">— {PAUSE_REASON_COPY[reason].detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <Fields>
              <Field label="This process's cached manual gate" wide>
                {cached === null
                  ? "Not reported (this server runs without operator controls in its runtime status)."
                  : cached.status === "UNAVAILABLE"
                    ? "Unavailable"
                    : `${gateWord(cached.status === "PAUSED")}, version ${cached.version}`}
                <span className="block text-[11px] text-[var(--color-arco-text-soft)]">
                  Cached for up to 5 seconds; it can lag behind the database state.
                  {cachedDiffers && " It differs from the manual gate read above; read both again in a few seconds."}
                </span>
              </Field>
              <Field label="Runtime">{status.runtimeState === "RUNNING" ? "Running" : "Stopped"}</Field>
              <Field label="Observer">{status.observerStatus}</Field>
              <Field label="Automatic dispatch">{status.autodispatch ? "On" : "Off"}</Field>
              <Field label="Configured pause">{status.configuredPause ? "On" : "Off"}</Field>
              {gate && status.deploymentDigest !== gate.deploymentDigest && (
                <Field label="Deployment" wide>
                  <span className="text-[var(--color-arco-down)]">This report is for a different deployment digest than the manual gate above.</span>
                </Field>
              )}
            </Fields>
          </>
        )}
      </div>
    </Card>
  )
}

/** What the operator reviewed: frozen when the review opens, never re-derived from a later read. */
type Reviewed = { readonly target: boolean; readonly version: number; readonly paused: boolean; readonly observedAt: string; readonly reason: string }

function CommandCard(props: TradingControlViewProps) {
  const { snapshot } = props
  const ids = useId()
  const control = snapshot.control
  const value = control.value
  const state = value?.data ?? null
  const [text, setText] = useState(props.initialDraft?.reason ?? "")
  const [reviewed, setReviewed] = useState<Reviewed | null>(() => {
    const draft = props.initialDraft
    const check = draft ? checkReason(draft.reason) : null
    return draft?.step === "review" && state && value && check?.ok ? { target: !state.paused, version: state.version, paused: state.paused, observedAt: value.meta.observedAt, reason: check.reason } : null
  })
  const [showError, setShowError] = useState(false)
  const [refusal, setRefusal] = useState<StartRefusal | null>(null)
  const [focus, setFocus] = useState<"review" | "reason" | "outcome" | null>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const reviewRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const command = snapshot.command
  const disabledFeature = control.error?.kind === "disabled"
  const ready = control.phase === "ready" && control.error === null && state !== null && value !== null
  const busy = command?.phase === "sending" || command?.phase === "unknown"
  const beforeUnresolved = readBeforeUnresolved(snapshot)
  const check = checkReason(text)
  const target = state ? !state.paused : true
  const reasonsLeft = remainingReasons(snapshot.runtime)
  const atLimit = state !== null && state.version >= MAX_VERSION
  // The review stays what was reviewed; if the state was read again meanwhile, it must be reviewed again.
  const reviewStale = reviewed !== null && (!ready || !state || !value || state.version !== reviewed.version || state.paused !== reviewed.paused || value.meta.observedAt !== reviewed.observedAt)

  useEffect(() => {
    if (focus === null) return
    // When the target is not rendered (for example no form while the state is read again), focus stays in this card.
    const outcome = document.getElementById(`${ids}-outcome`)
    if (focus === "review") (reviewRef.current ?? cardRef.current)?.focus()
    else if (focus === "reason") (reasonRef.current ?? cardRef.current)?.focus()
    else (outcome ?? reasonRef.current ?? cardRef.current)?.focus()
    setFocus(null)
  }, [focus, ids])

  const openReview = () => {
    setRefusal(null)
    if (!check.ok || !state || !value) {
      setShowError(true)
      setFocus("reason")
      return
    }
    setShowError(false)
    setReviewed({ target, version: state.version, paused: state.paused, observedAt: value.meta.observedAt, reason: check.reason })
    setFocus("review")
  }
  const back = () => {
    setReviewed(null)
    setFocus("reason")
  }
  const confirm = () => {
    if (!reviewed || reviewStale) return
    const outcome = props.onStart({ paused: reviewed.target, reason: reviewed.reason, reviewed: { version: reviewed.version, paused: reviewed.paused, observedAt: reviewed.observedAt } })
    // A second click while the first command is being sent is simply ignored.
    if (outcome === "busy") return
    setRefusal(outcome)
    setReviewed(null)
    if (outcome === null) {
      setText("")
      setFocus("outcome")
    } else setFocus("reason")
  }
  const staleCopy =
    control.phase === "loading"
      ? { title: "The state is being read again", body: "This review can no longer be confirmed. Wait for the read, then go back and review the current state. Nothing was sent." }
      : control.phase === "error"
        ? { title: "Reading the state again failed", body: "This review can no longer be confirmed. Read the state successfully, then go back and review it. Nothing was sent." }
        : { title: "The state was read again while you were reviewing", body: "This review no longer matches what is shown above. Nothing was sent. Go back and review the current state." }

  return (
    <Card title="Pause or resume" description="Changes only the manual gate. The server decides whether this session may change it (stocks:control); this page does not guess.">
      <div ref={cardRef} tabIndex={-1} role="group" aria-label="Pause or resume" className={`flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] ${FOCUS_RING}`} data-testid="stocks-trading-control-command">
        {snapshot.abandoned && (
          <Notice tone="attention" title="An earlier command has no verified result">
            <AbandonedNote abandoned={snapshot.abandoned} scope={historyScope(snapshot)} />
            <span className="mt-2 flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  props.onDismissAbandoned()
                  setFocus("reason")
                }}
              >
                Close
              </Button>
            </span>
          </Notice>
        )}
        {command && (
          <CommandOutcome
            id={`${ids}-outcome`}
            snapshot={snapshot}
            command={command}
            reasonsLeft={reasonsLeft}
            onRetry={() => {
              props.onRetry()
              setFocus("outcome")
            }}
            onDiscard={() => {
              props.onDiscard()
              setFocus("reason")
            }}
            onRefresh={props.onRefresh}
          />
        )}
        {disabledFeature ? (
          <EmptyRow>Not available: trading control is not enabled on this server.</EmptyRow>
        ) : busy ? null : reviewed ? (
          <div
            ref={reviewRef}
            role="group"
            tabIndex={-1}
            className={`flex min-w-0 flex-col gap-3 rounded-[var(--radius-control)] ${FOCUS_RING}`}
            data-testid="stocks-trading-control-review"
            aria-labelledby={`${ids}-review-title`}
          >
            <h4 id={`${ids}-review-title`} className="text-xs font-semibold text-[var(--color-arco-ink)]">
              Review the change
            </h4>
            <Fields>
              <Field label="Current state (as read)" wide>
                {gateWord(reviewed.paused)} · version {reviewed.version} · server response {reviewed.observedAt}
              </Field>
              <Field label="Change to send" wide>
                {reviewed.target ? "Pause new orders" : "Resume the manual gate"}. The server records it as version {reviewed.version + 1} only if the state is still
                version {reviewed.version}; otherwise it refuses and nothing changes.
              </Field>
              <Field label="Reason" wide>
                <span className="break-words">{reviewed.reason}</span>
              </Field>
            </Fields>
            {reviewed.target ? (
              <Notice tone="info" title="What a pause does">
                New admissions that check the manual gate are blocked. Transactions that were already approved or sent are not cancelled, issued wallet requests
                and execution policies stay valid, and in-flight work may still complete. Order lookup and hash recovery stay available.
              </Notice>
            ) : (
              <Notice tone="attention" title="What a resume does">
                It clears the manual gate only. New orders stay paused while any other reason remains
                {reasonsLeft === null
                  ? " (runtime status is not available, so the other reasons are unknown)."
                  : reasonsLeft.length > 0
                    ? `: ${reasonList(reasonsLeft)} (as last reported).`
                    : " (none reported in the last runtime status read)."}
              </Notice>
            )}
            {reviewStale && (
              <Notice tone="attention" title={staleCopy.title} live>
                {staleCopy.body}
              </Notice>
            )}
            <div className="flex flex-wrap gap-2">
              {!reviewStale && <Button onClick={confirm}>{reviewed.target ? "Confirm pause" : "Confirm resume"}</Button>}
              <Button onClick={back}>Back</Button>
            </div>
          </div>
        ) : !ready || !state ? (
          <EmptyRow>{control.phase === "loading" ? "Reading the current state…" : "Read the current state successfully before changing it."}</EmptyRow>
        ) : beforeUnresolved ? (
          <EmptyRow>The state above was read before a command whose result is unknown. Read it again before starting a new command.</EmptyRow>
        ) : atLimit ? (
          <EmptyRow>The version limit was reached; no further change can be recorded.</EmptyRow>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs text-[var(--color-arco-ink)]">
              The manual gate is <strong>{gateWord(state.paused).toLowerCase()}</strong> (version {state.version}, read {value?.meta.observedAt}). Possible change:{" "}
              {target ? "pause new orders" : "resume the manual gate"}. The server decides whether this session may make it.
            </p>
            <label htmlFor={`${ids}-reason`} className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)]">
              Reason (recorded in the change history)
            </label>
            <textarea
              ref={reasonRef}
              id={`${ids}-reason`}
              value={text}
              rows={3}
              maxLength={REASON_MAX_LENGTH + 100}
              aria-invalid={showError && !check.ok}
              aria-describedby={`${ids}-reason-help ${ids}-reason-error`}
              onChange={(event) => {
                setText(event.target.value)
                setRefusal(null)
              }}
              className={`w-full min-w-0 resize-y rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 py-1.5 text-xs text-[var(--color-arco-ink)] ${FOCUS_RING}`}
            />
            <p id={`${ids}-reason-help`} className="text-[11px] text-[var(--color-arco-text-soft)]">
              Required, up to {REASON_MAX_LENGTH} characters, one line. Leading and trailing spaces are removed.{" "}
              <span className="font-mono">
                {text.trim().length}/{REASON_MAX_LENGTH}
              </span>
            </p>
            <p id={`${ids}-reason-error`} className="text-[11px] text-[var(--color-arco-down)]" aria-live="polite">
              {showError && !check.ok ? check.message : ""}
            </p>
            {refusal === "stale_review" && (
              <Notice tone="attention" title="The state changed while you were reviewing" live>
                Nothing was sent. Review the current state and the change again.
              </Notice>
            )}
            {refusal !== null && refusal !== "stale_review" && (
              <Notice tone="error" title="Not sent" live>
                {refusal === "version_limit"
                  ? "The version limit was reached."
                  : refusal === "not_ready" || refusal === "read_first"
                    ? "Read the current state successfully first."
                    : "The command could not be prepared."}
              </Notice>
            )}
            <div>
              <Button onClick={openReview}>{target ? "Review pause" : "Review resume"}</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function EventLine({ event }: { event: TradingControlEvent }) {
  return (
    <>
      Version {event.version}: {gateWord(event.previousPaused)} → {gateWord(event.paused)} at <Time iso={event.createdAt} /> by <Mono value={event.operatorId} />. Reason:{" "}
      <span className="break-words">{event.reason}</span>
    </>
  )
}

function CommandOutcome({ id, snapshot, command, reasonsLeft, onRetry, onDiscard, onRefresh }: {
  id: string
  snapshot: TradingControlSnapshot
  command: CommandState
  reasonsLeft: readonly PauseReason[] | null
  onRetry: () => void
  onDiscard: () => void
  onRefresh: () => void
}) {
  const verb = actionWord(command.command.paused)
  const key = <Mono value={command.command.idempotencyKey} short />
  const controlPhase = snapshot.control.phase
  const shown = snapshot.control.value?.data ?? null
  const close = <Button onClick={onDiscard}>Close</Button>
  const rereading =
    controlPhase === "loading"
      ? "The current state is being read again."
      : controlPhase === "error"
        ? "Reading the current state again failed; read it successfully before starting a new command."
        : "The current state was read again (shown above)."
  const body = (() => {
    switch (command.phase) {
      case "sending":
        return (
          <Notice tone="info" title={`Sending the ${verb} command…`} live>
            Attempt {command.attempts}, key {key}. Waiting for the server's answer. No new command can be started until this one is answered, or until its unknown
            result is discarded.
          </Notice>
        )
      case "accepted":
      case "replayed": {
        const result = command.result!
        const { change, state } = result.change
        const differs = state.version !== change.version || state.paused !== change.paused
        const shownNote =
          shown === null
            ? null
            : shown.deploymentDigest !== state.deploymentDigest
              ? controlPhase === "loading"
                ? "The state shown above is for a different deployment than this response; it is being read again."
                : controlPhase === "error"
                  ? "The state shown above is for a different deployment than this response; reading it again failed."
                  : "The state shown above is for a different deployment than this response: the server now serves that one."
              : shown.version > state.version
                ? `A newer state (version ${shown.version}) is shown above.`
                : null
        return (
          <Notice tone="info" title={command.phase === "accepted" ? `Recorded: the ${verb} command` : `Already recorded earlier: the ${verb} command (replayed)`} live>
            <span className="block">
              {command.phase === "replayed" && "The server returned this command's original event; nothing was changed again. "}
              This request's audit event: <EventLine event={change} />
            </span>
            <span className="mt-1 block">
              Manual gate in this response ({result.meta.observedAt}): {gateWord(state.paused)} · version {state.version}.
              {differs && ` It differs from this request's event: a later change (version ${state.version}) had been recorded by then.`}
              {shownNote && ` ${shownNote}`}
            </span>
            {state.deploymentDigest !== command.basis.deploymentDigest && (
              <span className="mt-1 block text-[var(--color-arco-down)]">The server answered for a different deployment than the one you reviewed.</span>
            )}
            {!command.command.paused && !differs && (
              <span className="mt-1 block">
                This is not a full trading resume.{" "}
                {reasonsLeft === null
                  ? "Whether other reasons remain is unknown until runtime status is read."
                  : reasonsLeft.length > 0
                    ? `Still paused by: ${reasonList(reasonsLeft)} (as last reported).`
                    : "See New-order admission for the runtime's latest report."}
              </span>
            )}
            {command.command.paused && !differs && <span className="mt-1 block">Transactions already approved or sent are not cancelled; in-flight work may still complete.</span>}
            <span className="mt-2 flex flex-wrap gap-2">{close}</span>
          </Notice>
        )
      }
      case "conflict":
        return (
          <Notice tone="attention" title="Not applied: the state changed first (409)" live>
            The {verb} was based on version {command.command.expectedVersion}, but the state had already moved on, so the server changed nothing for this request.
            {command.attempts > 1 && " Because the server checks the key before the version, this also shows that the earlier attempt with this key was not recorded."}{" "}
            {rereading} Review it and start a new command if a change is still needed; this command will not be resent.
            <span className="mt-2 flex flex-wrap gap-2">{close}</span>
          </Notice>
        )
      case "rejected": {
        const error = command.error
        const copy =
          error?.code === "CONTROL_IDEMPOTENCY_CONFLICT"
            ? `The server reports that this command's key is already recorded for a different command (409). This request changed nothing. ${rereading} Start a new command if a change is still needed.`
            : error?.kind === "forbidden"
              ? "The server refused the change (403). This session may not change trading control (stocks:control), or the session could not be verified. Nothing was changed."
              : error?.kind === "unauthorized"
                ? "The server did not accept the session (401). Nothing was changed."
                : error?.kind === "disabled"
                  ? "The change route is not available on this server (404). Nothing was changed."
                  : error?.kind === "configuration" || error?.kind === "unauthenticated"
                    ? "The command was not sent (no valid API base or session). Nothing was changed."
                    : "The server rejected the command as invalid (400). Nothing was changed."
        return (
          <Notice tone="error" title={`Not applied: the ${verb} command was refused`} live>
            {copy}
            <span className="mt-2 flex flex-wrap gap-2">{close}</span>
          </Notice>
        )
      }
      case "unknown": {
        const error = command.error
        const readiness = retryReadiness(snapshot)
        const note = snapshot.abandoned
        const sameSlot =
          note !== null &&
          note.idempotencyKey !== command.command.idempotencyKey &&
          note.expectedVersion === command.command.expectedVersion &&
          note.paused === command.command.paused &&
          note.reason === command.command.reason &&
          note.deploymentDigest === command.basis.deploymentDigest
        const status = error?.status ? ` (${error.status}${error.code ? ` ${error.code}` : ""})` : ""
        const why = command.retryRefused
          ? error?.status === 400
            ? `the identical command was refused as invalid${status}, so retrying cannot help`
            : error?.code === "CONTROL_IDEMPOTENCY_CONFLICT"
              ? `the server reports this key as already recorded with different details${status}, so retrying cannot help`
              : error?.kind === "forbidden" || error?.kind === "unauthorized"
                ? `the retry was refused${status}: this session may not change trading control now, or it could not be verified`
                : error?.kind === "disabled"
                  ? `the retry was refused${status}: the change route is not available on this server now`
                  : `the retry was refused${status}`
          : command.timedOut
            ? "no answer arrived in time"
            : error?.kind === "network"
              ? "the connection failed before an answer arrived"
              : error?.kind === "invalid"
                ? "the answer did not match the contract"
                : error?.status === 503
                  ? "the server reported that the control result is unavailable (503)"
                  : `the server answered ${error?.status ?? "without a status"}`
        return (
          <Notice tone="attention" title={`Result unknown: the ${verb} may or may not have been recorded`} live>
            <span className="block break-words">
              No verifiable answer: {why}.{command.retryRefused && " That refusal only concerns the retry; the earlier attempt may still have been recorded."} Do not
              assume that the {verb} failed or succeeded. Attempt {command.attempts}, key {key}.
            </span>
            <span className="mt-1 block">
              <RecordedCheck
                paused={command.command.paused}
                expectedVersion={command.command.expectedVersion}
                reason={command.command.reason}
                deploymentDigest={command.basis.deploymentDigest}
                scope={historyScope(snapshot)}
              />
              {sameSlot && (
                <>
                  {" "}
                  The earlier unresolved command (note above) has the same version, action and reason, so a matching version {command.command.expectedVersion + 1} entry
                  shows only that one of the two was recorded. A retry of this command settles which: a replay means this command, a version conflict (409) means the
                  earlier one.
                </>
              )}
            </span>
            {readiness === "deployment_changed" ? (
              <span className="mt-1 block text-[var(--color-arco-down)]">
                The server now serves a different deployment than the one this command was reviewed for. It cannot be retried here: its key belongs to the earlier
                deployment, and on this one it would be a new, unreviewed command. Discard this command, then review the current state and start a new command if a
                change is needed.
              </span>
            ) : readiness === "read_first" && snapshot.control.error?.kind === "disabled" ? (
              <span className="mt-1 block">The control routes are not available on this server now, so this command cannot be retried from this page.</span>
            ) : readiness === "read_first" ? (
              <span className="mt-1 block">
                Read the state and history first. Retrying becomes available after a successful read taken now, so a retry cannot reach another deployment
                unnoticed.
              </span>
            ) : readiness === null ? (
              <span className="mt-1 block">
                Retrying sends the identical command with the same key: if it was recorded, the server returns the original event instead of changing again.
                Discarding is safe too: a new command needs the current version, and the server refuses an outdated one.
              </span>
            ) : null}
            <span className="mt-2 flex flex-wrap gap-2">
              {readiness === null && <Button onClick={onRetry}>Retry the same command</Button>}
              <Button onClick={onRefresh}>Read state and history</Button>
              <Button onClick={onDiscard}>Discard this command</Button>
            </span>
          </Notice>
        )
      }
    }
  })()
  return (
    <div id={id} tabIndex={-1} className={`rounded-[var(--radius-card)] ${FOCUS_RING}`} data-testid="stocks-trading-control-outcome" data-outcome={command.phase} data-attempts={command.attempts}>
      {body}
    </div>
  )
}

function HistoryCard({ history, onLoadOlder, onRefresh }: { history: HistoryState; onLoadOlder: (beforeVersion: number) => void; onRefresh: () => void }) {
  const { items } = history
  return (
    <Card
      title="Change history"
      description="Recorded manual gate changes for this deployment, newest first. They are stored in the database and are not deleted automatically. Each page is a separate read."
      actions={<RefreshButton onClick={onRefresh} busy={history.phase === "loading"} what="change history" />}
    >
      <div className="flex min-w-0 flex-col gap-3" data-testid="stocks-trading-control-history" data-phase={history.phase} data-complete={history.complete}>
        {history.phase === "error" && history.error && (
          <Notice tone="error" title={readErrorCopy(history.error, "Change history").title}>
            {readErrorCopy(history.error, "Change history").body}
            {items.length > 0 &&
              (history.failedPage === "older"
                ? " Older changes could not be read; the entries below were read earlier."
                : ` The entries below are from an earlier read${history.observedAt ? ` at ${history.observedAt}` : ""}; they may not include later changes.`)}
          </Notice>
        )}
        {history.observedAt && (
          <p className="text-[11px] text-[var(--color-arco-text-soft)]">
            Newest page read at <span className="font-mono">{history.observedAt}</span>
          </p>
        )}
        {items.length === 0 ? (
          history.phase === "loading" ? (
            <EmptyRow>Reading the change history…</EmptyRow>
          ) : history.complete ? (
            <EmptyRow>
              {history.phase === "error" ? `No changes were recorded as of the earlier read${history.observedAt ? ` at ${history.observedAt}` : ""}.` : "No changes recorded for this deployment."}
            </EmptyRow>
          ) : history.phase === "error" ? null : (
            <EmptyRow>Not read yet.</EmptyRow>
          )
        ) : (
          <ol className="flex min-w-0 flex-col" aria-label="Manual gate changes, newest first">
            {items.map((event) => (
              <li key={event.id} className="min-w-0 border-t border-[var(--color-arco-border)] py-2 first:border-t-0" data-testid="stocks-trading-control-event" data-version={event.version}>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={event.paused ? "attention" : "neutral"}>{gateWord(event.paused)}</Pill>
                  <span className="text-xs text-[var(--color-arco-ink)]">
                    Version {event.version} · was {gateWord(event.previousPaused).toLowerCase()}
                  </span>
                  <Time iso={event.createdAt} />
                </div>
                <p className="mt-1 text-xs text-[var(--color-arco-ink)]">
                  By <Mono value={event.operatorId} /> · <span className="break-words">{event.reason}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
                  Event <Mono value={event.id} short />
                </p>
              </li>
            ))}
          </ol>
        )}
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {history.complete ? (
              <p className="text-xs text-[var(--color-arco-text-soft)]">End of history: no older changes.</p>
            ) : history.nextBeforeVersion !== null ? (
              <Button onClick={() => onLoadOlder(history.nextBeforeVersion as number)} disabled={!canLoadOlder(history)}>
                {history.phase === "loading" ? "Loading…" : "Load older changes"}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </Card>
  )
}
