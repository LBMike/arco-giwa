import { encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, type Address, type PublicClient } from "viem"
import { unsignedAdminTransaction, type UnsignedAdminTransaction } from "../evm/admin-transactions.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD } from "./registry.js"

// Admin reads over what the ArcoUSD indexer already records (docs/specs/arcousd-v1.md §5), plus
// the manual processQueue transaction builder. No chain writes: the operator signs in the
// console. Every response carries the deployment status:
//   not-deployed — no (deployed) ArcoUSD registry: empty data, nothing to act on;
//   unavailable  — the registry is present but invalid (`error`), or a read failed;
//   live         — data below.

export const STANDARD_TARGET_SECONDS = 2 * 24 * 60 * 60 // T+2 promise for the Standard queue
export const MAX_QUEUE_BATCH = 50
export const DEFAULT_QUEUE_BATCH = 20
const MAX_DAYS = 90
const DEFAULT_DAYS = 30
const MAX_CHART_POINTS = 360
const SNAPSHOT_ROWS_LIMIT = 30_000
const EVENT_ROWS_LIMIT = 20_000
const QUEUE_ROWS_LIMIT = 500
const QUEUE_SUMMARY_LIMIT = 10_000
const RECENT_EVENTS = 50
const DAY_MS = 24 * 60 * 60 * 1000

export const processQueueAbi = parseAbi(["function processQueue(address asset, uint256 maxCount) returns (uint256 paid)"])

export type AdminStatus = "not-deployed" | "live" | "unavailable"
export type RedeemStatus = "QUEUED" | "PAID" | "PAYOUT_FAILED" | "CANCELLED"
export const REDEEM_STATUSES: readonly RedeemStatus[] = ["QUEUED", "PAID", "PAYOUT_FAILED", "CANCELLED"]
/** QUEUED waits for liquidity; PAYOUT_FAILED waits for the owner to cancel. */
const OPEN_STATUSES: readonly RedeemStatus[] = ["QUEUED", "PAYOUT_FAILED"]

// ─────────────────────────────── store ───────────────────────────────

export type SnapshotRecord = {
  readonly takenAt: Date
  readonly blockNumber: bigint
  readonly totalBacking: string
  readonly totalLiabilities: string
  readonly navOk: boolean
  readonly mmfBps: number
  readonly paused: boolean
  readonly settlementPaused: boolean
}

export type RedeemRecord = {
  readonly requestId: string
  readonly owner: string
  readonly recipient: string
  readonly asset: string
  readonly arcoUSDAmount: string
  readonly assetAmount: string
  readonly status: string
  readonly requestedAt: Date
  readonly queuedTxHash: string
  readonly paidTxHash?: string | null
  readonly paidAt?: Date | null
  readonly failedTxHash?: string | null
  readonly failedAt?: Date | null
  readonly cancelledTxHash?: string | null
  readonly cancelledAt?: Date | null
}

export type EventRecord = {
  readonly contractAddress: string
  readonly blockNumber: bigint
  readonly txHash: string
  readonly logIndex: number
  readonly eventName: string
  readonly args: unknown
  readonly blockTimestamp: Date | null
}

export type ArcoUSDAdminStore = {
  /** NEWEST first (so a limit keeps the latest), scalar columns only (never the full `data` JSON). */
  snapshots(query: { chainId: number; reserveAddress: string; since: Date; limit: number }): Promise<readonly SnapshotRecord[]>
  /** `statuses` null = every status; `requestIds` narrows to those requests. */
  redeemRequests(query: {
    chainId: number
    reserveAddress: string
    statuses: readonly RedeemStatus[] | null
    requestIds?: readonly string[]
    order: "asc" | "desc"
    limit: number
  }): Promise<readonly RedeemRecord[]>
  /** Indexed events of these contracts at or after `since`, NEWEST first (a limit keeps the latest). */
  events(query: { chainId: number; contracts: readonly string[]; since: Date; limit: number }): Promise<readonly EventRecord[]>
}

/** eth_call of processQueue: how many requests it would pay right now. */
export type ProcessQueueSimulator = (input: {
  reserve: Address
  asset: Address
  maxCount: number
}) => Promise<{ paid: bigint; blockNumber: bigint }>

export function createProcessQueueSimulator(client: Pick<PublicClient, "simulateContract" | "getBlockNumber">): ProcessQueueSimulator {
  return async ({ reserve, asset, maxCount }) => {
    const blockNumber = await client.getBlockNumber()
    const { result } = await client.simulateContract({
      address: reserve,
      abi: processQueueAbi,
      functionName: "processQueue",
      args: [asset, BigInt(maxCount)],
      blockNumber,
    })
    return { paid: result as bigint, blockNumber }
  }
}

