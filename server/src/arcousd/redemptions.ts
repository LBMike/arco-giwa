import { formatUnits, getAddress, isAddress } from "viem"
import { STANDARD_TARGET_SECONDS, type RedeemRecord } from "./admin.js"
import type { RedeemStatus } from "./indexer.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD } from "./registry.js"
import { safeErrorText } from "./safe-error.js"

// One wallet's Standard redemptions (docs/specs/arcousd-v1.md §5, 4c backend): public, read-only,
// from the ArcoUSD indexer's ArcoUSDRedeemRequest table (owner = the wallet). For the customer's
// "Get ArcoUSD" screen: what is waiting, when it can be paid, how much is ahead of it, and whether it
// can be cancelled. Everything here is on-chain state anyway; a row limit, a 5-second cache per
// wallet and one shared, 5-second view of each asset's queue keep polling (or enumerating wallets)
// cheap. Failures answer a fixed code; the detail goes to the server log only (a public route).

export type RedemptionsFilter = "open" | "all"

/** Open = what the owner still has to wait for or act on (cancelRedeem works on both). */
const OPEN_STATUSES: readonly RedeemStatus[] = ["QUEUED", "PAYOUT_FAILED"]
const CANCELLABLE = new Set<string>(OPEN_STATUSES)
/** At most this many requests per answer (the newest kept). */
export const WALLET_REQUEST_LIMIT = 100
/** Queue positions read at most this many waiting requests per asset; beyond it, position is null. */
export const POSITION_ROW_LIMIT = 10_000
const CACHE_MS = 5_000
const MAX_CACHE_ENTRIES = 1_000
/** What `error` says when status is unavailable (why is in the server log). */
export const REDEMPTIONS_ERROR = { registry: "registry-invalid", read: "read-failed" } as const

export type QueuedRow = Pick<RedeemRecord, "requestId" | "assetAmount">

/** One asset's waiting requests by id (ascending) with running totals: prefix[i] = owed to ids[0..i). */
type QueueIndex = { readonly ids: readonly bigint[]; readonly prefix: readonly bigint[] }

export type WalletRedemptionsStore = {
  /** The owner's requests, NEWEST first; `statuses` null = every status. */
  byOwner(query: {
    chainId: number
    reserveAddress: string
    owner: string
    statuses: readonly RedeemStatus[] | null
    limit: number
  }): Promise<readonly RedeemRecord[]>
  /** Every QUEUED request of one asset (any owner), oldest first, at most `limit`. */
  queued(query: { chainId: number; reserveAddress: string; asset: string; limit: number }): Promise<readonly QueuedRow[]>
}

export type WalletRedemption = {
  readonly requestId: string
  readonly asset: { readonly symbol: string; readonly address: string; readonly decimals: number | null }
  readonly status: string
  /** Who receives the payout (the owner may have named someone else). */
  readonly recipient: string
  /** ArcoUSD escrowed (base18) and in ArcoUSD. */
  readonly arcoUSDAmount: string
  readonly arcoUSDAmountHuman: string
  /** Payout in asset base units (after the swap fee); human null for an asset not in the registry. */
  readonly assetAmount: string
  readonly assetAmountHuman: string | null
  readonly requestedAt: string
  readonly queuedTxHash: string
  readonly paidAt: string | null
  readonly paidTxHash: string | null
  readonly failedAt: string | null
  readonly failedTxHash: string | null
  readonly cancelledAt: string | null
  readonly cancelledTxHash: string | null
  /** cancelRedeem(requestId) would go through (QUEUED or PAYOUT_FAILED; the owner signs). */
  readonly cancellable: boolean
  /** processQueue may pay it from then on: requestedAt + queueMinDelay. */
  readonly payableFrom: string
  /** QUEUED for longer than the T+2 promise. */
  readonly overdue: boolean
  /** QUEUED only: the waiting requests of the same asset ahead of it (FIFO), and what they are owed. */
  readonly position: null | { readonly ahead: number; readonly aheadAssetAmount: string; readonly aheadAssetAmountHuman: string | null }
}

