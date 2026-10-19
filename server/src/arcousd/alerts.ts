import { parseArcoUSDAlertEnv, type ArcoUSDAlertEnv } from "./alert-config.js"
import { anyDelivered, deliver, type AlertChannel, type Delivery } from "./notify.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile } from "./registry.js"
import { safeErrorText } from "./safe-error.js"
import { duration, type Finding, type Severity } from "./watch.js"

// The alert book (docs/operations/arcousd-alerts.md): turns each round's findings into alert rows
// and the messages to send.
//   PENDING   the condition was seen but has not yet held for its sustain time (nobody is told);
//   OPEN      it held: sent once, again when its fingerprint changes, and every repeat interval;
//   RESOLVED  it cleared: "resolved" is sent if the opening was sent.
// A send that reaches no channel leaves the row unmarked so the next round tries again — the
// "resolved" line too: a RESOLVED row whose last send predates its resolution stays in `active` (for
// a day) until that line is out. One row per key is reused across occurrences (a returning condition
// starts again at PENDING). Delivery is at least once: a crash between the send and the save repeats it.

export type AlertStatus = "PENDING" | "OPEN" | "RESOLVED"

export type AlertRecord = {
  readonly key: string
  severity: Severity
  status: AlertStatus
  title: string
  detail: string
  /** OPEN: the fingerprint last sent; PENDING: the current one. */
  fingerprint: string
  firstSeenAt: Date
  lastSeenAt: Date
  openedAt: Date | null
  resolvedAt: Date | null
  lastNotifiedAt: Date | null
  notifyCount: number
  delivery: Delivery | null
}

export type NoticeKind = "opened" | "updated" | "repeat" | "resolved"
export type Notice = { readonly kind: NoticeKind; readonly record: AlertRecord; readonly fingerprint: string }

export function stepAlerts(input: {
  readonly active: readonly AlertRecord[]
  readonly findings: readonly Finding[]
  readonly now: Date
  readonly repeatCriticalMs: number
  readonly repeatWarningMs: number
  /** false while no channel is configured: rows still move, nothing is queued to send. */
  readonly notify: boolean
  /** Keys this round could not evaluate (a read failed): their rows stay as they are, not resolved. */
  readonly unknown?: (key: string) => boolean
  /** Keys that cleared because something bigger replaced them (aging → overdue): resolve without a message. */
  readonly quiet?: (key: string) => boolean
  /** The previous completed round: a PENDING condition it did not see starts its sustain clock again. */
  readonly previousRoundAt?: Date | null
  /** A PENDING condition unseen this long starts again too (after a restart, or a run of failed rounds). */
  readonly maxGapMs?: number
}): { records: AlertRecord[]; notices: Notice[] } {
  const now = input.now
  const previous = new Map(input.active.map((record) => [record.key, record]))
  const records: AlertRecord[] = []
  const notices: Notice[] = []
  const seen = new Set<string>()

  for (const finding of input.findings) {
    if (seen.has(finding.key)) continue
    seen.add(finding.key)
    const stored = previous.get(finding.key)
    previous.delete(finding.key)
    // A resolved row still owed its "resolved" line (active() returns no other RESOLVED rows): nobody was
    // told it cleared, so it simply carries on as the open alert everyone last heard about.
    const prior = stored && stored.status === "RESOLVED" ? { ...stored, status: "OPEN" as const, resolvedAt: null } : stored
    const record: AlertRecord = prior
      ? { ...prior, severity: finding.severity, title: finding.title, detail: finding.detail, lastSeenAt: now }
      : {
          key: finding.key,
          severity: finding.severity,
          status: "PENDING",
          title: finding.title,
          detail: finding.detail,
          fingerprint: finding.fingerprint,
          firstSeenAt: now,
          lastSeenAt: now,
          openedAt: null,
          resolvedAt: null,
          lastNotifiedAt: null,
          notifyCount: 0,
          delivery: null,
        }
    if (record.status !== "OPEN") {
      record.fingerprint = finding.fingerprint
      if (prior && !continuous(prior.lastSeenAt, now, input)) record.firstSeenAt = now
      if (now.getTime() - record.firstSeenAt.getTime() >= finding.sustainMs) {
        record.status = "OPEN"
        record.openedAt = now
        if (input.notify) notices.push({ kind: "opened", record, fingerprint: finding.fingerprint })
      }
    } else if (input.notify) {
      const repeatMs = record.severity === "CRITICAL" ? input.repeatCriticalMs : input.repeatWarningMs
      if (record.lastNotifiedAt === null) notices.push({ kind: "opened", record, fingerprint: finding.fingerprint })
      else if (finding.fingerprint !== record.fingerprint) notices.push({ kind: "updated", record, fingerprint: finding.fingerprint })
      else if (now.getTime() - record.lastNotifiedAt.getTime() >= repeatMs) notices.push({ kind: "repeat", record, fingerprint: finding.fingerprint })
    } else {
      record.fingerprint = finding.fingerprint
    }
    records.push(record)
  }

  for (const prior of previous.values()) {
    if (input.unknown?.(prior.key)) continue // not seen this round is not the same as cleared
    if (prior.status === "RESOLVED") {
      // Resolved earlier, but no channel took the "resolved" line yet: try again.
      if (input.notify && resolvedUnsent(prior)) {
        const record: AlertRecord = { ...prior }
        notices.push({ kind: "resolved", record, fingerprint: prior.fingerprint })
        records.push(record)
      }
      continue
    }
    const record: AlertRecord = { ...prior, status: "RESOLVED", resolvedAt: now }
    if (prior.status === "OPEN" && prior.lastNotifiedAt !== null && input.quiet?.(prior.key)) {
      record.lastNotifiedAt = now // replaced by a bigger alert: no "resolved" line is owed
    } else if (prior.status === "OPEN" && input.notify && prior.lastNotifiedAt !== null) {
      notices.push({ kind: "resolved", record, fingerprint: prior.fingerprint })
    }
    records.push(record)
  }
  return { records, notices }
}