// ────────────────────────────── responses ──────────────────────────────

export type SnapshotPoint = {
  readonly takenAt: string
  readonly blockNumber: string
  readonly totalBackingUsd: string
  readonly totalLiabilitiesUsd: string
  /** backing − liabilities (negative when under-backed). */
  readonly surplusUsd: string
  readonly mmfBps: number
  readonly navOk: boolean
  readonly paused: boolean
  readonly settlementPaused: boolean
}

export type SnapshotsResponse = {
  readonly status: AdminStatus
  readonly error?: string
  readonly days: number
  /** Snapshots in the window (before sampling). */
  readonly total: number
  /** true when `points` keeps only the last snapshot of each of at most 360 equal buckets. */
  readonly sampled: boolean
  /** The read stopped at 30,000 rows: the oldest part of the window is missing (latest kept). */
  readonly truncated: boolean
  readonly points: readonly SnapshotPoint[]
}

export type QueueRow = {
  readonly requestId: string
  readonly owner: string
  readonly recipient: string
  readonly asset: string
  readonly symbol: string
  readonly decimals: number | null
  readonly status: string
  /** ArcoUSD escrowed (base18) and its human amount. */
  readonly arcoUSDAmount: string
  readonly arcoUSDAmountHuman: string
  /** Net payout in asset base units (after the swap fee) and its human amount. */
  readonly assetAmount: string
  readonly assetAmountHuman: string | null
  /** Swap fee kept by the Reserve on payout (escrow − payout, in USD); null for an unknown asset. */
  readonly feeUsd: string | null
  readonly requestedAt: string
  /** processQueue may pay it from this time (requestedAt + queueMinDelay). */
  readonly eligibleAt: string
  /** Open requests: time waited so far. Closed: time from request to payout/cancel/failure. */
  readonly waitSeconds: number
  /** QUEUED past the T+2 target. */
  readonly overdue: boolean
  readonly queuedTxHash: string
  readonly closedTxHash: string | null
  readonly closedAt: string | null
}

export type QueueAssetSummary = {
  readonly symbol: string
  readonly asset: string
  readonly decimals: number
  readonly queuedCount: number
  readonly queuedAmount: string
  readonly queuedAmountHuman: string
  readonly overdueCount: number
  readonly failedCount: number
  readonly oldestRequestedAt: string | null
  /** The next request processQueue will look at (oldest QUEUED). */
  readonly head: { readonly requestId: string; readonly assetAmount: string; readonly assetAmountHuman: string; readonly eligibleAt: string } | null
}

export type QueueFilter = "open" | "all" | RedeemStatus

export type QueueResponse = {
  readonly status: AdminStatus
  readonly error?: string
  readonly filter: QueueFilter
  readonly targetSeconds: number
  /** Seconds a request waits before processQueue may pay it: the live Reserve value when it
   *  could be read (`chain`), else the deploy-time registry value (`registry`). */
  readonly queueMinDelay: number
  readonly queueMinDelaySource: "chain" | "registry"
  readonly assets: readonly QueueAssetSummary[]
  readonly requests: readonly QueueRow[]
  /** The list stopped at 500 rows. */
  readonly truncated: boolean
  /** The per-asset summary stopped at 10,000 open requests per status. */
  readonly summaryTruncated: boolean
}

type FlowTotals = {
  readonly depositsUsd: string
  readonly instantRedemptionsUsd: string
  readonly queuedRedemptionsUsd: string
  readonly queuedPaidUsd: string
  readonly settlementsUsd: string
  readonly routerBuysUsd: string
  readonly feesUsd: string
  readonly deposits: number
  readonly instantRedemptions: number
  readonly queuedRedemptions: number
  readonly queuedPaid: number
  readonly settlements: number
  readonly routerBuys: number
}

export type FlowDay = FlowTotals & { readonly day: string }
export type FlowAsset = FlowTotals & { readonly symbol: string; readonly asset: string }

export type FlowEvent = {
  readonly eventName: string
  readonly contract: "reserve" | "router"
  readonly txHash: string
  readonly blockNumber: string
  readonly logIndex: number
  readonly at: string | null
  readonly symbol: string | null
  readonly account: string | null
  readonly amountUsd: string | null
  readonly feeUsd: string | null
}

