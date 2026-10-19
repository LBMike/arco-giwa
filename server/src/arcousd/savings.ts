import { formatUnits, type PublicClient } from "viem"
import {
  ARCOUSD_MINT_SELECTOR,
  distributorAbi,
  reservePauseAbi,
  SAVINGS_DEPOSIT_SELECTOR,
  SAVINGS_REWARDS_SELECTOR,
  SAVINGS_SEED_HOLDER,
  SAVINGS_WITHDRAW_SELECTOR,
  savingsVaultReadAbi,
} from "./abi.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD, type DeployedSavings } from "./registry.js"
import { safeErrorText } from "./safe-error.js"

// Savings (sArcoUSD, docs/specs/arcousd-v1.md §3.13–3.14): one read of the vault and the
// distributor, serialized for JSON (base units as decimal strings, human amounts for screens),
// the public savings state with a short cache, and the share-price history the savings indexer
// records. Read-only; inert ("not-deployed") until all three Savings contracts are in the registry.

const ONE = 10n ** 18n
const YEAR_SECONDS = 365n * 24n * 60n * 60n
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DAYS = 90
const HISTORY_CACHE_MS = 60_000
const HISTORY_RETRY_MS = 5_000
/** APR/APY in bps are capped here (an almost empty vault can show absurd rates; also fits INT4). */
export const MAX_RATE_BPS = 2_147_483_647
/** distribute() amounts under one cent are not worth a transaction (and read as $0): the keeper skips
 *  them and the watcher does not call them overdue. */
export const DISTRIBUTE_MIN_AMOUNT = 10n ** 16n
/** What the public state says when the distributor's preview() could not be read (detail is logged). */
export const PREVIEW_UNREADABLE = "preview-unreadable"
const DEFAULT_DAYS = 30
const MAX_POINTS = 360
const HISTORY_ROWS_LIMIT = 30_000

export type DistributorPreview = {
  /** What distribute() would mint now (0 while NAV is unreadable or the Reserve is paused). */
  readonly amount: string
  readonly amountUsd: string
  /** Reserve backing − liabilities − the margin (0 when below). */
  readonly surplus: string
  /** APR cap on the vault's time-weighted assets since the last distribution. */
  readonly rateCap: string
  /** Room left under the Reserve's mintCap. */
  readonly mintHeadroom: string
  readonly navOk: boolean
}

export type SavingsState = {
  readonly blockNumber: string
  /** ArcoUSD the vault counts (balance − rewards still vesting), base18. */
  readonly totalAssets: string
  readonly totalAssetsUsd: string
  readonly totalSupply: string
  /** ArcoUSD per 1 sArcoUSD, base18 (1e18 = par). */
  readonly sharePrice: string
  readonly sharePriceHuman: string
  /** Rewards not yet in the share price, base18. */
  readonly unvested: string
  readonly unvestedUsd: string
  readonly vestingAmount: string
  readonly vestingPeriodSeconds: number
  readonly vestingStartedAt: string | null
  readonly vestingEndsAt: string | null
  /** ArcoUSD released into the share price per second right now, base18. */
  readonly rewardRate: string
  /** rewardRate × 1 year ÷ totalAssets, in bps (simple, what is vesting now; capped at MAX_RATE_BPS). */
  readonly currentAprBps: number
  /** The same compounded daily, in bps (capped at MAX_RATE_BPS). */
  readonly currentApyBps: number
  /** 1 sArcoUSD held by 0x…dEaD (sArcoUSD.seed() ran: deposits were opened). */
  readonly seeded: boolean
  readonly vaultPaused: boolean
  /** fnPaused(deposit) — deposits and mints (also closed until the seed). */
  readonly depositPaused: boolean
  /** fnPaused(withdraw) — withdrawals and redemptions. */
  readonly withdrawPaused: boolean
  /** fnPaused(addRewards) — no yield can be added. */
  readonly rewardsPaused: boolean
  /** seeded and neither the vault nor deposit is paused. */
  readonly depositsOpen: boolean
  /** Neither the vault nor withdraw is paused. */
  readonly withdrawalsOpen: boolean
  readonly distributor: {
    readonly paused: boolean
    /** Reserve.paused(): distribute() refuses (ReservePaused). */
    readonly reservePaused: boolean
    /** ArcoUSD paused() or fnPaused(mint): distribute() cannot mint. */
    readonly arcoUSDMintPaused: boolean
    readonly minIntervalSeconds: number
    readonly maxAprBps: number
    readonly reserveMarginBps: number
    readonly lastDistributionAt: string
    readonly nextDistributionAt: string
    /** null when preview() could not be read (`previewError` is then PREVIEW_UNREADABLE; the server logs why). */
    readonly preview: DistributorPreview | null
    readonly previewError?: string
  }
}