/**
 * Was the condition seen without a break? It must have been seen by the previous completed round, and
 * not too long ago either (a streak of failed rounds in between is a break too).
 */
function continuous(lastSeenAt: Date, now: Date, input: { readonly previousRoundAt?: Date | null; readonly maxGapMs?: number }): boolean {
  if (input.previousRoundAt && lastSeenAt.getTime() < input.previousRoundAt.getTime()) return false
  return input.maxGapMs === undefined || now.getTime() - lastSeenAt.getTime() <= input.maxGapMs
}

/** RESOLVED after its opening was sent, and no send since: its "resolved" line is still owed. */
export function resolvedUnsent(record: Pick<AlertRecord, "status" | "openedAt" | "resolvedAt" | "lastNotifiedAt">): boolean {
  return (
    record.status === "RESOLVED" &&
    record.openedAt !== null &&
    record.resolvedAt !== null &&
    record.lastNotifiedAt !== null &&
    record.lastNotifiedAt.getTime() < record.resolvedAt.getTime()
  )
}

/** After a send: rows reached on any channel are marked; the delivery result is kept either way. */
export function applyDelivery(notices: readonly Notice[], delivery: Delivery, now: Date): void {
  const delivered = anyDelivered(delivery)
  for (const notice of notices) {
    notice.record.delivery = delivery
    if (!delivered) continue
    notice.record.lastNotifiedAt = now
    notice.record.notifyCount += 1
    notice.record.fingerprint = notice.fingerprint
  }
}

// ─────────────────────────────── messages ───────────────────────────────

const MARK: Record<Severity, string> = { CRITICAL: "🔴 CRITICAL", WARNING: "🟠 WARNING" }

/** One message per round: problems by severity, then what cleared, then the console link. */
export function formatDigest(notices: readonly Notice[], options: { network: string; consoleUrl: string | null; now: Date; maxChars?: number }): string {
  const rank = (notice: Notice) => (notice.kind === "resolved" ? 2 : notice.record.severity === "CRITICAL" ? 0 : 1)
  const ordered = [...notices].sort((a, b) => rank(a) - rank(b))
  const critical = ordered.filter((notice) => rank(notice) === 0).length
  const warning = ordered.filter((notice) => rank(notice) === 1).length
  const resolved = ordered.filter((notice) => rank(notice) === 2).length
  const summary = [critical && `${critical} critical`, warning && `${warning} warning`, resolved && `${resolved} resolved`].filter(Boolean).join(" · ")
  const header = `ArcoUSD alerts · ${options.network}\n${summary}`
  const footer = options.consoleUrl ? `\nConsole: ${options.consoleUrl}` : ""
  const budget = (options.maxChars ?? 3_800) - header.length - footer.length - 60
  const blocks: string[] = []
  let used = 0
  for (const notice of ordered) {
    const block = noticeText(notice, options.now)
    if (used + block.length + 2 > budget) break
    blocks.push(block)
    used += block.length + 2
  }
  const more = ordered.length - blocks.length
  return [header, ...blocks, ...(more > 0 ? [`…and ${more} more in the console.`] : [])].join("\n\n") + footer
}