export type FlowsResponse = {
  readonly status: AdminStatus
  readonly error?: string
  readonly days: number
  readonly since: string
  readonly totals: FlowTotals
  /** UTC days, oldest first, every day of the window (zeros included). */
  readonly daily: readonly FlowDay[]
  readonly byAsset: readonly FlowAsset[]
  /** Router buys by what the buyer paid with ("ArcoUSD" for ArcoUSD itself). */
  readonly routerBuysByPayAsset: readonly { readonly symbol: string; readonly count: number; readonly volumeUsd: string }[]
  readonly recent: readonly FlowEvent[]
  /** The event read stopped at the newest 20,000 rows: totals miss the oldest part of the window. */
  readonly truncated: boolean
  /** Events whose amount is in units of an asset the registry does not list (left unvalued). */
  readonly unknownAssetEvents: number
}

export type ProcessQueueResult =
  | {
      readonly ok: true
      readonly transaction: UnsignedAdminTransaction
      readonly symbol: string
      readonly maxCount: number
      /** eth_call of the same call: requests it would pay now, or why that could not be read. */
      readonly preview: { readonly paid: number; readonly blockNumber: string } | { readonly error: string }
    }
  | { readonly ok: false; readonly status: number; readonly error: string }

// ─────────────────────────────── service ───────────────────────────────

type Deployment = { readonly status: "live"; readonly deployment: DeployedArcoUSD } | { readonly status: "not-deployed" } | { readonly status: "unavailable"; readonly error: string }

type AssetInfo = { readonly symbol: string; readonly address: string; readonly decimals: number }

export class ArcoUSDAdmin {
  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly store: ArcoUSDAdminStore
      readonly simulateProcessQueue?: ProcessQueueSimulator
      /** Live Reserve.queueMinDelay (e.g. from the cached reserve read); null when unread. */
      readonly liveQueueMinDelay?: () => Promise<number | null>
      readonly now?: () => number
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private deployment(): Deployment {
    try {
      const deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
      return deployment ? { status: "live", deployment } : { status: "not-deployed" }
    } catch (error) {
      return { status: "unavailable", error: errorText(error) }
    }
  }

  async snapshots(daysInput?: unknown): Promise<SnapshotsResponse> {
    const days = parseDays(daysInput)
    const empty = { days, total: 0, sampled: false, truncated: false, points: [] }
    const current = this.deployment()
    if (current.status !== "live") return { ...empty, ...statusOf(current) }
    const { deployment } = current
    let newest: readonly SnapshotRecord[]
    try {
      newest = await this.deps.store.snapshots({
        chainId: this.deps.chainId,
        reserveAddress: deployment.reserveAddress.toLowerCase(),
        since: new Date(this.now() - days * DAY_MS),
        limit: SNAPSHOT_ROWS_LIMIT,
      })
    } catch (error) {
      return { ...empty, status: "unavailable", error: `Snapshot read failed: ${errorText(error)}` }
    }
    const rows = [...newest].reverse()
    const kept = sample(rows, MAX_CHART_POINTS)
    return {
      status: "live",
      days,
      total: rows.length,
      sampled: kept.length < rows.length,
      truncated: rows.length >= SNAPSHOT_ROWS_LIMIT,
      points: kept.map((row) => ({
        takenAt: row.takenAt.toISOString(),
        blockNumber: row.blockNumber.toString(),
        totalBackingUsd: usd(big(row.totalBacking)),
        totalLiabilitiesUsd: usd(big(row.totalLiabilities)),
        surplusUsd: usd(big(row.totalBacking) - big(row.totalLiabilities)),
        mmfBps: row.mmfBps,
        navOk: row.navOk,
        paused: row.paused,
        settlementPaused: row.settlementPaused,
      })),
    }
  }