export type WalletRedemptionsResponse = {
  readonly status: "live" | "not-deployed" | "unavailable"
  /** With unavailable: REDEMPTIONS_ERROR.registry or .read. */
  readonly error?: string
  readonly chainId: number
  readonly readAt: string
  readonly wallet: string
  readonly filter: RedemptionsFilter
  /** Seconds a request waits before it can be paid: the live Reserve value, else the registry's. */
  readonly queueMinDelay: number
  readonly queueMinDelaySource: "chain" | "registry"
  /** The T+2 promise, in seconds. */
  readonly targetSeconds: number
  readonly requests: readonly WalletRedemption[]
  /** The list stopped at WALLET_REQUEST_LIMIT (the newest kept). */
  readonly truncated: boolean
}

/** The route's inputs, checked: a 400 with this message when either is wrong. */
export function parseRedemptionsQuery(walletInput: unknown, statusInput: unknown): { wallet: string; filter: RedemptionsFilter } {
  if (typeof walletInput !== "string" || !isAddress(walletInput, { strict: false })) throw new Error("wallet must be a valid EVM address")
  const status = statusInput === undefined || statusInput === "" ? "open" : statusInput
  if (status !== "open" && status !== "all") throw new Error("status must be open or all")
  return { wallet: getAddress(walletInput).toLowerCase(), filter: status }
}

type AssetInfo = { readonly symbol: string; readonly address: string; readonly decimals: number }

export class ArcoUSDRedemptions {
  private readonly cache = new Map<string, { at: number; value: WalletRedemptionsResponse }>()
  private readonly loading = new Map<string, Promise<WalletRedemptionsResponse>>()
  /** Shared by every wallet: one read of an asset's queue (keyed reserve:asset) serves them all for CACHE_MS. */
  private readonly queues = new Map<string, { at: number; value: Promise<QueueIndex | null> }>()

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly store: WalletRedemptionsStore
      /** Live Reserve.queueMinDelay (the cached reserve read); null when unread. */
      readonly liveQueueMinDelay?: () => Promise<number | null>
      readonly now?: () => number
      readonly cacheMs?: number
      readonly log?: (line: string) => void
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private get cacheMs() {
    return this.deps.cacheMs ?? CACHE_MS
  }