function noticeText(notice: Notice, now: Date): string {
  const record = notice.record
  if (notice.kind === "resolved") {
    const openFor = record.openedAt ? ` after ${duration((now.getTime() - record.openedAt.getTime()) / 1000)}` : ""
    return `✅ RESOLVED · ${record.title}${openFor}`
  }
  const note =
    notice.kind === "updated"
      ? " (changed)"
      : notice.kind === "repeat" && record.openedAt
        ? ` (open ${duration((now.getTime() - record.openedAt.getTime()) / 1000)})`
        : ""
  return `${MARK[record.severity]}${note} · ${record.title}\n${record.detail}`
}

export function formatTestMessage(options: { network: string; operator: string | null; consoleUrl: string | null }): string {
  const by = options.operator ? ` by ${options.operator.slice(0, 6)}…${options.operator.slice(-4)}` : ""
  return `ArcoUSD test alert · ${options.network}\nSent from the admin console${by}. If you can read this, ArcoUSD alerts reach this channel.${
    options.consoleUrl ? `\nConsole: ${options.consoleUrl}` : ""
  }`
}

// ─────────────────────────────── store ───────────────────────────────

export type Heartbeat = { readonly lastRunAt: Date; readonly lastOkAt: Date | null; readonly lastError: string | null; readonly data: unknown }

export type ArcoUSDAlertStore = {
  /** PENDING and OPEN rows, plus RESOLVED ones of the last day whose "resolved" line was not sent yet. */
  active(chainId: number, now: Date): Promise<AlertRecord[]>
  /** Active rows plus those resolved since `since`, newest first. */
  recent(chainId: number, since: Date): Promise<AlertRecord[]>
  save(chainId: number, record: AlertRecord): Promise<void>
  beat(chainId: number, name: string, beat: { at: Date; ok: boolean; error?: string; data?: unknown }): Promise<void>
  heartbeat(chainId: number, name: string): Promise<Heartbeat | null>
}

export type PrismaArcoUSDAlertDelegates = {
  arcoUSDAlert: { findMany(args: unknown): Promise<unknown[]>; upsert(args: unknown): Promise<unknown> }
  arcoUSDHeartbeat: { upsert(args: unknown): Promise<unknown>; findUnique(args: unknown): Promise<unknown | null> }
}

const RECENT_ROWS = 200

export class PrismaArcoUSDAlertStore implements ArcoUSDAlertStore {
  constructor(private readonly prisma: PrismaArcoUSDAlertDelegates) {}

  async active(chainId: number, now: Date) {
    const rows = await this.prisma.arcoUSDAlert.findMany({
      where: {
        chainId,
        OR: [
          { status: { in: ["PENDING", "OPEN"] } },
          { status: "RESOLVED", resolvedAt: { gte: new Date(now.getTime() - RESOLVED_WINDOW_MS) }, openedAt: { not: null }, lastNotifiedAt: { not: null } },
        ],
      },
    })
    return rows.map(toRecord).filter((record) => record.status !== "RESOLVED" || resolvedUnsent(record))
  }

  async recent(chainId: number, since: Date) {
    const rows = await this.prisma.arcoUSDAlert.findMany({
      where: { chainId, OR: [{ status: { in: ["PENDING", "OPEN"] } }, { status: "RESOLVED", resolvedAt: { gte: since } }] },
      orderBy: { lastSeenAt: "desc" },
      take: RECENT_ROWS,
    })
    return rows.map(toRecord)
  }

  async save(chainId: number, record: AlertRecord) {
    const data = {
      severity: record.severity,
      status: record.status,
      title: record.title,
      detail: record.detail,
      fingerprint: record.fingerprint,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      openedAt: record.openedAt,
      resolvedAt: record.resolvedAt,
      lastNotifiedAt: record.lastNotifiedAt,
      notifyCount: record.notifyCount,
      // {} = no send for this occurrence (a reused row must not keep the last one's channel errors).
      delivery: record.delivery ?? {},
    }
    await this.prisma.arcoUSDAlert.upsert({
      where: { chainId_key: { chainId, key: record.key } },
      create: { chainId, key: record.key, ...data },
      update: data,
    })
  }

  async beat(chainId: number, name: string, beat: { at: Date; ok: boolean; error?: string; data?: unknown }) {
    const outcome = beat.ok ? { lastOkAt: beat.at, lastError: null } : { lastError: (beat.error ?? "failed").slice(0, 500) }
    await this.prisma.arcoUSDHeartbeat.upsert({
      where: { chainId_name: { chainId, name } },
      create: { chainId, name, lastRunAt: beat.at, ...outcome, data: beat.data ?? undefined },
      update: { lastRunAt: beat.at, ...outcome, data: beat.data ?? undefined },
    })
  }

