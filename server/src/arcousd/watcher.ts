import type { ArcoUSDAlertEnv } from "./alert-config.js"
import type { ArcoUSDAdmin, QueueAssetSummary } from "./admin.js"
import { applyDelivery, formatDigest, stepAlerts, WATCHER_HEARTBEAT, type ArcoUSDAlertStore } from "./alerts.js"
import type { ArcoUSDEnv } from "./config.js"
import { deliver, type AlertChannel, type Delivery } from "./notify.js"
import type { ArcoUSDChainReader, ReserveState } from "./reader.js"
import type { RecallsSnapshot, RecallView } from "./recall.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD } from "./registry.js"
import { safeErrorText } from "./safe-error.js"
import { evaluateBuyGate } from "./service.js"
import { evaluateWatch, payoutsPaused, type Finding } from "./watch.js"

// The ArcoUSD watcher (docs/operations/arcousd-alerts.md). Runs inside the indexer worker, after the
// ArcoUSD indexer's poll, once per ARCOUSD_ALERT_INTERVAL_MS. Each round:
//   1. reads the Reserve AT THE INDEXER'S LAST BLOCK when the indexer is close to the head and its
//      poll just completed, so the chain and the indexed queue describe the same moment (else at the
//      head, and the queue is not reconciled this round);
//   2. reads the indexed queue, the last snapshot time and the Reserve recalls;
//   3. evaluates the rules (watch.ts), steps the alert book (alerts.ts), sends one digest to every
//      configured channel, saves the rows and a heartbeat.
// What a round could not read keeps its alerts as they were (never "resolved" by a failed read), and
// every error text that leaves the process goes through safeErrorText (RPC URLs carry API keys).
// Read-only towards the chain: it never signs or sends a transaction.

/** Beyond this many blocks behind the head the indexer's block may be pruned from the RPC node. */
export const RECONCILE_MAX_LAG = 64n

export type WatcherRound =
  | { readonly mode: "inert"; readonly reason: string }
  | { readonly mode: "not-due" }
  /** A round is still running (it outlived the caller's budget); `sinceMs` since it started. */
  | { readonly mode: "busy"; readonly sinceMs: number }
  | {
      readonly mode: "run"
      readonly findings: number
      readonly open: number
      readonly notices: number
      readonly pinnedToIndexer: boolean
      readonly delivery: Delivery | null
    }

export type ArcoUSDWatcherDeps = {
  readonly chainId: number
  readonly network: string
  readonly env: ArcoUSDEnv
  readonly alertEnv: ArcoUSDAlertEnv
  readonly loadRegistry: () => ArcoUSDRegistryFile | null
  readonly readState: ArcoUSDChainReader
  readonly latestBlock: () => Promise<bigint>
  /** The ArcoUSD indexer's cursor (last fully indexed block), null before its first poll. */
  readonly indexedBlock: () => Promise<bigint | null>
  /** The indexed Standard queue; its queueMinDelay must come from `liveQueueMinDelay`. */
  readonly admin: Pick<ArcoUSDAdmin, "queue">
  readonly lastSnapshotAt: (deployment: DeployedArcoUSD) => Promise<Date | null>
  readonly recalls?: () => Promise<RecallsSnapshot>
  readonly store: ArcoUSDAlertStore
  readonly channels: readonly AlertChannel[]
  readonly now?: () => number
  readonly log?: (line: Record<string, unknown>) => void
}

export type RoundContext = {
  /** The ArcoUSD indexer's poll in this loop iteration finished (its cursor matches its rows). */
  readonly indexerPollOk?: boolean
  /** Counts ArcoUSD polls as they START: a change during the round means one wrote rows meanwhile. */
  readonly pollSeq?: () => number
}

type KeyTest = (key: string) => boolean
type Observation = { findings: Finding[]; pinned: boolean; unknown: KeyTest[]; quiet: KeyTest[] }

export class ArcoUSDWatcher {
  private nextRunAt = 0
  private runningSince: number | null = null
  private lastRoundAt: Date | null = null
  private state: ReserveState | null = null

  constructor(private readonly deps: ArcoUSDWatcherDeps) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** queueMinDelay for the admin queue reader: this round's chain value. */
  liveQueueMinDelay = async (): Promise<number | null> => this.state?.queueMinDelay ?? null

  /** Runs when due; a round still going (the caller stopped waiting for it) is never doubled up. */
  async maybeRun(context: RoundContext = {}): Promise<WatcherRound> {
    if (this.runningSince !== null) return { mode: "busy", sinceMs: this.now() - this.runningSince }
    if (this.now() < this.nextRunAt) return { mode: "not-due" }
    this.nextRunAt = this.now() + this.deps.alertEnv.intervalMs
    return this.runOnce(context)
  }