  /** `wallet` and `filter` as parseRedemptionsQuery returns them. Never throws. */
  async forWallet(wallet: string, filter: RedemptionsFilter): Promise<WalletRedemptionsResponse> {
    const key = `${wallet}:${filter}`
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value
    // Concurrent calls for the same wallet share one read.
    let pending = this.loading.get(key)
    if (!pending) {
      pending = this.load(wallet, filter).finally(() => this.loading.delete(key))
      this.loading.set(key, pending)
    }
    const value = await pending
    this.cache.delete(key)
    this.cache.set(key, { at: this.now(), value })
    // Oldest first out: a scan of random addresses cannot grow the cache without bound.
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  private warn(what: string, error: unknown) {
    ;(this.deps.log ?? ((line: string) => console.warn(line)))(`[arcousd-redemptions] ${what}: ${safeErrorText(error)}`)
  }

  private async load(wallet: string, filter: RedemptionsFilter): Promise<WalletRedemptionsResponse> {
    const readAt = new Date(this.now()).toISOString()
    const reply = (
      status: WalletRedemptionsResponse["status"],
      delay: { queueMinDelay: number; queueMinDelaySource: "chain" | "registry" },
      extra: { error?: string; truncated?: boolean; requests?: readonly WalletRedemption[] } = {},
    ): WalletRedemptionsResponse => ({
      status,
      ...(extra.error ? { error: extra.error } : {}),
      chainId: this.deps.chainId,
      readAt,
      wallet,
      filter,
      ...delay,
      targetSeconds: STANDARD_TARGET_SECONDS,
      truncated: extra.truncated ?? false,
      requests: extra.requests ?? [],
    })
    const registryDelay = { queueMinDelay: 0, queueMinDelaySource: "registry" as const }
    let deployment: DeployedArcoUSD | null
    try {
      deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
    } catch (error) {
      this.warn("ArcoUSD registry is invalid", error)
      return reply("unavailable", registryDelay, { error: REDEMPTIONS_ERROR.registry })
    }
    if (!deployment) return reply("not-deployed", registryDelay)

    const reserveAddress = deployment.reserveAddress.toLowerCase()
    const assets = assetsOf(deployment)
    const [live, rows] = await Promise.all([
      this.deps.liveQueueMinDelay ? this.deps.liveQueueMinDelay().catch(() => null) : Promise.resolve(null),
      this.deps.store
        .byOwner({
          chainId: this.deps.chainId,
          reserveAddress,
          owner: wallet,
          statuses: filter === "open" ? OPEN_STATUSES : null,
          limit: WALLET_REQUEST_LIMIT + 1,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
    ])
    const delay = {
      queueMinDelay: live ?? Number(deployment.params?.queueMinDelay ?? 0),
      queueMinDelaySource: live === null ? ("registry" as const) : ("chain" as const),
    }
    if (!rows.ok) {
      this.warn("redemptions read failed", rows.error)
      return reply("unavailable", delay, { error: REDEMPTIONS_ERROR.read })
    }
    try {
      // Newest first; requests of one block by id (the table keeps ids as strings).
      const sorted = [...rows.value].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || compareIds(b.requestId, a.requestId))
      const truncated = sorted.length > WALLET_REQUEST_LIMIT
      const mine = truncated ? sorted.slice(0, WALLET_REQUEST_LIMIT) : sorted
      const positions = await this.positions(reserveAddress, mine, assets)
      const now = this.now()
      return reply("live", delay, {
        truncated,
        requests: mine.map((row) => toRedemption(row, assets, delay.queueMinDelay, now, positions.get(row.requestId) ?? null)),
      })
    } catch (error) {
      // e.g. a registry queueMinDelay that is not a number: answer unavailable, never a raw 400.
      this.warn("redemptions could not be built", error)
      return reply("unavailable", delay, { error: REDEMPTIONS_ERROR.read })
    }
  }

  /** Per QUEUED request of the wallet: the QUEUED requests of its asset with a smaller id (the Reserve pays each asset's queue in order). */
  private async positions(
    reserveAddress: string,
    mine: readonly RedeemRecord[],
    assets: ReadonlyMap<string, AssetInfo>,
  ): Promise<Map<string, WalletRedemption["position"]>> {
    const result = new Map<string, WalletRedemption["position"]>()
    const waitingAssets = [...new Set(mine.filter((row) => row.status === "QUEUED").map((row) => row.asset.toLowerCase()))]
    const indexes = new Map(await Promise.all(waitingAssets.map(async (asset) => [asset, await this.queue(reserveAddress, asset)] as const)))
    for (const row of mine) {
      if (row.status !== "QUEUED") continue
      const asset = row.asset.toLowerCase()
      const index = indexes.get(asset)
      const id = toId(row.requestId)
      if (!index || id === null) continue // too long to count, unreadable, or a malformed id: position stays null
      const ahead = lowerBound(index.ids, id)
      const owed = index.prefix[ahead]
      const decimals = assets.get(asset)?.decimals ?? null
      result.set(row.requestId, { ahead, aheadAssetAmount: owed.toString(), aheadAssetAmountHuman: decimals === null ? null : formatUnits(owed, decimals) })
    }
    return result
  }

  /** One asset's queue as ids and running totals, shared for CACHE_MS; null when longer than POSITION_ROW_LIMIT or unreadable. */
  private queue(reserveAddress: string, asset: string): Promise<QueueIndex | null> {
    const key = `${reserveAddress}:${asset}`
    const hit = this.queues.get(key)
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value
    const entry: { at: number; value: Promise<QueueIndex | null> } = { at: this.now(), value: Promise.resolve(null) }
    entry.value = Promise.resolve()
      .then(() => this.deps.store.queued({ chainId: this.deps.chainId, reserveAddress, asset, limit: POSITION_ROW_LIMIT + 1 }))
      .then((rows) => {
        if (rows.length > POSITION_ROW_LIMIT) return null
        const pairs: { id: bigint; amount: bigint }[] = []
        for (const row of rows) {
          const id = toId(row.requestId)
          const amount = toId(row.assetAmount)
          // A malformed row (only a hand edit could make one) would skew every position: count none.
          if (id === null || amount === null) throw new Error(`malformed queued request ${String(row.requestId)}`)
          pairs.push({ id, amount })
        }
        pairs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const prefix: bigint[] = [0n]
        for (const pair of pairs) prefix.push(prefix[prefix.length - 1] + pair.amount)
        return { ids: pairs.map((pair) => pair.id), prefix }
      })
      .catch((error: unknown) => {
        this.warn("queue read failed", error)
        // Not cached: the next call asks again (unless a newer read has replaced this one).
        if (this.queues.get(key) === entry) this.queues.delete(key)
        return null
      })
    this.queues.set(key, entry)
    return entry.value
  }
}

/** A decimal string as a bigint; null when it is not one (the indexer always writes decimal strings). */
const toId = (value: unknown): bigint | null => (typeof value === "string" && /^\d{1,78}$/.test(value) ? BigInt(value) : null)
const toAmount = (value: string): bigint => toId(value) ?? 0n
const compareIds = (a: string, b: string) => {
  const x = toId(a) ?? -1n
  const y = toId(b) ?? -1n
  return x < y ? -1 : x > y ? 1 : 0
}

/** How many of the ascending `ids` are below `id`. */
function lowerBound(ids: readonly bigint[], id: bigint): number {
  let low = 0
  let high = ids.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (ids[mid] < id) low = mid + 1
    else high = mid
  }
  return low
}

function toRedemption(
  row: RedeemRecord,
  assets: ReadonlyMap<string, AssetInfo>,
  queueMinDelay: number,
  now: number,
  position: WalletRedemption["position"],
): WalletRedemption {
  const address = row.asset.toLowerCase()
  const info = assets.get(address) ?? null
  const requested = row.requestedAt.getTime()
  const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null)
  return {
    requestId: row.requestId,
    asset: { symbol: info?.symbol ?? address, address, decimals: info?.decimals ?? null },
    status: row.status,
    recipient: row.recipient.toLowerCase(),
    arcoUSDAmount: row.arcoUSDAmount,
    arcoUSDAmountHuman: formatUnits(toAmount(row.arcoUSDAmount), 18),
    assetAmount: row.assetAmount,
    assetAmountHuman: info ? formatUnits(toAmount(row.assetAmount), info.decimals) : null,
    requestedAt: row.requestedAt.toISOString(),
    queuedTxHash: row.queuedTxHash,
    paidAt: iso(row.paidAt),
    paidTxHash: row.paidTxHash ?? null,
    failedAt: iso(row.failedAt),
    failedTxHash: row.failedTxHash ?? null,
    cancelledAt: iso(row.cancelledAt),
    cancelledTxHash: row.cancelledTxHash ?? null,
    cancellable: CANCELLABLE.has(row.status),
    payableFrom: new Date(requested + queueMinDelay * 1000).toISOString(),
    overdue: row.status === "QUEUED" && now - requested > STANDARD_TARGET_SECONDS * 1000,
    position: row.status === "QUEUED" ? position : null,
  }
}