  async heartbeat(chainId: number, name: string) {
    const row = (await this.prisma.arcoUSDHeartbeat.findUnique({ where: { chainId_name: { chainId, name } } })) as
      | { lastRunAt: Date; lastOkAt: Date | null; lastError: string | null; data: unknown }
      | null
    return row ? { lastRunAt: row.lastRunAt, lastOkAt: row.lastOkAt, lastError: row.lastError, data: row.data } : null
  }
}

function toRecord(row: unknown): AlertRecord {
  const r = row as AlertRecord & { delivery: unknown }
  return {
    key: r.key,
    severity: r.severity,
    status: r.status,
    title: r.title,
    detail: r.detail,
    fingerprint: r.fingerprint,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    openedAt: r.openedAt ?? null,
    resolvedAt: r.resolvedAt ?? null,
    lastNotifiedAt: r.lastNotifiedAt ?? null,
    notifyCount: r.notifyCount ?? 0,
    delivery: r.delivery && typeof r.delivery === "object" && Object.keys(r.delivery).length ? (r.delivery as Delivery) : null,
  }
}

// ─────────────────────────────── console view ───────────────────────────────

export const WATCHER_HEARTBEAT = "watcher"
/** Written by the queue keeper (keeper.ts) each round; read by the watcher and the console. */
export const KEEPER_HEARTBEAT = "keeper"
const RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000
const TEST_COOLDOWN_MS = 30_000

export type AlertView = {
  readonly key: string
  readonly severity: Severity
  readonly status: AlertStatus
  readonly title: string
  readonly detail: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly openedAt: string | null
  readonly resolvedAt: string | null
  readonly lastNotifiedAt: string | null
  readonly notifyCount: number
  /** Channels that failed on the last send (no credentials, only the service's answer). */
  readonly deliveryErrors: readonly { readonly channel: string; readonly error: string }[]
}

export type AlertsResponse = {
  readonly status: "live" | "not-deployed" | "unavailable"
  readonly error?: string
  readonly channels: { readonly telegram: boolean; readonly slack: boolean }
  /** ARCOUSD_ALERT_* keys that are set but invalid (never their values). */
  readonly invalidSettings: readonly string[]
  readonly intervalMs: number
  readonly watcher: null | {
    readonly lastRunAt: string
    readonly lastOkAt: string | null
    readonly lastError: string | null
    /** No run for three intervals: the indexer worker (where the watcher runs) is probably down. */
    readonly stale: boolean
    /** The last round compared the queue with the chain at the indexer's block (null: not recorded). */
    readonly reconciled: boolean | null
  }
  /** OPEN first (critical before warning), then PENDING, then resolved in the last 24h. */
  readonly alerts: readonly AlertView[]
}

/** The queue keeper as the console sees it: its last heartbeat (keeper.ts KeeperReport) and liveness. */
export type KeeperResponse = {
  readonly status: "live" | "not-deployed" | "unavailable"
  readonly error?: string
  /** null: the keeper has never run (its worker is not set up, or never started). */
  readonly keeper: null | {
    readonly lastRunAt: string
    readonly lastOkAt: string | null
    readonly lastError: string | null
    /** No run for three of its intervals (at least five minutes) while dry-run or live. */
    readonly stale: boolean
    readonly report: Record<string, unknown> | null
  }
}

export type AlertTestResult =
  | { readonly ok: true; readonly delivery: Delivery }
  | { readonly ok: false; readonly status: number; readonly error: string }