/** Reads at `blockNumber` when given, else the latest block. */
export type SavingsChainReader = (savings: DeployedSavings, blockNumber?: bigint) => Promise<SavingsState>

type Client = Pick<PublicClient, "readContract" | "getBlockNumber">

export function createSavingsChainReader(client: Client): SavingsChainReader {
  return async (savings, at) => {
    const blockNumber = at ?? (await client.getBlockNumber())
    const vault = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: savings.vaultAddress, abi: savingsVaultReadAbi, functionName, args, blockNumber } as never) as Promise<unknown>
    const distributor = (functionName: string) =>
      client.readContract({ address: savings.distributorAddress, abi: distributorAbi, functionName, blockNumber } as never) as Promise<unknown>
    const pause = (address: `0x${string}`, selector?: `0x${string}`) =>
      client.readContract({
        address,
        abi: reservePauseAbi,
        functionName: selector ? "fnPaused" : "paused",
        args: selector ? [selector] : [],
        blockNumber,
      } as never) as Promise<unknown>
    const [
      totalAssets,
      totalSupply,
      sharePrice,
      unvested,
      vestingAmount,
      vestingStart,
      vestingPeriod,
      rewardRate,
      seedShares,
      minShares,
      vaultPaused,
      depositPaused,
      withdrawPaused,
      rewardsPaused,
      distributorPaused,
      minInterval,
      maxAprBps,
      reserveMarginBps,
      lastDistribution,
      reservePaused,
      arcoUSDPaused,
      arcoUSDMintPaused,
    ] = await Promise.all([
      vault("totalAssets"),
      vault("totalSupply"),
      vault("convertToAssets", [ONE]),
      vault("unvestedAmount"),
      vault("vestingAmount"),
      vault("vestingStart"),
      vault("vestingPeriod"),
      vault("rewardRate"),
      vault("balanceOf", [SAVINGS_SEED_HOLDER]),
      vault("MIN_SHARES"),
      vault("paused"),
      vault("fnPaused", [SAVINGS_DEPOSIT_SELECTOR]),
      vault("fnPaused", [SAVINGS_WITHDRAW_SELECTOR]),
      vault("fnPaused", [SAVINGS_REWARDS_SELECTOR]),
      distributor("paused"),
      distributor("minInterval"),
      distributor("maxAprBps"),
      distributor("reserveMarginBps"),
      distributor("lastDistribution"),
      pause(savings.reserveAddress),
      pause(savings.arcoUSDAddress),
      pause(savings.arcoUSDAddress, ARCOUSD_MINT_SELECTOR),
    ])
    // The preview reads the whole Reserve through the Lens; a failure there must not hide the vault.
    // The detail stays in the server log: this state is served on a public route.
    let preview: RawPreview | null = null
    try {
      preview = (await distributor("preview")) as RawPreview
    } catch (error) {
      console.warn(`[arcousd-savings] distributor preview() failed: ${safeErrorText(error)}`)
    }
    return toSavingsState(
      {
        blockNumber,
        totalAssets: big(totalAssets),
        totalSupply: big(totalSupply),
        sharePrice: big(sharePrice),
        unvested: big(unvested),
        vestingAmount: big(vestingAmount),
        vestingStart: big(vestingStart),
        vestingPeriod: big(vestingPeriod),
        rewardRate: big(rewardRate),
        seedShares: big(seedShares),
        minShares: big(minShares),
        vaultPaused: Boolean(vaultPaused),
        depositPaused: Boolean(depositPaused),
        withdrawPaused: Boolean(withdrawPaused),
        rewardsPaused: Boolean(rewardsPaused),
        distributorPaused: Boolean(distributorPaused),
        minInterval: big(minInterval),
        maxAprBps: big(maxAprBps),
        reserveMarginBps: big(reserveMarginBps),
        lastDistribution: big(lastDistribution),
        reservePaused: Boolean(reservePaused),
        arcoUSDMintPaused: Boolean(arcoUSDPaused) || Boolean(arcoUSDMintPaused),
      },
      preview,
    )
  }
}