function assetsOf(deployment: DeployedArcoUSD): Map<string, AssetInfo> {
  const map = new Map<string, AssetInfo>()
  for (const asset of deployment.reserveAssets ?? []) {
    if (asset.address) map.set(asset.address.toLowerCase(), { symbol: asset.symbol, address: asset.address.toLowerCase(), decimals: asset.decimals })
  }
  return map
}

export type PrismaRedemptionsDelegates = {
  arcoUSDRedeemRequest: { findMany(args: unknown): Promise<unknown[]> }
}

export class PrismaRedemptionsStore implements WalletRedemptionsStore {
  constructor(private readonly prisma: PrismaRedemptionsDelegates) {}

  async byOwner(query: Parameters<WalletRedemptionsStore["byOwner"]>[0]) {
    return (await this.prisma.arcoUSDRedeemRequest.findMany({
      where: {
        chainId: query.chainId,
        reserveAddress: query.reserveAddress.toLowerCase(),
        owner: query.owner.toLowerCase(),
        ...(query.statuses ? { status: { in: [...query.statuses] } } : {}),
      },
      orderBy: [{ requestedAt: "desc" }, { queuedBlock: "desc" }],
      take: query.limit,
    })) as RedeemRecord[]
  }

  async queued(query: Parameters<WalletRedemptionsStore["queued"]>[0]) {
    return (await this.prisma.arcoUSDRedeemRequest.findMany({
      where: {
        chainId: query.chainId,
        reserveAddress: query.reserveAddress.toLowerCase(),
        asset: query.asset.toLowerCase(),
        status: "QUEUED",
      },
      orderBy: [{ requestedAt: "asc" }, { queuedBlock: "asc" }],
      take: query.limit,
      select: { requestId: true, assetAmount: true },
    })) as QueuedRow[]
  }
}