export class ArcoUSDAlertsAdmin {
  private lastTestAt = 0

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly network: string
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly store: Pick<ArcoUSDAlertStore, "recent" | "heartbeat"> | null
      readonly env: ArcoUSDAlertEnv
      readonly channels: readonly AlertChannel[]
      readonly now?: () => number
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  async view(): Promise<AlertsResponse> {
    const base = {
      channels: { telegram: this.deps.env.telegram !== null, slack: this.deps.env.slack !== null },
      invalidSettings: this.deps.env.invalid,
      intervalMs: this.deps.env.intervalMs,
      watcher: null,
      alerts: [],
    }
    try {
      if (!deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)) return { ...base, status: "not-deployed" }
    } catch (error) {
      return { ...base, status: "unavailable", error: `ArcoUSD registry is invalid: ${errorText(error)}` }
    }
    if (!this.deps.store) return { ...base, status: "unavailable", error: "Alert store is not configured" }
    const now = this.now()
    try {
      const [rows, beat] = await Promise.all([
        this.deps.store.recent(this.deps.chainId, new Date(now - RESOLVED_WINDOW_MS)),
        this.deps.store.heartbeat(this.deps.chainId, WATCHER_HEARTBEAT),
      ])
      const order = (record: AlertRecord) =>
        record.status === "OPEN" ? (record.severity === "CRITICAL" ? 0 : 1) : record.status === "PENDING" ? 2 : 3
      const shown = rows
        .filter((record) => record.status !== "RESOLVED" || record.openedAt !== null) // a blip that never opened is noise
        .sort((a, b) => order(a) - order(b) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      return {
        ...base,
        status: "live",
        watcher: beat
          ? {
              lastRunAt: beat.lastRunAt.toISOString(),
              lastOkAt: beat.lastOkAt ? beat.lastOkAt.toISOString() : null,
              lastError: beat.lastError,
              stale: now - beat.lastRunAt.getTime() > 3 * this.deps.env.intervalMs,
              reconciled: reconciledOf(beat.data),
            }
          : null,
        alerts: shown.map(toView),
      }
    } catch (error) {
      return { ...base, status: "unavailable", error: `Alert read failed: ${safeErrorText(error)}` }
    }
  }

  async keeper(): Promise<KeeperResponse> {
    try {
      if (!deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)) return { status: "not-deployed", keeper: null }
    } catch (error) {
      return { status: "unavailable", error: `ArcoUSD registry is invalid: ${safeErrorText(error)}`, keeper: null }
    }
    if (!this.deps.store) return { status: "unavailable", error: "Alert store is not configured", keeper: null }
    try {
      const beat = await this.deps.store.heartbeat(this.deps.chainId, KEEPER_HEARTBEAT)
      if (!beat) return { status: "live", keeper: null }
      const report = beat.data && typeof beat.data === "object" && !Array.isArray(beat.data) ? (beat.data as Record<string, unknown>) : null
      const mode = report?.mode
      const interval = typeof report?.intervalMs === "number" && report.intervalMs > 0 ? report.intervalMs : 60_000
      return {
        status: "live",
        keeper: {
          lastRunAt: beat.lastRunAt.toISOString(),
          lastOkAt: beat.lastOkAt ? beat.lastOkAt.toISOString() : null,
          lastError: beat.lastError,
          stale: (mode === "dry-run" || mode === "live") && this.now() - beat.lastRunAt.getTime() > Math.max(5 * 60_000, 3 * interval),
          report,
        },
      }
    } catch (error) {
      return { status: "unavailable", error: `Keeper read failed: ${safeErrorText(error)}`, keeper: null }
    }
  }

  /** Sends a test message to every configured channel (at most one per 30 seconds). */
  async sendTest(operator: string | null): Promise<AlertTestResult> {
    if (!this.deps.channels.length) return { ok: false, status: 409, error: "No alert channel is configured (ARCOUSD_ALERT_TELEGRAM_* or ARCOUSD_ALERT_SLACK_WEBHOOK_URL)" }
    const now = this.now()
    if (now - this.lastTestAt < TEST_COOLDOWN_MS) return { ok: false, status: 429, error: "Wait 30 seconds between test alerts" }
    this.lastTestAt = now
    const text = formatTestMessage({ network: this.deps.network, operator, consoleUrl: this.deps.env.consoleUrl })
    return { ok: true, delivery: await deliver(this.deps.channels, text, () => this.now()) }
  }
}

/** For an app built without the alert service: answers not-deployed, sends nothing. */
export function inertArcoUSDAlerts(chainId: number): ArcoUSDAlertsAdmin {
  return new ArcoUSDAlertsAdmin({ chainId, network: "GIWA Sepolia", loadRegistry: () => null, store: null, env: parseArcoUSDAlertEnv({}), channels: [] })
}

function reconciledOf(data: unknown): boolean | null {
  const value = data && typeof data === "object" ? (data as { pinnedToIndexer?: unknown }).pinnedToIndexer : undefined
  return typeof value === "boolean" ? value : null
}

function toView(record: AlertRecord): AlertView {
  const iso = (date: Date | null) => (date ? date.toISOString() : null)
  return {
    key: record.key,
    severity: record.severity,
    status: record.status,
    title: record.title,
    detail: record.detail,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    openedAt: iso(record.openedAt),
    resolvedAt: iso(record.resolvedAt),
    lastNotifiedAt: iso(record.lastNotifiedAt),
    notifyCount: record.notifyCount,
    deliveryErrors: Object.entries(record.delivery ?? {})
      .filter(([, result]) => result && !result.ok)
      .map(([channel, result]) => ({ channel, error: result?.error ?? "failed" })),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
