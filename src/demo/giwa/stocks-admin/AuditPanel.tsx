import { AUDIT_LIST_LIMIT } from "./client"
import { formatCount, formatUtc } from "./format"
import { AuditDetail } from "./OrderDetail"
import type { AuditRow, ResourceState } from "./types"
import { DataList, EmptyRow, Mono, Notice, ResourceMeta, Time } from "./ui"

type Props = { audit: ResourceState<readonly AuditRow[]>; now: number; onRefresh: () => void }

/** Newest/oldest createdAt among the returned rows (server orders newest first). */
export function auditRange(rows: readonly AuditRow[]): { newest: string; oldest: string } | null {
  const times = rows.map((row) => row.createdAt).filter((iso) => Number.isFinite(Date.parse(iso)))
  if (times.length === 0) return null
  const sorted = [...times].sort((a, b) => Date.parse(a) - Date.parse(b))
  return { oldest: sorted[0], newest: sorted[sorted.length - 1] }
}

export function AuditPanel({ audit, now, onRefresh }: Props) {
  const rows = audit.value?.data ?? null
  const range = rows ? auditRange(rows) : null
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <ResourceMeta state={audit} now={now} onRefresh={onRefresh} what="audit history" />
      {rows === null ? (
        audit.phase === "error" ? null : <EmptyRow>Loading audit history…</EmptyRow>
      ) : (
        <section aria-labelledby="stocks-audit-heading" className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
          <h3 id="stocks-audit-heading" className="text-sm font-semibold text-[var(--color-arco-ink)]">Audit history</h3>
          <p className="text-xs leading-5 text-[var(--color-arco-text-soft)]">
            The server returned the latest {formatCount(String(rows.length))} immutable audit entries for this deployment (newest first, limit{" "}
            {AUDIT_LIST_LIMIT}).
            {range && (
              <>
                {" "}Returned range: <span className="font-mono">{formatUtc(range.oldest)}</span> to{" "}
                <span className="font-mono">{formatUtc(range.newest)}</span>.
              </>
            )}
          </p>
          {rows.length >= AUDIT_LIST_LIMIT && (
            <Notice tone="attention" title={`Limit of ${AUDIT_LIST_LIMIT} reached`}>
              Entries older than {range ? formatUtc(range.oldest) : "the oldest returned entry"} are not loaded. The console has no older page.
            </Notice>
          )}
          {rows.length === 0 ? (
            <EmptyRow>The server returned no audit entries for this deployment.</EmptyRow>
          ) : (
            <DataList
              label="Audit entries"
              wideClass="lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,2.4fr)]"
              stackClass="grid-cols-1"
              columns={[
                { key: "time", header: "Time" },
                { key: "action", header: "Action" },
                { key: "subject", header: "Subject" },
                { key: "detail", header: "Detail" },
              ]}
              rows={rows.map((row) => ({
                key: row.id,
                cells: {
                  time: <Time iso={row.createdAt} now={now} elapsed />,
                  action: <span className="break-words font-mono font-semibold">{row.action}</span>,
                  subject: <Mono value={row.subject} short />,
                  detail: row.detail.length === 0 ? <span className="text-[var(--color-arco-text-soft)]">No detail</span> : <AuditDetail entries={row.detail} />,
                },
              }))}
            />
          )}
        </section>
      )}
    </div>
  )
}
