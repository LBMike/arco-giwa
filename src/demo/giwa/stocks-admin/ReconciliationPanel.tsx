import { CASH_SCALE, CASH_UNIT, QUANTITY_SCALE, formatCount, formatDuration, formatEpochSeconds, formatUtc } from "./format"
import { PENDING_KIND_LABEL, RECONCILIATION_HEADLINE, RECONCILIATION_REASON } from "./states"
import type { Reconciliation, ReconciliationDifference, ResourceState, StocksEnvelopeMeta } from "./types"
import { Amount, Card, DataList, EmptyRow, Field, Fields, Mono, Notice, Pill, ResourceMeta, type Tone } from "./ui"

/** Server rule (reconciliation.ts): coverage older than this is INCOMPLETE. */
const COVERAGE_WINDOW_MS = 60_000
const STOCK_UNIT = "stock units"

type Props = { reconciliation: ResourceState<Reconciliation>; now: number; onRefresh: () => void }

const STATUS_TONE: Record<Reconciliation["status"], Tone> = {
  MATCHED_AT_CUTOFF: "positive",
  MISMATCH: "negative",
  UNAVAILABLE: "attention",
  INCOMPLETE: "attention",
}

function unitOf(asset: string): { scale: number; unit: string } | null {
  if (asset === "TEST_CASH") return { scale: CASH_SCALE, unit: CASH_UNIT }
  if (asset.startsWith("STOCK_")) return { scale: QUANTITY_SCALE, unit: STOCK_UNIT }
  return null
}

export function ReconciliationPanel({ reconciliation, now, onRefresh }: Props) {
  const value = reconciliation.value
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <ResourceMeta state={reconciliation} now={now} onRefresh={onRefresh} what="reconciliation" />
      {!value ? (
        reconciliation.phase === "error" ? null : <EmptyRow>Loading reconciliation…</EmptyRow>
      ) : (
        <ReconciliationBody result={value.data} meta={value.meta} />
      )}
    </div>
  )
}

