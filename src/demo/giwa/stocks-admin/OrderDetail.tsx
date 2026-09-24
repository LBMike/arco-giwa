import { useId } from "react"
import { CASH_SCALE, CASH_UNIT, QUANTITY_SCALE } from "./format"
import {
  CATEGORY_LABEL,
  CUSTODY_STATUS,
  FUNDING_STATUS,
  OPERATION_KIND_LABEL,
  OPERATION_STATUS,
  RESERVATION_STATUS,
  lookupStatus,
  stateInfo,
} from "./states"
import { SubmissionDiagnosticsCard } from "./SubmissionDiagnostics"
import type { AuditRow, BuyOrderDetail, DetailState, DiagnosticsState, OperationRow, OrderDetail, ProofSummary, SellOrderDetail } from "./types"
import { Amount, Card, EmptyRow, FOCUS_RING, Field, Fields, Mono, Pill, ResourceMeta, Time, toneOf } from "./ui"

type Props = { detail: DetailState; diagnostics: DiagnosticsState; now: number; onRefresh: () => void; onRefreshDiagnostics: () => void }

export function OrderDetailView({ detail, diagnostics, now, onRefresh, onRefreshDiagnostics }: Props) {
  const ids = useId()
  // Defence in depth: never render a detail under a different selected order id.
  const value = detail.value && detail.value.data.order.id === detail.orderId ? detail.value.data : null
  return (
    <section
      aria-labelledby={`${ids}-detail`}
      className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]"
    >
      {/* Focus target after "Open detail" (the button that had focus unmounts with the Overview). */}
      <h2 id={`${ids}-detail`} tabIndex={-1} data-order-detail-heading="" className={`text-sm font-semibold text-[var(--color-arco-ink)] ${FOCUS_RING}`}>
        Order detail
        {detail.orderId && (
          <span className="ml-2 font-normal">
            <Mono value={detail.orderId} short />
          </span>
        )}
      </h2>
      {detail.orderId === null ? (
        <EmptyRow>Select an order to see its funding or custody, operations, transaction hashes and audit trail.</EmptyRow>
      ) : (
        <>
          <ResourceMeta state={detail} now={now} onRefresh={onRefresh} what="order detail" />
          {value && <DetailBody detail={value} now={now} />}
          {/* Only the selected order's own diagnostics (the store clears them with the selection). */}
          {diagnostics.orderId === detail.orderId && (
            <SubmissionDiagnosticsCard diagnostics={diagnostics} detailReady={value !== null} now={now} onRefresh={onRefreshDiagnostics} />
          )}
        </>
      )}
    </section>
  )
}

function DetailBody({ detail, now }: { detail: OrderDetail; now: number }) {
  const { order } = detail
  const info = stateInfo(order.side, order.state)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-ink)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--color-arco-on-dark)]">
          {order.side}
        </span>
        <Pill tone={toneOf(info.category)}>{order.state}</Pill>
        <span className="text-xs text-[var(--color-arco-text-soft)]">{CATEGORY_LABEL[info.category]} — {info.description}</span>
      </div>
      <Fields>
        <Field label="Order id" wide><Mono value={order.id} /></Field>
        <Field label="Wallet" wide><Mono value={order.wallet} /></Field>
        <Field label="Quantity"><Amount value={order.quantity} scale={QUANTITY_SCALE} unit={order.symbol} /></Field>
        <Field label={order.side === "BUY" ? "Cash due" : "Cash payout"}><Amount value={order.cashAmount} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
        <Field label="Created"><Time iso={order.createdAt} now={now} elapsed /></Field>
        <Field label="Last state change"><Time iso={order.updatedAt} now={now} elapsed /></Field>
        <Field label="Quote deadline"><Time iso={order.quoteExpiresAt} /></Field>
        <Field label="Version"><span className="font-mono">{order.version}</span></Field>
        <Field label="Order key" wide><Mono value={order.orderKey} /></Field>
        <Field label="Deployment id"><Mono value={order.deploymentId} /></Field>
        <Field label="Deployment digest"><Mono value={order.deploymentDigest} short /></Field>
      </Fields>
      {detail.side === "BUY" ? <BuySections detail={detail} /> : <SellSections detail={detail} />}
      <Operations operations={detail.operations} side={order.side} />
      <AuditTimeline rows={detail.audit} />
    </div>
  )
}

