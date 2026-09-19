// Read-only wallet submission diagnostics of the selected order (003E). It shows what the server's journal held at one
// database snapshot: per stage the status, the recorded hash (only when one was recorded) and the trusted receipt check.
// It offers one explicit Refresh and nothing else: no claim, outcome, reconcile, wallet request, signature, resend,
// hash entry or state change. Nothing here is permission to execute.

import { formatUtcMs } from "./format"
import { stateInfo, CATEGORY_LABEL } from "./states"
import type { DiagnosticsState, OrderSide, StocksAdminError, SubmissionDiagnostics, SubmissionStage, SubmissionStatus } from "./types"
import { Card, EmptyRow, Field, Fields, Mono, Notice, Pill, RefreshButton, STALE_AFTER_MS, Time, toneOf, type Tone } from "./ui"

type Props = {
  diagnostics: DiagnosticsState
  /** Whether the selected order's detail has loaded (its side is known only then). */
  detailReady: boolean
  now: number
  onRefresh: () => void
}

const STATUS: Record<SubmissionStatus, { label: string; tone: Tone }> = {
  REQUEST_MAY_START: { label: "Request reserved, no wallet answer recorded", tone: "attention" },
  UNKNOWN: { label: "Wallet result unknown", tone: "attention" },
  SUBMITTED: { label: "Hash recorded, receipt not verified", tone: "active" },
  CONFIRMED: { label: "Receipt verified: confirmed", tone: "neutral" },
  REVERTED: { label: "Receipt verified: reverted", tone: "negative" },
}

export function stageWord(side: OrderSide, stage: SubmissionStage["stage"]): string {
  if (stage === "APPROVAL") return "Approval"
  return side === "BUY" ? "Deposit" : "Escrow"
}

function diagnosticsErrorCopy(error: StocksAdminError): { title: string; body: string } {
  switch (error.kind) {
    case "not_found":
      return { title: "Order not found in the current deployment (404)", body: "The server has no such order in the deployment it serves now. Nothing is shown." }
    case "disabled":
      return { title: "Wallet submission diagnostics are not available on this server (404)", body: "The diagnostics route is not registered. Nothing is shown." }
    case "server":
      return { title: `Diagnostics unavailable${error.status ? ` (${error.status})` : ""}`, body: "The server could not read a consistent snapshot. Nothing new is shown." }
    case "network":
      return { title: "Could not reach the API", body: "The request failed before a response arrived. Nothing new is shown." }
    case "invalid":
      return { title: "Response did not match the diagnostics contract", body: "The response was rejected and none of it is shown (wrong profile, order, side, deployment, wallet, fields or permission flags)." }
    case "configuration":
      return { title: "Stocks admin API is not configured", body: "No request was sent." }
    case "aborted":
      return { title: "Request cancelled", body: "The request was cancelled before it finished." }
    default:
      return { title: `Request rejected${error.status ? ` (${error.status})` : ""}`, body: "The server rejected the request. Nothing new is shown." }
  }
}

export function SubmissionDiagnosticsCard({ diagnostics, detailReady, now, onRefresh }: Props) {
  // Defence in depth: only the selected order's own diagnostics, for the side of its loaded detail.
  const value = diagnostics.value && diagnostics.value.data.order.id === diagnostics.orderId && diagnostics.value.data.order.side === diagnostics.side ? diagnostics.value : null
  const age = value ? now - value.loadedAt : null
  const canRefresh = diagnostics.orderId !== null && diagnostics.side !== null
  return (
    <Card
      title="Wallet submissions (read only)"
      description="The server's wallet submission journal for this order at one database snapshot. This view cannot claim, record, reconcile, sign, send again or change any state."
      actions={canRefresh ? <RefreshButton onClick={onRefresh} busy={diagnostics.phase === "loading"} what="wallet submissions" /> : undefined}
    >
      <div className="flex min-w-0 flex-col gap-3" data-testid="stocks-admin-diagnostics" data-phase={diagnostics.phase}>
        {!canRefresh ? (
          <EmptyRow>{detailReady ? "Loading wallet submissions…" : "Wallet submissions load after the order detail (the order's side comes from it)."}</EmptyRow>
        ) : (
          <>
            <p className="text-[11px] leading-4 text-[var(--color-arco-text-soft)]">
              {value ? (
                <>
                  Server snapshot{" "}
                  <time dateTime={value.meta.observedAt} className="font-mono">
                    {value.meta.observedAt}
                  </time>{" "}
                  · loaded <span className="font-mono">{formatUtcMs(value.loadedAt)}</span>
                </>
              ) : diagnostics.phase === "loading" ? (
                "Loading…"
              ) : (
                "Not loaded"
              )}
            </p>
            {diagnostics.phase === "error" && diagnostics.error && (
              <Notice tone="error" title={diagnosticsErrorCopy(diagnostics.error).title} live>
                {value
                  ? `${diagnosticsErrorCopy(diagnostics.error).body} The record below is from the earlier snapshot ${value.meta.observedAt}, not a current one.`
                  : diagnosticsErrorCopy(diagnostics.error).body}
              </Notice>
            )}
            {diagnostics.phase !== "error" && value && age !== null && age > STALE_AFTER_MS && (
              <Notice tone="attention" title="Loaded more than 60 seconds ago">
                Refresh before relying on this record.
              </Notice>
            )}
            {value && <DiagnosticsBody data={value.data} observedAt={value.meta.observedAt} />}
          </>
        )}
      </div>
    </Card>
  )
}