/** preview() as viem decodes it (a named tuple → array). */
export type RawPreview = readonly [bigint, bigint, bigint, bigint, bigint, boolean]

export type RawSavings = {
  readonly blockNumber: bigint
  readonly totalAssets: bigint
  readonly totalSupply: bigint
  readonly sharePrice: bigint
  readonly unvested: bigint
  readonly vestingAmount: bigint
  readonly vestingStart: bigint
  readonly vestingPeriod: bigint
  readonly rewardRate: bigint
  readonly seedShares: bigint
  readonly minShares: bigint
  readonly vaultPaused: boolean
  readonly depositPaused: boolean
  readonly withdrawPaused: boolean
  readonly rewardsPaused: boolean
  readonly distributorPaused: boolean
  readonly minInterval: bigint
  readonly maxAprBps: bigint
  readonly reserveMarginBps: bigint
  readonly lastDistribution: bigint
  readonly reservePaused: boolean
  readonly arcoUSDMintPaused: boolean
}

export function toSavingsState(raw: RawSavings, preview: RawPreview | null): SavingsState {
  const rawApr = raw.totalAssets > 0n ? (raw.rewardRate * YEAR_SECONDS * 10_000n) / raw.totalAssets : 0n
  const aprBps = rawApr > BigInt(MAX_RATE_BPS) ? MAX_RATE_BPS : Number(rawApr)
  // vestingAmount is never reset on-chain: "vesting" means something is still being released.
  const vesting = raw.unvested > 0n && raw.vestingStart > 0n
  const seeded = raw.minShares > 0n && raw.seedShares >= raw.minShares
  return {
    blockNumber: raw.blockNumber.toString(),
    totalAssets: raw.totalAssets.toString(),
    totalAssetsUsd: formatUnits(raw.totalAssets, 18),
    totalSupply: raw.totalSupply.toString(),
    sharePrice: raw.sharePrice.toString(),
    sharePriceHuman: formatUnits(raw.sharePrice, 18),
    unvested: raw.unvested.toString(),
    unvestedUsd: formatUnits(raw.unvested, 18),
    vestingAmount: raw.vestingAmount.toString(),
    vestingPeriodSeconds: Number(raw.vestingPeriod),
    vestingStartedAt: vesting ? isoSeconds(raw.vestingStart) : null,
    vestingEndsAt: vesting ? isoSeconds(raw.vestingStart + raw.vestingPeriod) : null,
    rewardRate: raw.rewardRate.toString(),
    currentAprBps: aprBps,
    currentApyBps: dailyCompoundedBps(aprBps),
    seeded,
    vaultPaused: raw.vaultPaused,
    depositPaused: raw.depositPaused,
    withdrawPaused: raw.withdrawPaused,
    rewardsPaused: raw.rewardsPaused,
    depositsOpen: seeded && !raw.vaultPaused && !raw.depositPaused,
    withdrawalsOpen: !raw.vaultPaused && !raw.withdrawPaused,
    distributor: {
      paused: raw.distributorPaused,
      reservePaused: raw.reservePaused,
      arcoUSDMintPaused: raw.arcoUSDMintPaused,
      minIntervalSeconds: Number(raw.minInterval),
      maxAprBps: Number(raw.maxAprBps),
      reserveMarginBps: Number(raw.reserveMarginBps),
      lastDistributionAt: isoSeconds(raw.lastDistribution),
      nextDistributionAt: isoSeconds(raw.lastDistribution + raw.minInterval),
      preview: preview
        ? {
            amount: preview[0].toString(),
            amountUsd: formatUnits(preview[0], 18),
            surplus: preview[1].toString(),
            rateCap: preview[2].toString(),
            mintHeadroom: preview[3].toString(),
            navOk: preview[5],
          }
        : null,
      ...(preview ? {} : { previewError: PREVIEW_UNREADABLE }),
    },
  }
}

/** Simple APR (bps) compounded daily, in bps. */
export function dailyCompoundedBps(aprBps: number): number {
  if (!Number.isFinite(aprBps) || aprBps <= 0) return 0
  const value = Math.round((Math.pow(1 + aprBps / 10_000 / 365, 365) - 1) * 10_000)
  return Number.isFinite(value) && value < MAX_RATE_BPS ? value : MAX_RATE_BPS
}