  async runOnce(context: RoundContext = {}): Promise<WatcherRound> {
    this.runningSince = this.now()
    try {
      return await this.round(context)
    } finally {
      this.runningSince = null
    }
  }

  private async round(context: RoundContext): Promise<WatcherRound> {
    const now = new Date(this.now())
    let deployment: DeployedArcoUSD | null = null
    let registryError: string | null = null
    try {
      deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
    } catch (error) {
      registryError = safeErrorText(error)
    }
    if (!deployment && !registryError) return { mode: "inert", reason: "ArcoUSD registry missing or not deployed" }

    try {
      const observed: Observation = deployment
        ? await this.observe(deployment, now, context)
        : {
            findings: evaluateWatch({ ...EMPTY_INPUT, now: now.getTime(), registryError }),
            pinned: false,
            unknown: [(key) => key !== "registry:invalid"],
            quiet: [],
          }
      const active = await this.deps.store.active(this.deps.chainId, now)
      const { records, notices } = stepAlerts({
        active,
        findings: observed.findings,
        now,
        repeatCriticalMs: this.deps.alertEnv.repeatCriticalMs,
        repeatWarningMs: this.deps.alertEnv.repeatWarningMs,
        notify: this.deps.channels.length > 0,
        unknown: (key) => observed.unknown.some((test) => test(key)),
        quiet: (key) => observed.quiet.some((test) => test(key)),
        // A waiting condition the previous round did not see starts its clock again, and so does one
        // unseen for a few intervals (after a restart, or failed rounds in between).
        previousRoundAt: this.lastRoundAt,
        maxGapMs: Math.max(5 * 60_000, 3 * this.deps.alertEnv.intervalMs),
      })
      let delivery: Delivery | null = null
      if (notices.length) {
        const text = formatDigest(notices, { network: this.deps.network, consoleUrl: this.deps.alertEnv.consoleUrl, now })
        delivery = await deliver(this.deps.channels, text, () => this.now())
        applyDelivery(notices, delivery, now)
      }
      for (const record of records) {
        if (record.status === "OPEN" && record.openedAt?.getTime() === now.getTime()) {
          this.log({ mode: "alert-open", key: record.key, severity: record.severity, title: record.title })
        }
        await this.deps.store.save(this.deps.chainId, record)
      }
      this.lastRoundAt = now
      const open = records.filter((record) => record.status === "OPEN").length
      await this.deps.store.beat(this.deps.chainId, WATCHER_HEARTBEAT, {
        at: now,
        ok: true,
        data: { findings: observed.findings.length, open, notices: notices.length, pinnedToIndexer: observed.pinned, delivery },
      })
      return { mode: "run", findings: observed.findings.length, open, notices: notices.length, pinnedToIndexer: observed.pinned, delivery }
    } catch (error) {
      // Keep the failure visible in the console; the caller logs it. Never stops the indexer.
      await this.deps.store.beat(this.deps.chainId, WATCHER_HEARTBEAT, { at: now, ok: false, error: safeErrorText(error) }).catch(() => undefined)
      throw error
    }
  }