  async queue(filterInput?: unknown): Promise<QueueResponse | { readonly status: 400; readonly error: string }> {
    const filter = parseQueueFilter(filterInput)
    if (filter === null) return { status: 400, error: `status must be open, all, or one of ${REDEEM_STATUSES.join(", ")}` }
    const current = this.deployment()
    const base = {
      filter,
      targetSeconds: STANDARD_TARGET_SECONDS,
      queueMinDelay: 0,
      queueMinDelaySource: "registry" as const,
      assets: [],
      requests: [],
      truncated: false,
      summaryTruncated: false,
    }
    if (current.status !== "live") return { ...base, ...statusOf(current) }
    const { deployment } = current
    let live: number | null = null
    try {
      live = this.deps.liveQueueMinDelay ? await this.deps.liveQueueMinDelay() : null
    } catch {
      live = null
    }
    const queueMinDelay = live ?? Number(deployment.params?.queueMinDelay ?? 0)
    const queueMinDelaySource = live === null ? ("registry" as const) : ("chain" as const)
    const assets = assetsOf(deployment)
    const now = this.now()
    const query = { chainId: this.deps.chainId, reserveAddress: deployment.reserveAddress.toLowerCase() }
    let queued: readonly RedeemRecord[]
    let failed: readonly RedeemRecord[]
    let listed: readonly RedeemRecord[]
    try {
      // The summary reads QUEUED and PAYOUT_FAILED apart from the 500-row list, so failed requests
      // nobody cancels can never crowd the queue out of it.
      ;[queued, failed] = await Promise.all([
        this.deps.store.redeemRequests({ ...query, statuses: ["QUEUED"], order: "asc", limit: QUEUE_SUMMARY_LIMIT }),
        this.deps.store.redeemRequests({ ...query, statuses: ["PAYOUT_FAILED"], order: "asc", limit: QUEUE_SUMMARY_LIMIT }),
      ])
      listed = await this.deps.store.redeemRequests({
        ...query,
        statuses: filter === "all" ? null : filter === "open" ? OPEN_STATUSES : [filter],
        order: filter === "open" ? "asc" : "desc",
        limit: QUEUE_ROWS_LIMIT,
      })
    } catch (error) {
      return { ...base, queueMinDelay, queueMinDelaySource, status: "unavailable", error: `Queue read failed: ${errorText(error)}` }
    }
    // The Reserve's queue order is request id order (ids only grow); requestedAt can tie in a block.
    queued = byRequestId(queued, "asc")
    listed = byRequestId(listed, filter === "open" ? "asc" : "desc")
    const rowOf = (record: RedeemRecord) => queueRow(record, assets, queueMinDelay, now)
    const summaries = [...assets.values()].map((asset) => {
      const mine = queued.filter((record) => sameAddress(record.asset, asset.address))
      const amount = mine.reduce((sum, record) => sum + big(record.assetAmount), 0n)
      const head = mine[0] // oldest first
      return {
        symbol: asset.symbol,
        asset: asset.address,
        decimals: asset.decimals,
        queuedCount: mine.length,
        queuedAmount: amount.toString(),
        queuedAmountHuman: formatUnits(amount, asset.decimals),
        overdueCount: mine.filter((record) => rowOf(record).overdue).length,
        failedCount: failed.filter((record) => sameAddress(record.asset, asset.address)).length,
        oldestRequestedAt: head ? head.requestedAt.toISOString() : null,
        head: head
          ? {
              requestId: head.requestId,
              assetAmount: head.assetAmount,
              assetAmountHuman: formatUnits(big(head.assetAmount), asset.decimals),
              eligibleAt: new Date(head.requestedAt.getTime() + queueMinDelay * 1000).toISOString(),
            }
          : null,
      }
    })
    return {
      status: "live",
      filter,
      targetSeconds: STANDARD_TARGET_SECONDS,
      queueMinDelay,
      queueMinDelaySource,
      assets: summaries,
      requests: listed.map(rowOf),
      truncated: listed.length >= QUEUE_ROWS_LIMIT,
      summaryTruncated: queued.length >= QUEUE_SUMMARY_LIMIT || failed.length >= QUEUE_SUMMARY_LIMIT,
    }
  }