function ProofFields({ proof }: { proof: ProofSummary }) {
  return (
    <>
      <Field label="Evidence block">{proof.blockNumber ? <span className="font-mono">{proof.blockNumber}</span> : "Not recorded"}</Field>
      <Field label="Evidence digest">{proof.evidenceDigest ? <Mono value={proof.evidenceDigest} short /> : "Not recorded"}</Field>
      <Field label="Evidence block hash" wide>{proof.blockHash ? <Mono value={proof.blockHash} /> : "Not recorded"}</Field>
    </>
  )
}

function BuySections({ detail }: { detail: BuyOrderDetail }) {
  return (
    <>
      <Card headingLevel={3} title="Funding (BUY)" description="Finalized test cash deposits attributed to this order. Suspense rows are recorded but not credited.">
        {detail.funding.length === 0 ? (
          <EmptyRow>No funding recorded for this order.</EmptyRow>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.funding.map((row) => {
              const status = lookupStatus(FUNDING_STATUS, row.status)
              return (
                <li key={row.id} className="border-t border-[var(--color-arco-border)] pt-3 first:border-t-0 first:pt-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Pill tone={toneOf(status.category)}>{row.status}</Pill>
                    <span className="text-xs text-[var(--color-arco-text-soft)]">{status.label} · reason <span className="font-mono">{row.reason}</span></span>
                  </div>
                  <Fields>
                    <Field label="Amount"><Amount value={row.amount} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
                    <Field label="Recorded"><Time iso={row.createdAt} /></Field>
                    <Field label="Payer" wide><Mono value={row.payer} /></Field>
                    <Field label="Deposit transaction" wide><Mono value={row.txHash} /></Field>
                    <Field label="Funding id" wide><Mono value={row.id} /></Field>
                    <ProofFields proof={row.proof} />
                  </Fields>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
      <Card headingLevel={3} title="Mint holding" description="Finalized mint recorded for this order.">
        {detail.holdings.length === 0 ? (
          <EmptyRow>No finalized mint holding recorded for this order.</EmptyRow>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.holdings.map((row) => (
              <li key={`${row.orderId}-${row.txHash}`}>
                <Fields>
                  <Field label="Quantity"><Amount value={row.quantity} scale={QUANTITY_SCALE} unit={row.symbol} /></Field>
                  <Field label="Finalized block"><span className="font-mono">{row.blockNumber}</span></Field>
                  <Field label="Recipient" wide><Mono value={row.wallet} /></Field>
                  <Field label="Mint transaction" wide><Mono value={row.txHash} /></Field>
                  <Field label="Block hash" wide><Mono value={row.blockHash} /></Field>
                  <Field label="Recorded"><Time iso={row.createdAt} /></Field>
                </Fields>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function SellSections({ detail }: { detail: SellOrderDetail }) {
  return (
    <>
      <Card headingLevel={3} title="Escrow custody (SELL)" description="Finalized stock escrow observed for this order.">
        {detail.custody.length === 0 ? (
          <EmptyRow>No escrow custody recorded for this order.</EmptyRow>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.custody.map((row) => {
              const status = lookupStatus(CUSTODY_STATUS, row.status)
              return (
                <li key={row.id} className="border-t border-[var(--color-arco-border)] pt-3 first:border-t-0 first:pt-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Pill tone={toneOf(status.category)}>{row.status}</Pill>
                    <span className="text-xs text-[var(--color-arco-text-soft)]">{status.label} · reason <span className="font-mono">{row.reason}</span></span>
                  </div>
                  <Fields>
                    <Field label="Quantity"><Amount value={row.quantity} scale={QUANTITY_SCALE} unit={detail.order.symbol} /></Field>
                    <Field label="Recorded"><Time iso={row.createdAt} /></Field>
                    <Field label="Payer" wide><Mono value={row.payer} /></Field>
                    <Field label="Escrow transaction" wide><Mono value={row.txHash} /></Field>
                    <Field label="Escrow id" wide><Mono value={row.escrowId} /></Field>
                    <ProofFields proof={row.proof} />
                  </Fields>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
      <Card headingLevel={3} title="Cash reservations (SELL)" description="Test cash reserved for this order's payout. A reservation is not an extra asset.">
        {detail.reservations.length === 0 ? (
          <EmptyRow>No cash reservation recorded for this order.</EmptyRow>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.reservations.map((row) => {
              const status = lookupStatus(RESERVATION_STATUS, row.status)
              return (
                <li key={`${row.orderId}-${row.createdAt}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Pill tone={toneOf(status.category)}>{row.status}</Pill>
                    <span className="text-xs text-[var(--color-arco-text-soft)]">{status.label}</span>
                  </div>
                  <Fields>
                    <Field label="Amount"><Amount value={row.amount} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
                    <Field label="Reserved"><Time iso={row.createdAt} /></Field>
                    <Field label="Liquidity scope" wide><Mono value={row.scopeKey} /></Field>
                  </Fields>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </>
  )
}

function Operations({ operations, side }: { operations: readonly OperationRow[]; side: "BUY" | "SELL" }) {
  return (
    <Card headingLevel={3} title="Operations" description="Durable broker and chain operations. Unknown outcomes are looked up by their original identity; this console cannot retry or resubmit.">
      {operations.length === 0 ? (
        <EmptyRow>No operations recorded for this order.</EmptyRow>
      ) : (
        <ol className="flex flex-col gap-3">
          {operations.map((row) => {
            const status = lookupStatus(OPERATION_STATUS, row.status)
            return (
              <li key={row.id} className="border-t border-[var(--color-arco-border)] pt-3 first:border-t-0 first:pt-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--color-arco-ink)]">{OPERATION_KIND_LABEL[row.kind] ?? row.kind}</span>
                  <span className="font-mono text-[11px] text-[var(--color-arco-text-soft)]">{row.kind}</span>
                  <Pill tone={toneOf(status.category)}>{row.status}</Pill>
                  <span className="text-xs text-[var(--color-arco-text-soft)]">{status.label}</span>
                </div>
                <Fields>
                  <Field label="Operation id" wide><Mono value={row.id} /></Field>
                  <Field label="Transaction hash" wide>{row.txHash ? <Mono value={row.txHash} /> : "No transaction (off-chain step or not yet submitted)"}</Field>
                  <Field label="Created"><Time iso={row.createdAt} /></Field>
                  {side === "BUY" && <Field label="Worker lease until">{row.leaseUntil ? <Time iso={row.leaseUntil} /> : "No active lease"}</Field>}
                </Fields>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}

function AuditTimeline({ rows }: { rows: readonly AuditRow[] }) {
  return (
    <Card headingLevel={3} title="Audit trail" description={`${rows.length} immutable entries for this order, oldest first, as returned by the server.`}>
      {rows.length === 0 ? (
        <EmptyRow>No audit entries returned for this order.</EmptyRow>
      ) : (
        <ol className="flex flex-col gap-3 border-l border-[var(--color-arco-border)] pl-3">
          {rows.map((row) => (
            <li key={row.id} className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-mono font-semibold text-[var(--color-arco-ink)]">{row.action}</span>
                <Time iso={row.createdAt} />
              </p>
              {row.detail.length > 0 && <AuditDetail entries={row.detail} />}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

export function AuditDetail({ entries }: { entries: AuditRow["detail"] }) {
  return (
    <dl className="mt-1 grid min-w-0 grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-mono text-[11px] text-[var(--color-arco-text-soft)]">{key}</dt>
          <dd className="min-w-0 break-all font-mono text-[11px] text-[var(--color-arco-ink)]">{value === null ? "null" : String(value)}</dd>
        </div>
      ))}
    </dl>
  )
}