function ReconciliationBody({ result, meta }: { result: Reconciliation; meta: StocksEnvelopeMeta }) {
  const compared = result.status === "MATCHED_AT_CUTOFF" || result.status === "MISMATCH"
  return (
    <>
      <section
        aria-labelledby="stocks-reconciliation-status"
        className={`rounded-[var(--radius-card)] border bg-[var(--color-arco-surface)] p-4 ${
          result.status === "MISMATCH"
            ? "border-[var(--color-arco-down)]"
            : result.status === "MATCHED_AT_CUTOFF"
              ? "border-[var(--color-arco-up)]"
              : "border-dashed border-[var(--color-arco-ink)]"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={STATUS_TONE[result.status]}>{result.status}</Pill>
          <h2 id="stocks-reconciliation-status" className="text-sm font-semibold text-[var(--color-arco-ink)]">
            {RECONCILIATION_HEADLINE[result.status]}
          </h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--color-arco-text-soft)]">
          {result.status === "MATCHED_AT_CUTOFF" && result.cutoff && (
            <>
              Ledger entries settled through finalized block <span className="font-mono">{formatCount(result.cutoff.throughBlock)}</span> equal the
              chain balances read at that block. This is a statement about that cutoff only — it does not say current balances match or that the
              vault is solvent now.
            </>
          )}
          {result.status === "MISMATCH" && result.cutoff && (
            <>
              At finalized block <span className="font-mono">{formatCount(result.cutoff.throughBlock)}</span> the ledger and chain differ for{" "}
              {result.differences.length} {result.differences.length === 1 ? "value" : "values"}. Differences are listed below; nothing is corrected
              from this console.
            </>
          )}
          {!compared && (
            <>
              The server did not compare ledger and chain balances. This is not a zero difference and not a match.
            </>
          )}
        </p>
        {result.reason && (
          <p className="mt-2 text-xs leading-5 text-[var(--color-arco-ink)]">
            Reason <span className="font-mono">{result.reason}</span>
            {RECONCILIATION_REASON[result.reason] ? ` — ${RECONCILIATION_REASON[result.reason]}` : ""}
          </p>
        )}
      </section>

      {result.cutoff && <CutoffCard result={result} meta={meta} />}

      {compared && result.snapshot && (
        <Card title="Finalized chain values at the cutoff" description="Independently read at the cutoff block by the server's trusted RPC port.">
          <Fields>
            <Field label="Vault test cash"><Amount value={result.snapshot.cashBalance} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
            <Field label="Stock total supply"><Amount value={result.snapshot.stockSupply} scale={QUANTITY_SCALE} unit={STOCK_UNIT} /></Field>
            <Field label="Stock held in redemption escrow"><Amount value={result.snapshot.escrowBalance} scale={QUANTITY_SCALE} unit={STOCK_UNIT} /></Field>
            <Field label="Block time">{formatEpochSeconds(result.snapshot.blockTimestamp) ?? "Not reported"}</Field>
          </Fields>
          <h3 className="mt-4 text-xs font-semibold text-[var(--color-arco-ink)]">Known wallet balances ({result.snapshot.walletBalances.length})</h3>
          {result.snapshot.walletBalances.length === 0 ? (
            <EmptyRow>No wallet balances were part of this comparison.</EmptyRow>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {result.snapshot.walletBalances.map(([wallet, balance]) => (
                <li key={wallet} className="flex min-w-0 flex-col gap-0.5 border-t border-[var(--color-arco-border)] pt-2 first:border-t-0 first:pt-0">
                  <Mono value={wallet} />
                  <Amount value={balance} scale={QUANTITY_SCALE} unit={STOCK_UNIT} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {result.status === "MISMATCH" && <Differences rows={result.differences} />}

      {compared && result.currentLiabilities && (
        <Card
          title="Current ledger liabilities"
          description="Read at response time, not at the cutoff block. Shown separately and not part of the comparison above; the values are not added together."
        >
          <Fields>
            <Field label="Ledger vault cash (all journal entries)"><Amount value={result.currentLiabilities.cashBalance} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
            <Field label="Funding liabilities (suspense, refunds, unfinished BUY)"><Amount value={result.currentLiabilities.liabilities} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
            <Field label="Reserved for SELL payouts"><Amount value={result.currentLiabilities.sellReserved} scale={CASH_SCALE} unit={CASH_UNIT} /></Field>
          </Fields>
        </Card>
      )}

      <Card
        title={`In-flight attention items (${result.pending.length})`}
        description="Unfinished orders, operations, suspense funding and custody reported at response time, independent of the comparison status."
      >
        {result.pending.length === 0 ? (
          <EmptyRow>The server reported no in-flight attention items.</EmptyRow>
        ) : (
          <DataList
            label="In-flight attention items"
            wideClass="md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.4fr)]"
            columns={[
              { key: "kind", header: "Kind" },
              { key: "status", header: "Status" },
              { key: "id", header: "Id" },
            ]}
            rows={result.pending.map((item) => ({
              key: `${item.kind}:${item.id}`,
              cells: {
                kind: (
                  <>
                    {PENDING_KIND_LABEL[item.kind] ?? item.kind}
                    <span className="block font-mono text-[11px] text-[var(--color-arco-text-soft)]">{item.kind}</span>
                  </>
                ),
                status: <span className="break-words font-mono">{item.status}</span>,
                id: <Mono value={item.id} />,
              },
            }))}
          />
        )}
      </Card>
    </>
  )
}

function CutoffCard({ result, meta }: { result: Reconciliation; meta: StocksEnvelopeMeta }) {
  const cutoff = result.cutoff
  if (!cutoff) return null
  const coverageMs = Date.parse(cutoff.observedAt)
  const responseMs = Date.parse(meta.observedAt)
  const lag = Number.isFinite(coverageMs) && Number.isFinite(responseMs) ? responseMs - coverageMs : null
  const compared = result.status === "MATCHED_AT_CUTOFF" || result.status === "MISMATCH"
  return (
    <Card
      title={compared ? "Cutoff" : "Observer coverage reported (not used for a comparison)"}
      description="The observer vouches that every relevant finalized log through this block was ingested."
    >
      <Fields>
        <Field label="Through block">{cutoff.throughBlock ? <span className="font-mono">{cutoff.throughBlock}</span> : "Not reported"}</Field>
        <Field label="Coverage observed at">{cutoff.observedAt ? <span className="font-mono">{formatUtc(cutoff.observedAt)}</span> : "Not reported"}</Field>
        <Field label="Block hash" wide>{cutoff.blockHash ? <Mono value={cutoff.blockHash} /> : "Not reported"}</Field>
        <Field label="Coverage age at server response">
          {lag === null ? (
            "Cannot be computed"
          ) : lag < 0 ? (
            <span className="text-[var(--color-arco-ink)]">Coverage time is {formatDuration(-lag)} after the response time</span>
          ) : (
            <span className={lag > COVERAGE_WINDOW_MS ? "font-semibold text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}>
              {formatDuration(lag)}
              {lag > COVERAGE_WINDOW_MS ? " — older than the 60 s coverage window" : ""}
            </span>
          )}
        </Field>
        <Field label="Deployment digest"><Mono value={cutoff.deploymentDigest || "Not reported"} short /></Field>
      </Fields>
    </Card>
  )
}

function Differences({ rows }: { rows: readonly ReconciliationDifference[] }) {
  return (
    <Card title={`Differences at the cutoff (${rows.length})`} description="Expected = settled ledger through the cutoff block. Actual = finalized chain value at that block.">
      <Notice tone="error" title="Balances do not match at this cutoff">
        Investigate with the order and audit evidence. This console has no correction, mint or balance-edit command.
      </Notice>
      <div className="mt-3">
        <DataList
          label="Reconciliation differences"
          wideClass="md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]"
          stackClass="grid-cols-1"
          columns={[
            { key: "asset", header: "Asset" },
            { key: "expected", header: "Expected (ledger)" },
            { key: "actual", header: "Actual (chain)" },
          ]}
          rows={rows.map((row, index) => {
            const unit = unitOf(row.asset)
            return {
              key: `${row.asset}:${row.wallet ?? index}`,
              cells: {
                asset: (
                  <>
                    <span className="font-mono">{row.asset}</span>
                    {row.wallet && (
                      <span className="mt-0.5 block">
                        <Mono value={row.wallet} />
                      </span>
                    )}
                  </>
                ),
                expected: unit ? <Amount value={row.expected} scale={unit.scale} unit={unit.unit} /> : <span className="break-all font-mono">{row.expected} base units</span>,
                actual:
                  row.actual === null ? (
                    "Not returned by the chain snapshot"
                  ) : unit ? (
                    <Amount value={row.actual} scale={unit.scale} unit={unit.unit} />
                  ) : (
                    <span className="break-all font-mono">{row.actual} base units</span>
                  ),
              },
            }
          })}
        />
      </div>
    </Card>
  )
}