  async flows(daysInput?: unknown): Promise<FlowsResponse> {
    const days = parseDays(daysInput)
    const now = this.now()
    const since = startOfUtcDay(now - (days - 1) * DAY_MS)
    const base = {
      days,
      since: since.toISOString(),
      totals: totalsOf(newBucket()),
      daily: [],
      byAsset: [],
      routerBuysByPayAsset: [],
      recent: [],
      truncated: false,
      unknownAssetEvents: 0,
    }
    const current = this.deployment()
    if (current.status !== "live") return { ...base, ...statusOf(current) }
    const { deployment } = current
    const reserve = deployment.reserveAddress.toLowerCase()
    const router = deployment.routerAddress?.toLowerCase() ?? null
    const assets = assetsOf(deployment)
    let newest: readonly EventRecord[]
    let paidRequests: Map<string, RedeemRecord>
    try {
      newest = await this.deps.store.events({
        chainId: this.deps.chainId,
        contracts: router ? [reserve, router] : [reserve],
        since,
        limit: EVENT_ROWS_LIMIT,
      })
      // The queued part's swap fee is kept when it is paid: escrow (from the request) − payout.
      const paidIds = newest.filter((event) => event.eventName === "RedeemPaid").map((event) => String(argsOf(event).requestId ?? ""))
      const records = paidIds.length
        ? await this.deps.store.redeemRequests({
            chainId: this.deps.chainId,
            reserveAddress: reserve,
            statuses: null,
            requestIds: [...new Set(paidIds)],
            order: "asc",
            limit: paidIds.length,
          })
        : []
      paidRequests = new Map(records.map((record) => [record.requestId, record]))
    } catch (error) {
      return { ...base, status: "unavailable", error: `Event read failed: ${errorText(error)}` }
    }
    const events = [...newest].reverse() // chain order

    const total = newBucket()
    const daily = new Map<string, Bucket>()
    for (let at = since.getTime(); at <= now; at += DAY_MS) daily.set(dayKey(at), newBucket())
    const byAsset = new Map<string, Bucket>()
    const buysByPay = new Map<string, { count: number; volume: bigint }>()
    const recent: FlowEvent[] = []
    let unknownAssetEvents = 0

    for (const event of events) {
      const args = argsOf(event)
      const fromReserve = event.contractAddress.toLowerCase() === reserve
      const valued = fromReserve ? reserveFlow(event.eventName, args, assets, paidRequests) : routerFlow(event.eventName, args)
      if (valued.unknownAsset) unknownAssetEvents++
      const at = event.blockTimestamp
      recent.push({
        eventName: event.eventName,
        contract: fromReserve ? "reserve" : "router",
        txHash: event.txHash,
        blockNumber: event.blockNumber.toString(),
        logIndex: event.logIndex,
        at: at ? at.toISOString() : null,
        symbol: valued.asset ? (assets.get(valued.asset)?.symbol ?? valued.asset) : null,
        account: valued.account,
        amountUsd: valued.amount === null ? null : usd(valued.amount),
        feeUsd: valued.fee === null ? null : usd(valued.fee),
      })
      if (!valued.kind) continue
      const targets = [total]
      const day = at ? daily.get(dayKey(at.getTime())) : undefined
      if (day) targets.push(day)
      if (valued.asset) {
        if (!byAsset.has(valued.asset)) byAsset.set(valued.asset, newBucket())
        targets.push(byAsset.get(valued.asset)!)
      }
      for (const bucket of targets) add(bucket, valued.kind, valued.amount ?? 0n, valued.fee ?? 0n)
      if (valued.kind === "routerBuys") {
        const pay = String(args.payAsset ?? "").toLowerCase()
        const symbol = pay === deployment.arcoUSDAddress.toLowerCase() ? "ArcoUSD" : (assets.get(pay)?.symbol ?? pay)
        const entry = buysByPay.get(symbol) ?? { count: 0, volume: 0n }
        entry.count++
        entry.volume += valued.amount ?? 0n
        buysByPay.set(symbol, entry)
      }
    }

    return {
      status: "live",
      days,
      since: since.toISOString(),
      totals: totalsOf(total),
      daily: [...daily.entries()].map(([day, bucket]) => ({ day, ...totalsOf(bucket) })),
      byAsset: [...byAsset.entries()].map(([address, bucket]) => ({
        symbol: assets.get(address)?.symbol ?? address,
        asset: address,
        ...totalsOf(bucket),
      })),
      routerBuysByPayAsset: [...buysByPay.entries()].map(([symbol, entry]) => ({ symbol, count: entry.count, volumeUsd: usd(entry.volume) })),
      recent: recent.slice(-RECENT_EVENTS).reverse(),
      truncated: newest.length >= EVENT_ROWS_LIMIT,
      unknownAssetEvents,
    }
  }