function DiagnosticsBody({ data, observedAt }: { data: SubmissionDiagnostics; observedAt: string }) {
  const info = stateInfo(data.order.side, data.order.state)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Fields>
        <Field label="Order state at snapshot">
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone={toneOf(info.category)}>{data.order.state}</Pill>
            <span className="text-[var(--color-arco-text-soft)]">{CATEGORY_LABEL[info.category]}</span>
          </span>
        </Field>
        <Field label="Quote deadline">
          <Time iso={data.order.quoteExpiresAt} />
          <span className="block text-[11px] text-[var(--color-arco-text-soft)]">{data.order.quoteExpired ? "Passed as of the snapshot" : "Not passed as of the snapshot"}</span>
        </Field>
        <Field label="Journal enrollment" wide>
          {data.enrollment === "ENROLLED"
            ? "Enrolled: wallet submissions of this order are journaled."
            : "Not enrolled: this order has no wallet submission journal. Nothing was recorded, and this is not permission to send."}
        </Field>
        <Field label="Deployment"><Mono value={data.deploymentId} /></Field>
        <Field label="Deployment digest"><Mono value={data.deploymentDigest} short /></Field>
        <Field label="Intent key" wide><Mono value={data.intentKey} short /></Field>
      </Fields>
      <StageRecord side={data.order.side} stage="APPROVAL" row={data.approval} />
      <StageRecord side={data.order.side} stage="TRANSFER" row={data.transfer} />
      <Notice tone="info" title="Historical record only">
        A reserved request, an unknown result or a recorded hash is what happened, not an instruction. Nothing here can be executed, recorded
        again or resent: the server marks this record read only, with no execution authorization and no resubmission. A verified receipt only
        shows the transaction's result; the order state (above) shows whether shares were issued or burned and whether cash was paid. Server
        snapshot {observedAt}.
      </Notice>
    </div>
  )
}

function StageRecord({ side, stage, row }: { side: OrderSide; stage: SubmissionStage["stage"]; row: SubmissionStage | null }) {
  const word = stageWord(side, stage)
  return (
    <section className="min-w-0 border-t border-[var(--color-arco-border)] pt-3" data-testid="stocks-admin-diagnostics-stage" data-stage={stage} data-status={row?.status ?? "NONE"}>
      <h4 className="text-xs font-semibold text-[var(--color-arco-ink)]">
        {word} <span className="font-mono text-[11px] font-normal text-[var(--color-arco-text-soft)]">{stage}</span>
      </h4>
      {row === null ? (
        <div className="mt-2">
          <EmptyRow>No wallet request is recorded for the {word.toLowerCase()}.</EmptyRow>
        </div>
      ) : (
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={STATUS[row.status].tone}>{row.status}</Pill>
            <span className="text-xs text-[var(--color-arco-text-soft)]">{STATUS[row.status].label}</span>
          </div>
          <Fields>
            <Field label="Transaction hash" wide>
              {row.txHash ? <Mono value={row.txHash} /> : <span className="font-medium">No recorded hash</span>}
            </Field>
            <Field label="Claim recorded"><Time iso={row.createdAt} /></Field>
            <Field label="Last journal update"><Time iso={row.updatedAt} /></Field>
            <Field label="Claim id"><Mono value={row.claimId} /></Field>
            <Field label="Transaction digest"><Mono value={row.transactionDigest} short /></Field>
            {row.receipt ? (
              <>
                <Field label="Receipt check"><span className="font-mono">{row.receipt.status}</span></Field>
                <Field label="Receipt block"><span className="font-mono">{row.receipt.blockNumber}</span></Field>
                <Field label="Receipt block hash" wide><Mono value={row.receipt.blockHash} /></Field>
                <Field label="Receipt verification recorded"><Time iso={row.receipt.verifiedAt} /></Field>
              </>
            ) : (
              <Field label="Receipt check" wide>Not verified by the server</Field>
            )}
          </Fields>
          {row.status === "REQUEST_MAY_START" && <p className="text-xs text-[var(--color-arco-text-soft)]">A reserved request is a historical record. It is not permission to send.</p>}
          {row.status === "UNKNOWN" && (
            <p className="text-xs text-[var(--color-arco-text-soft)]">
              {row.txHash ? "The result was reported unknown with this recorded hash." : "No hash was recorded for this request. It is not entered, guessed or searched here."} Do not send the{" "}
              {word.toLowerCase()} again.
            </p>
          )}
          {row.status === "CONFIRMED" && (
            <p className="text-xs text-[var(--color-arco-text-soft)]">
              The server verified this transaction's receipt. That is not {side === "BUY" ? "issuance of the shares" : "the burn or the cash payout"}; the
              order state shows that.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