  private async observe(deployment: DeployedArcoUSD, now: Date, context: RoundContext): Promise<Observation> {
    // Chain head and indexer cursor. Either failing is a reading of its own (an RPC or DB outage),
    // not a reason to skip the round: the rules then see "unreadable" and say so.
    let latest: bigint | null = null
    let latestError: string | null = null
    try {
      latest = await this.deps.latestBlock()
    } catch (error) {
      latestError = safeErrorText(error)
    }
    let indexed: bigint | null = null
    let cursorRead = true
    try {
      indexed = await this.deps.indexedBlock()
    } catch {
      cursorRead = false
    }
    // No cursor yet: measure from the deployment block (an indexer that never started is behind too).
    const indexedOrStart = indexed ?? BigInt(deployment.deploymentBlock) - 1n
    const lagBlocks = latest === null || !cursorRead ? null : Number(latest > indexedOrStart ? latest - indexedOrStart : 0n)
    const pinAt = latest !== null && indexed !== null && latest - indexed <= RECONCILE_MAX_LAG && context.indexerPollOk !== false ? indexed : null

    const pollSeqAtStart = context.pollSeq?.() ?? null
    let state: ReserveState | null = null
    let stateError: string | null = latestError
    let pinned = false
    if (latestError === null) {
      if (pinAt !== null) {
        try {
          state = await this.deps.readState(deployment, pinAt)
          pinned = true
        } catch {
          // The node may not serve that block's state: fall back to the head, without reconciling.
        }
      }
      if (!state) {
        try {
          state = await this.deps.readState(deployment)
        } catch (error) {
          stateError = safeErrorText(error)
        }
      }
    }
    this.state = state

    let queue: readonly QueueAssetSummary[] | null = null
    let queueTruncated = false
    let queueError: string | null = null
    try {
      const reply = await this.deps.admin.queue("open")
      if ("assets" in reply && reply.status === "live") {
        queue = reply.assets
        queueTruncated = reply.summaryTruncated
      } else {
        queueError = "error" in reply && reply.error ? safeErrorText(String(reply.error)) : "queue unavailable"
      }
    } catch (error) {
      queueError = safeErrorText(error)
    }
    // The queue rows must still be those of the pinned block: if the indexer moved on meanwhile (a
    // round that outlived its budget overlaps the next poll), this round does not reconcile.
    if (pinned) {
      const after = await this.deps.indexedBlock().catch(() => null)
      // A poll that started meanwhile may have written rows without moving its cursor yet.
      if (after !== indexed || (pollSeqAtStart !== null && context.pollSeq?.() !== pollSeqAtStart)) pinned = false
    }

    let lastSnapshotAt: Date | null = null
    let snapshotRead = true
    try {
      lastSnapshotAt = await this.deps.lastSnapshotAt(deployment)
    } catch {
      snapshotRead = false
    }

    let recalls: RecallView[] | null = null
    if (this.deps.recalls) {
      try {
        const snapshot = await this.deps.recalls()
        if (snapshot.status === "live") recalls = [...snapshot.recalls]
        else if ("error" in snapshot && snapshot.error) this.log({ mode: "recalls-unavailable", error: safeErrorText(snapshot.error) })
      } catch (error) {
        this.log({ mode: "recalls-unavailable", error: safeErrorText(error) })
      }
    }
    // A recall whose own chain read failed is unknown this round, not settled.
    const unreadRecalls = (recalls ?? []).filter((recall) => recall.error || recall.state === "unknown")
    const readRecalls = recalls ? recalls.filter((recall) => !unreadRecalls.includes(recall)) : null

    const findings = evaluateWatch({
      now: now.getTime(),
      stalledMs: this.deps.alertEnv.stalledMs,
      indexerLagBlocks: this.deps.alertEnv.indexerLagBlocks,
      snapshotIntervalMs: this.deps.env.snapshotIntervalMs,
      state,
      stateError,
      gate: state ? evaluateBuyGate(this.deps.env, state, now.toISOString()) : null,
      pinnedToIndexer: pinned,
      queue,
      queueTruncated,
      queueError,
      indexer: lagBlocks === null ? null : { lagBlocks },
      lastSnapshotAt,
      recalls: readRecalls,
    })

    // What this round could not see keeps its alerts as they were (stepAlerts `unknown`).
    const unknown: KeyTest[] = []
    const matches = (pattern: RegExp): KeyTest => (key) => pattern.test(key)
    if (!state) unknown.push(matches(/^reserve:(?!read-failed$)/), matches(/^gate:/), matches(/^pauses$/), matches(/^queue:[^:]+:(stalled|liquidity)$/))
    // With the NAV down the MMF counts as 0: backing and the MMF share say nothing this round.
    if (state && !state.navOk) unknown.push(matches(/^reserve:(under-backed|mmf-band)$/))
    // While payouts are paused, "not processed" / "short" are not evaluated; they are not cleared either.
    if (state && payoutsPaused(state)) unknown.push(matches(/^queue:[^:]+:(stalled|liquidity)$/))
    if (!pinned || !queue || queueTruncated) unknown.push(matches(/^reconcile:/))
    if (!queue) unknown.push(matches(/^queue:(?!read-failed$)/))
    if (recalls === null) unknown.push(matches(/^recall:/))
    for (const recall of unreadRecalls) {
      const prefix = `recall:${recall.productId}:${recall.requestId}:`
      unknown.push((key) => key.startsWith(prefix))
    }
    if (!snapshotRead || lastSnapshotAt === null) unknown.push(matches(/^indexer:snapshots$/))
    if (lagBlocks === null) unknown.push(matches(/^indexer:lag$/))

    // "Close to T+2" that became "past T+2" is replaced, not resolved.
    const quiet: KeyTest[] = []
    for (const summary of queue ?? []) {
      if (summary.overdueCount > 0) {
        const key = `queue:${summary.symbol}:aging`
        quiet.push((candidate) => candidate === key)
      }
    }
    return { findings, pinned, unknown, quiet }
  }

  private log(line: Record<string, unknown>) {
    ;(this.deps.log ?? defaultLog)({ service: "arco-arcousd-watcher", ...line })
  }
}

const EMPTY_INPUT = {
  stalledMs: 0,
  indexerLagBlocks: 0,
  snapshotIntervalMs: 0,
  state: null,
  pinnedToIndexer: false,
  queue: null,
  indexer: null,
  lastSnapshotAt: null,
  recalls: null,
} as const

function defaultLog(line: Record<string, unknown>) {
  console.log(JSON.stringify(line))
}