  /** Unsigned Reserve.processQueue(asset, maxCount) for the operator's wallet, with a dry-run count. */
  async processQueueTransaction(input: { asset?: unknown; maxCount?: unknown }): Promise<ProcessQueueResult> {
    const current = this.deployment()
    if (current.status === "not-deployed") return { ok: false, status: 409, error: "ArcoUSD is not deployed" }
    if (current.status === "unavailable") return { ok: false, status: 503, error: `ArcoUSD registry is invalid: ${current.error}` }
    const { deployment } = current
    const raw = input.maxCount
    const maxCount =
      raw === undefined || raw === null || raw === ""
        ? DEFAULT_QUEUE_BATCH
        : typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))
          ? Number(raw)
          : Number.NaN
    if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > MAX_QUEUE_BATCH) {
      return { ok: false, status: 400, error: `maxCount must be an integer in 1..${MAX_QUEUE_BATCH}` }
    }
    const wanted = typeof input.asset === "string" ? input.asset.trim() : ""
    const asset = [...assetsOf(deployment).values()].find(
      (candidate) => candidate.symbol === wanted || (isAddress(wanted) && sameAddress(candidate.address, wanted)),
    )
    if (!asset) return { ok: false, status: 400, error: "asset must be a Reserve asset symbol or address from the ArcoUSD registry" }
    const reserve = getAddress(deployment.reserveAddress) as Address
    const assetAddress = getAddress(asset.address) as Address
    let preview: { paid: number; blockNumber: string } | { error: string }
    if (!this.deps.simulateProcessQueue) {
      preview = { error: "Simulation unavailable" }
    } else {
      try {
        const simulated = await this.deps.simulateProcessQueue({ reserve, asset: assetAddress, maxCount })
        preview = { paid: Number(simulated.paid), blockNumber: simulated.blockNumber.toString() }
      } catch (error) {
        preview = { error: `processQueue would revert or could not be simulated: ${errorText(error)}` }
      }
    }
    const transaction = unsignedAdminTransaction(
      deployment.chainId,
      reserve,
      encodeFunctionData({ abi: processQueueAbi, functionName: "processQueue", args: [assetAddress, BigInt(maxCount)] }),
      `ArcoUSD Reserve: pay up to ${maxCount} queued ${asset.symbol} redemptions in order (processQueue)`,
    )
    return {
      ok: true,
      symbol: asset.symbol,
      maxCount,
      preview,
      // The server did run it (eth_call): say so instead of the builder's default "not-run".
      transaction: {
        ...transaction,
        simulation:
          "paid" in preview
            ? { status: "simulated", reason: `eth_call at block ${preview.blockNumber}: pays ${preview.paid} request(s)` }
            : { status: "failed", reason: preview.error },
      },
    }
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

type FlowKind = "deposits" | "instantRedemptions" | "queuedRedemptions" | "queuedPaid" | "settlements" | "routerBuys"

type Bucket = { [K in FlowKind]: { amount: bigint; count: number } } & { fees: bigint }

type Valued = {
  readonly kind: FlowKind | null
  /** base18 USD (ArcoUSD) */
  readonly amount: bigint | null
  readonly fee: bigint | null
  readonly asset: string | null
  readonly account: string | null
  readonly unknownAsset: boolean
}

const KINDS: readonly FlowKind[] = ["deposits", "instantRedemptions", "queuedRedemptions", "queuedPaid", "settlements", "routerBuys"]

function newBucket(): Bucket {
  const bucket = { fees: 0n } as Bucket
  for (const kind of KINDS) bucket[kind] = { amount: 0n, count: 0 }
  return bucket
}

function add(bucket: Bucket, kind: FlowKind, amount: bigint, fee: bigint) {
  bucket[kind].amount += amount
  bucket[kind].count++
  bucket.fees += fee
}

function totalsOf(bucket: Bucket): FlowTotals {
  return {
    depositsUsd: usd(bucket.deposits.amount),
    instantRedemptionsUsd: usd(bucket.instantRedemptions.amount),
    queuedRedemptionsUsd: usd(bucket.queuedRedemptions.amount),
    queuedPaidUsd: usd(bucket.queuedPaid.amount),
    settlementsUsd: usd(bucket.settlements.amount),
    routerBuysUsd: usd(bucket.routerBuys.amount),
    feesUsd: usd(bucket.fees),
    deposits: bucket.deposits.count,
    instantRedemptions: bucket.instantRedemptions.count,
    queuedRedemptions: bucket.queuedRedemptions.count,
    queuedPaid: bucket.queuedPaid.count,
    settlements: bucket.settlements.count,
    routerBuys: bucket.routerBuys.count,
  }
}

/**
 * USD (base18) for each Reserve event:
 *   Deposited       gross = arcoUSDOut + fee (fee is ArcoUSD, base18);
 *   RedeemedInstant arcoUSDIn burned; fee is in asset units (Instant + swap);
 *   RedeemQueued    arcoUSDIn escrowed (fee counted when paid);
 *   RedeemPaid      payout (asset units); fee = the request's escrow − payout;
 *   SettledFor      arcoUSDIn (product purchases).
 * Other events (cancel, failure, MMF moves, config) are listed but not summed.
 */