/** Annualized growth (bps) between two share prices `seconds` apart; null under a day. */
export function annualizedBps(fromPrice: bigint, toPrice: bigint, seconds: number): number | null {
  if (fromPrice <= 0n || toPrice <= 0n || !(seconds >= 86_400)) return null
  const ratio = Number((toPrice * 1_000_000_000_000n) / fromPrice) / 1e12
  const value = (Math.pow(ratio, (365 * 86_400) / seconds) - 1) * 10_000
  return Number.isFinite(value) ? Math.round(value) : null
}

// ─────────────────────────────── public service ───────────────────────────────

export type SavingsContracts = {
  readonly sArcoUSD: string
  readonly distributor: string
  readonly zap: string
  readonly arcoUSD: string
  readonly reserve: string
}

export type SavingsStateResponse = {
  readonly status: "not-deployed" | "live" | "unavailable"
  readonly chainId: number
  readonly contracts: SavingsContracts | null
  readonly readAt: string
  readonly savings: SavingsState | null
}

export type SavingsSnapshotRecord = {
  readonly takenAt: Date
  readonly blockNumber: bigint
  readonly totalAssets: string
  readonly sharePrice: string
  readonly aprBps: number
}

export type SavingsHistoryStore = {
  /** NEWEST first (a limit keeps the latest), scalar columns only. */
  snapshots(query: { chainId: number; vaultAddress: string; since: Date; limit: number }): Promise<readonly SavingsSnapshotRecord[]>
}

export type SavingsHistoryPoint = {
  readonly takenAt: string
  readonly blockNumber: string
  /** ArcoUSD per sArcoUSD (decimal string). */
  readonly sharePrice: string
  readonly totalAssetsUsd: string
  readonly aprBps: number
}

export type SavingsHistoryResponse = {
  readonly status: "not-deployed" | "live" | "unavailable"
  readonly chainId: number
  readonly days: number
  /** Snapshots in the window (before sampling). */
  readonly total: number
  /** true when `points` keeps only the last snapshot of each of at most 360 equal buckets. */
  readonly sampled: boolean
  /** The read stopped at 30,000 rows: the oldest part of the window is missing (latest kept). */
  readonly truncated: boolean
  readonly points: readonly SavingsHistoryPoint[]
  /** Share-price growth over the window, annualized (bps); null with under a day of history. */
  readonly realizedApyBps: number | null
}