function reserveFlow(eventName: string, args: Record<string, unknown>, assets: Map<string, AssetInfo>, paid: Map<string, RedeemRecord>): Valued {
  const asset = typeof args.asset === "string" ? args.asset.toLowerCase() : null
  const info = asset ? assets.get(asset) : undefined
  const toUsd = (units: bigint) => (info ? units * 10n ** BigInt(18 - info.decimals) : null)
  const none = { kind: null, amount: null, fee: null, asset, account: null, unknownAsset: false } as const
  switch (eventName) {
    case "Deposited": {
      const out = big(args.arcoUSDOut)
      const fee = big(args.fee)
      return { kind: "deposits", amount: out + fee, fee, asset, account: str(args.recipient), unknownAsset: false }
    }
    case "RedeemedInstant": {
      const fee = toUsd(big(args.fee))
      return { kind: "instantRedemptions", amount: big(args.arcoUSDIn), fee, asset, account: str(args.sender), unknownAsset: !info }
    }
    case "RedeemQueued":
      return { kind: "queuedRedemptions", amount: big(args.arcoUSDIn), fee: 0n, asset, account: str(args.owner), unknownAsset: false }
    case "RedeemPaid": {
      const payout = toUsd(big(args.assetOut))
      const request = paid.get(String(args.requestId ?? ""))
      const fee = payout !== null && request ? big(request.arcoUSDAmount) - payout : null
      return {
        kind: payout === null ? null : "queuedPaid",
        amount: payout,
        fee: fee !== null && fee > 0n ? fee : fee === null ? null : 0n,
        asset,
        account: str(args.recipient),
        unknownAsset: !info,
      }
    }
    case "SettledFor":
      return { kind: "settlements", amount: big(args.arcoUSDIn), fee: null, asset, account: str(args.to), unknownAsset: false }
    case "RedeemCancelled":
      return { ...none, amount: big(args.arcoUSDReturned), account: str(args.owner) }
    case "RedeemPayoutFailed":
      return { ...none, amount: toUsd(big(args.assetOut)), account: str(args.recipient), unknownAsset: !info }
    default:
      return none
  }
}

function routerFlow(eventName: string, args: Record<string, unknown>): Valued {
  if (eventName !== "Bought") return { kind: null, amount: null, fee: null, asset: null, account: null, unknownAsset: false }
  // The settlement itself is the Reserve's SettledFor; this records the buy (volume in ArcoUSD).
  return { kind: "routerBuys", amount: big(args.arcoUSDSettled), fee: null, asset: null, account: str(args.recipient), unknownAsset: false }
}

function queueRow(record: RedeemRecord, assets: Map<string, AssetInfo>, queueMinDelay: number, now: number): QueueRow {
  const info = assets.get(record.asset.toLowerCase())
  const requested = record.requestedAt.getTime()
  const closedAt = record.paidAt ?? record.cancelledAt ?? record.failedAt ?? null
  const closedTxHash = record.paidTxHash ?? record.cancelledTxHash ?? record.failedTxHash ?? null
  const open = record.status === "QUEUED" || record.status === "PAYOUT_FAILED"
  const waitEnd = open || !closedAt ? now : closedAt.getTime()
  const waitSeconds = Math.max(0, Math.floor((waitEnd - requested) / 1000))
  const payout = big(record.assetAmount)
  const fee = info ? big(record.arcoUSDAmount) - payout * 10n ** BigInt(18 - info.decimals) : null
  return {
    requestId: record.requestId,
    owner: record.owner.toLowerCase(),
    recipient: record.recipient.toLowerCase(),
    asset: record.asset.toLowerCase(),
    symbol: info?.symbol ?? record.asset.toLowerCase(),
    decimals: info?.decimals ?? null,
    status: record.status,
    arcoUSDAmount: record.arcoUSDAmount,
    arcoUSDAmountHuman: formatUnits(big(record.arcoUSDAmount), 18),
    assetAmount: record.assetAmount,
    assetAmountHuman: info ? formatUnits(payout, info.decimals) : null,
    feeUsd: fee === null ? null : usd(fee > 0n ? fee : 0n),
    requestedAt: record.requestedAt.toISOString(),
    eligibleAt: new Date(requested + queueMinDelay * 1000).toISOString(),
    waitSeconds,
    overdue: record.status === "QUEUED" && waitSeconds > STANDARD_TARGET_SECONDS,
    queuedTxHash: record.queuedTxHash,
    closedTxHash: open && record.status === "QUEUED" ? null : closedTxHash,
    closedAt: open && record.status === "QUEUED" ? null : closedAt ? closedAt.toISOString() : null,
  }
}

function assetsOf(deployment: DeployedArcoUSD): Map<string, AssetInfo> {
  const map = new Map<string, AssetInfo>()
  for (const asset of deployment.reserveAssets ?? []) {
    if (!asset.address) continue
    map.set(asset.address.toLowerCase(), { symbol: asset.symbol, address: asset.address.toLowerCase(), decimals: asset.decimals })
  }
  return map
}

function statusOf(current: Exclude<Deployment, { status: "live" }>): { status: AdminStatus; error?: string } {
  return current.status === "unavailable" ? { status: "unavailable", error: current.error } : { status: "not-deployed" }
}

function parseDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_DAYS
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : DEFAULT_DAYS
}

function parseQueueFilter(value: unknown): QueueFilter | null {
  if (value === undefined || value === null || value === "") return "open"
  if (value === "open" || value === "all") return value
  return (REDEEM_STATUSES as readonly string[]).includes(String(value)) ? (value as RedeemStatus) : null
}

/** Keeps the last row of each of at most `max` equal buckets (the latest snapshot always stays). */
function sample<T>(rows: readonly T[], max: number): readonly T[] {
  if (rows.length <= max) return rows
  const size = Math.ceil(rows.length / max)
  const kept: T[] = []
  for (let end = rows.length; end > 0; end -= size) kept.push(rows[end - 1])
  return kept.reverse()
}

function byRequestId(rows: readonly RedeemRecord[], order: "asc" | "desc"): RedeemRecord[] {
  const sign = order === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = big(a.requestId)
    const right = big(b.requestId)
    return left === right ? 0 : left < right ? -sign : sign
  })
}

function argsOf(event: EventRecord): Record<string, unknown> {
  return event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {}
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value)
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null
}

function usd(base18: bigint): string {
  return formatUnits(base18, 18)
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function startOfUtcDay(ms: number): Date {
  return new Date(`${dayKey(ms)}T00:00:00.000Z`)
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─────────────────────────────── Prisma ───────────────────────────────

export type PrismaArcoUSDAdminDelegates = {
  arcoUSDReserveSnapshot: { findMany(args: unknown): Promise<unknown[]> }
  arcoUSDRedeemRequest: { findMany(args: unknown): Promise<unknown[]> }
  evmIndexedEvent: { findMany(args: unknown): Promise<unknown[]> }
}

/** Reads only; the ArcoUSD indexer (store.ts) is the writer. */
export class PrismaArcoUSDAdminStore implements ArcoUSDAdminStore {
  constructor(private readonly prisma: PrismaArcoUSDAdminDelegates) {}

  async snapshots(query: { chainId: number; reserveAddress: string; since: Date; limit: number }) {
    return (await this.prisma.arcoUSDReserveSnapshot.findMany({
      where: { chainId: query.chainId, reserveAddress: query.reserveAddress.toLowerCase(), takenAt: { gte: query.since } },
      orderBy: { takenAt: "desc" },
      take: query.limit,
      select: {
        takenAt: true,
        blockNumber: true,
        totalBacking: true,
        totalLiabilities: true,
        navOk: true,
        mmfBps: true,
        paused: true,
        settlementPaused: true,
      },
    })) as SnapshotRecord[]
  }

  async redeemRequests(query: Parameters<ArcoUSDAdminStore["redeemRequests"]>[0]) {
    return (await this.prisma.arcoUSDRedeemRequest.findMany({
      where: {
        chainId: query.chainId,
        reserveAddress: query.reserveAddress.toLowerCase(),
        ...(query.statuses ? { status: { in: [...query.statuses] } } : {}),
        ...(query.requestIds ? { requestId: { in: [...query.requestIds] } } : {}),
      },
      orderBy: [{ requestedAt: query.order }, { queuedBlock: query.order }],
      take: query.limit,
    })) as RedeemRecord[]
  }

  async events(query: { chainId: number; contracts: readonly string[]; since: Date; limit: number }) {
    return (await this.prisma.evmIndexedEvent.findMany({
      where: {
        chainId: query.chainId,
        contractAddress: { in: query.contracts.map((address) => address.toLowerCase()) },
        removed: false,
        blockTimestamp: { gte: query.since },
      },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      take: query.limit,
      select: { contractAddress: true, blockNumber: true, txHash: true, logIndex: true, eventName: true, args: true, blockTimestamp: true },
    })) as EventRecord[]
  }
}

/** For an app built without the ArcoUSD admin service: every view answers not-deployed with its full shape. */
export function inertArcoUSDAdmin(chainId: number): ArcoUSDAdmin {
  const never = async (): Promise<never> => {
    throw new Error("ArcoUSD admin store is not configured")
  }
  return new ArcoUSDAdmin({ chainId, loadRegistry: () => null, store: { snapshots: never, redeemRequests: never, events: never } })
}