export class ArcoUSDSavingsService {
  private cache: { at: number; value: SavingsStateResponse } | null = null
  private inflight: Promise<SavingsStateResponse> | null = null
  /** Public and DB-backed: one read per window per minute. */
  private historyCache = new Map<number, { at: number; ttl: number; value: Promise<SavingsHistoryResponse> }>()

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly read?: SavingsChainReader
      readonly history?: SavingsHistoryStore
      readonly now?: () => number
      /** Default 15s, like the reserve state. */
      readonly cacheMs?: number
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  async state(): Promise<SavingsStateResponse> {
    const now = this.now()
    if (this.cache && now - this.cache.at < (this.deps.cacheMs ?? 15_000)) return this.cache.value
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null
      })
    }
    const value = await this.inflight
    this.cache = { at: this.now(), value }
    return value
  }

  async history(daysInput?: unknown): Promise<SavingsHistoryResponse> {
    const days = parseDays(daysInput)
    const now = this.now()
    const cached = this.historyCache.get(days)
    if (cached && now - cached.at < cached.ttl) return cached.value
    const value = this.loadHistory(days)
    // Concurrent requests share the read; a failed read is kept only briefly (a DB blip should clear fast).
    this.historyCache.set(days, { at: now, ttl: HISTORY_CACHE_MS, value })
    void value.then((result) => {
      if (result.status === "unavailable") this.historyCache.set(days, { at: now, ttl: HISTORY_RETRY_MS, value })
    })
    return value
  }

  private async loadHistory(days: number): Promise<SavingsHistoryResponse> {
    const empty = { chainId: this.deps.chainId, days, total: 0, sampled: false, truncated: false, points: [], realizedApyBps: null }
    const current = this.deployment()
    if (current.status !== "live") return { ...empty, status: current.status }
    if (!this.deps.history) return { ...empty, status: "unavailable" }
    let newest: readonly SavingsSnapshotRecord[]
    try {
      newest = await this.deps.history.snapshots({
        chainId: this.deps.chainId,
        vaultAddress: current.savings.vaultAddress.toLowerCase(),
        since: new Date(this.now() - days * DAY_MS),
        limit: HISTORY_ROWS_LIMIT,
      })
    } catch {
      return { ...empty, status: "unavailable" }
    }
    const rows = [...newest].reverse()
    const kept = sample(rows, MAX_POINTS)
    const first = rows[0]
    const last = rows[rows.length - 1]
    return {
      status: "live",
      chainId: this.deps.chainId,
      days,
      total: rows.length,
      sampled: kept.length < rows.length,
      truncated: rows.length >= HISTORY_ROWS_LIMIT,
      points: kept.map((row) => ({
        takenAt: row.takenAt.toISOString(),
        blockNumber: row.blockNumber.toString(),
        sharePrice: formatUnits(BigInt(row.sharePrice), 18),
        totalAssetsUsd: formatUnits(BigInt(row.totalAssets), 18),
        aprBps: row.aprBps,
      })),
      realizedApyBps:
        first && last ? annualizedBps(BigInt(first.sharePrice), BigInt(last.sharePrice), (last.takenAt.getTime() - first.takenAt.getTime()) / 1000) : null,
    }
  }

  private deployment():
    | { status: "live"; deployment: DeployedArcoUSD; savings: DeployedSavings }
    | { status: "not-deployed" }
    | { status: "unavailable" } {
    let deployment: DeployedArcoUSD | null
    try {
      deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
    } catch {
      return { status: "unavailable" } // a present-but-invalid registry is an ops error
    }
    if (!deployment?.savings) return { status: "not-deployed" }
    return { status: "live", deployment, savings: deployment.savings }
  }

  private async load(): Promise<SavingsStateResponse> {
    const readAt = new Date(this.now()).toISOString()
    const base = { chainId: this.deps.chainId, readAt }
    const current = this.deployment()
    if (current.status !== "live") return { ...base, status: current.status, contracts: null, savings: null }
    const { deployment, savings } = current
    const contracts: SavingsContracts = {
      sArcoUSD: savings.vaultAddress.toLowerCase(),
      distributor: savings.distributorAddress.toLowerCase(),
      zap: savings.zapAddress.toLowerCase(),
      arcoUSD: deployment.arcoUSDAddress.toLowerCase(),
      reserve: deployment.reserveAddress.toLowerCase(),
    }
    if (!this.deps.read) return { ...base, status: "unavailable", contracts, savings: null }
    try {
      return { ...base, status: "live", contracts, savings: await this.deps.read(savings) }
    } catch {
      return { ...base, status: "unavailable", contracts, savings: null }
    }
  }
}

// ─────────────────────────────── Prisma ───────────────────────────────

export type PrismaSavingsHistoryDelegates = {
  arcoUSDSavingsSnapshot: { findMany(args: unknown): Promise<unknown[]> }
}

/** Reads only; the savings indexer is the writer. */
export class PrismaSavingsHistoryStore implements SavingsHistoryStore {
  constructor(private readonly prisma: PrismaSavingsHistoryDelegates) {}

  async snapshots(query: { chainId: number; vaultAddress: string; since: Date; limit: number }) {
    return (await this.prisma.arcoUSDSavingsSnapshot.findMany({
      where: { chainId: query.chainId, vaultAddress: query.vaultAddress.toLowerCase(), takenAt: { gte: query.since } },
      orderBy: { takenAt: "desc" },
      take: query.limit,
      select: { takenAt: true, blockNumber: true, totalAssets: true, sharePrice: true, aprBps: true },
    })) as SavingsSnapshotRecord[]
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

function big(value: unknown): bigint {
  return typeof value === "bigint" ? value : BigInt(value as number | string)
}

function isoSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString()
}

function parseDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_DAYS
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : DEFAULT_DAYS
}

/** Keeps the last row of each of at most `max` equal buckets (the latest snapshot always stays). */
function sample<T>(rows: readonly T[], max: number): readonly T[] {
  if (rows.length <= max) return rows
  const size = Math.ceil(rows.length / max)
  const kept: T[] = []
  for (let end = rows.length; end > 0; end -= size) kept.push(rows[end - 1])
  return kept.reverse()
}
