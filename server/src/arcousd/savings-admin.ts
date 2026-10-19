import { BaseError, ContractFunctionRevertedError, encodeFunctionData, formatUnits, getAddress, type Address, type PublicClient } from "viem"
import { unsignedAdminTransaction, type UnsignedAdminTransaction } from "../evm/admin-transactions.js"
import { distributorAbi } from "./abi.js"
import type { ArcoUSDAdminStore, EventRecord } from "./admin.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD, type DeployedSavings } from "./registry.js"
import { safeErrorText } from "./safe-error.js"

// Admin reads over what the savings indexer records (sArcoUSD, the distributor, the Zap), plus the
// manual distribute() transaction builder. No chain writes: the operator signs in the console.
// distribute() is permissionless on-chain (it only moves Reserve surplus to savers, within its
// caps); the builder dry-runs it first.

const MAX_DAYS = 90
const DEFAULT_DAYS = 30
const EVENT_ROWS_LIMIT = 20_000
const RECENT = 50
const DAY_MS = 24 * 60 * 60 * 1000

/** distribute()'s custom errors, in words (the simulation error names only the function). */
const DISTRIBUTE_REVERTS: Readonly<Record<string, string>> = {
  TooSoon: "the interval since the last distribution has not passed",
  ReservePaused: "the Reserve is paused",
  NoDepositors: "the vault has no savers",
  NavUnavailable: "a strategy price feed cannot be read",
  NothingToDistribute: "nothing to distribute (no surplus above the margin, no APR room, or the mint cap is reached)",
}

/** "TooSoon: the interval … has not passed" from a reverted simulation; else the safe error line. */
export function distributeRevertText(error: unknown): string {
  const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.reason) return reverted.reason // Error(string) / Panic, e.g. "Pausable: paused"
    const name = reverted.data?.errorName
    if (name) return DISTRIBUTE_REVERTS[name] ? `${name}: ${DISTRIBUTE_REVERTS[name]}` : name
  }
  return safeErrorText(error)
}

export type SavingsAdminStatus = "not-deployed" | "live" | "unavailable"

export type SavingsDistribution = {
  readonly at: string | null
  readonly txHash: string
  readonly caller: string
  readonly amountUsd: string
  readonly surplusUsd: string
  readonly rateCapUsd: string
  readonly backingUsd: string
  readonly liabilitiesUsd: string
}

export type SavingsReward = {
  readonly at: string | null
  readonly txHash: string
  readonly caller: string
  readonly amountUsd: string
  /** Added by the distributor (Reserve surplus) rather than an operator top-up. */
  readonly fromDistributor: boolean
}

export type SavingsActivity = {
  readonly at: string | null
  readonly txHash: string
  readonly kind: "deposit" | "withdraw" | "seed"
  /** Share owner (deposit receiver / withdrawal owner). */
  readonly account: string
  /** Who called the vault (the Zap for stablecoin deposits and withdrawals). */
  readonly sender: string
  readonly amountUsd: string
  readonly viaZap: boolean
}

export type SavingsFlowDay = { readonly day: string; readonly depositsUsd: string; readonly withdrawalsUsd: string }

export type SavingsZapAsset = {
  readonly asset: string
  readonly symbol: string
  readonly deposits: number
  readonly depositAmount: string
  readonly redemptions: number
  readonly redeemAmount: string
}

export type SavingsAdminResponse = {
  readonly status: SavingsAdminStatus
  readonly error?: string
  readonly days: number
  readonly contracts: { readonly sArcoUSD: string; readonly distributor: string; readonly zap: string } | null
  /** Over the window, the seed excluded. */
  readonly totals: {
    readonly depositsUsd: string
    readonly deposits: number
    readonly withdrawalsUsd: string
    readonly withdrawals: number
    readonly distributedUsd: string
    readonly distributions: number
    readonly toppedUpUsd: string
  }
  readonly daily: readonly SavingsFlowDay[]
  readonly distributions: readonly SavingsDistribution[]
  readonly rewards: readonly SavingsReward[]
  readonly activity: readonly SavingsActivity[]
  readonly zapAssets: readonly SavingsZapAsset[]
  /** The read stopped at 20,000 events: the oldest part of the window is missing (latest kept). */
  readonly truncated: boolean
}

export type DistributeResult =
  | {
      readonly ok: true
      readonly transaction: UnsignedAdminTransaction
      /** eth_call of distribute(): what it would mint now, or why it would revert. */
      readonly preview: { readonly amountUsd: string; readonly blockNumber: string } | { readonly error: string }
    }
  | { readonly ok: false; readonly status: number; readonly error: string }

export type DistributeSimulator = (input: { distributor: Address }) => Promise<{ amount: bigint; blockNumber: bigint }>

export function createDistributeSimulator(client: Pick<PublicClient, "simulateContract" | "getBlockNumber">): DistributeSimulator {
  return async ({ distributor }) => {
    const blockNumber = await client.getBlockNumber()
    const { result } = await client.simulateContract({ address: distributor, abi: distributorAbi, functionName: "distribute", blockNumber })
    return { amount: result as bigint, blockNumber }
  }
}

type Current =
  | { readonly status: "live"; readonly deployment: DeployedArcoUSD; readonly savings: DeployedSavings }
  | { readonly status: "not-deployed" }
  | { readonly status: "unavailable"; readonly error: string }

export class ArcoUSDSavingsAdmin {
  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly store: Pick<ArcoUSDAdminStore, "events">
      readonly simulateDistribute?: DistributeSimulator
      readonly now?: () => number
    },
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private current(): Current {
    try {
      const deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
      return deployment?.savings ? { status: "live", deployment, savings: deployment.savings } : { status: "not-deployed" }
    } catch (error) {
      return { status: "unavailable", error: safeErrorText(error) }
    }
  }

  async view(daysInput?: unknown): Promise<SavingsAdminResponse> {
    const days = parseDays(daysInput)
    const empty = {
      days,
      contracts: null,
      totals: { depositsUsd: "0", deposits: 0, withdrawalsUsd: "0", withdrawals: 0, distributedUsd: "0", distributions: 0, toppedUpUsd: "0" },
      daily: [],
      distributions: [],
      rewards: [],
      activity: [],
      zapAssets: [],
      truncated: false,
    }
    const current = this.current()
    if (current.status === "not-deployed") return { ...empty, status: "not-deployed" }
    if (current.status === "unavailable") return { ...empty, status: "unavailable", error: current.error }
    const { deployment, savings } = current
    const vault = savings.vaultAddress.toLowerCase()
    const distributor = savings.distributorAddress.toLowerCase()
    const zap = savings.zapAddress.toLowerCase()
    const contracts = { sArcoUSD: vault, distributor, zap }
    const since = this.now() - days * DAY_MS
    let newest: readonly EventRecord[]
    try {
      newest = await this.deps.store.events({ chainId: this.deps.chainId, contracts: [vault, distributor, zap], since: new Date(since), limit: EVENT_ROWS_LIMIT })
    } catch (error) {
      return { ...empty, contracts, status: "unavailable", error: `Event read failed: ${safeErrorText(error)}` }
    }

    const assets = new Map(
      deployment.reserveAssets.filter((asset) => asset.address).map((asset) => [asset.address!.toLowerCase(), asset] as const),
    )
    const byDay = new Map<string, { deposits: bigint; withdrawals: bigint }>()
    for (let day = startOfUtcDay(since); day <= this.now(); day += DAY_MS) byDay.set(dayKey(day), { deposits: 0n, withdrawals: 0n })
    const zapAssets = new Map<string, { deposits: number; depositAmount: bigint; redemptions: number; redeemAmount: bigint }>()
    let deposits = 0n
    let depositCount = 0
    let withdrawals = 0n
    let withdrawalCount = 0
    let distributed = 0n
    let toppedUp = 0n
    const distributions: SavingsDistribution[] = []
    const rewards: SavingsReward[] = []
    const activity: SavingsActivity[] = []
    // The seed is the deposit in seed()'s transaction (not any later deposit to 0x…dEaD).
    const seedTxs = new Set(
      newest.filter((event) => event.contractAddress.toLowerCase() === vault && event.eventName === "Seeded").map((event) => event.txHash.toLowerCase()),
    )

    for (const event of newest) {
      const args = (event.args ?? {}) as Record<string, unknown>
      const at = event.blockTimestamp
      const iso = at ? at.toISOString() : null
      const bucket = at ? byDay.get(dayKey(at.getTime())) : undefined
      const contract = event.contractAddress.toLowerCase()
      if (contract === vault && (event.eventName === "Deposit" || event.eventName === "Withdraw")) {
        const amount = big(args.assets)
        const owner = str(args.owner)
        const sender = str(args.sender)
        if (event.eventName === "Deposit" && seedTxs.has(event.txHash.toLowerCase())) {
          if (activity.length < RECENT) activity.push({ at: iso, txHash: event.txHash, kind: "seed", account: owner, sender, amountUsd: usd(amount), viaZap: false })
          continue
        }
        const deposit = event.eventName === "Deposit"
        if (deposit) {
          deposits += amount
          depositCount++
          if (bucket) bucket.deposits += amount
        } else {
          withdrawals += amount
          withdrawalCount++
          if (bucket) bucket.withdrawals += amount
        }
        const viaZap = sender === zap || str(args.receiver) === zap
        if (activity.length < RECENT) {
          activity.push({ at: iso, txHash: event.txHash, kind: deposit ? "deposit" : "withdraw", account: owner, sender, amountUsd: usd(amount), viaZap })
        }
      } else if (contract === vault && event.eventName === "RewardsAdded") {
        const amount = big(args.amount)
        const caller = str(args.caller)
        const fromDistributor = caller === distributor
        if (!fromDistributor) toppedUp += amount
        if (rewards.length < RECENT) rewards.push({ at: iso, txHash: event.txHash, caller, amountUsd: usd(amount), fromDistributor })
      } else if (contract === distributor && event.eventName === "Distributed") {
        const amount = big(args.amount)
        distributed += amount
        if (distributions.length < RECENT) {
          distributions.push({
            at: iso,
            txHash: event.txHash,
            caller: str(args.caller),
            amountUsd: usd(amount),
            surplusUsd: usd(big(args.surplus)),
            rateCapUsd: usd(big(args.rateCap)),
            backingUsd: usd(big(args.backing)),
            liabilitiesUsd: usd(big(args.liabilities)),
          })
        }
      } else if (contract === zap && (event.eventName === "ZapDeposit" || event.eventName === "ZapRedeem")) {
        const asset = str(args.asset)
        const row = zapAssets.get(asset) ?? { deposits: 0, depositAmount: 0n, redemptions: 0, redeemAmount: 0n }
        if (event.eventName === "ZapDeposit") {
          row.deposits++
          row.depositAmount += big(args.amount)
        } else {
          row.redemptions++
          row.redeemAmount += big(args.assetOut)
        }
        zapAssets.set(asset, row)
      }
    }
    const distributionCount = newest.filter((event) => event.contractAddress.toLowerCase() === distributor && event.eventName === "Distributed").length
    return {
      status: "live",
      days,
      contracts,
      totals: {
        depositsUsd: usd(deposits),
        deposits: depositCount,
        withdrawalsUsd: usd(withdrawals),
        withdrawals: withdrawalCount,
        distributedUsd: usd(distributed),
        distributions: distributionCount,
        toppedUpUsd: usd(toppedUp),
      },
      daily: [...byDay.entries()].map(([day, totals]) => ({ day, depositsUsd: usd(totals.deposits), withdrawalsUsd: usd(totals.withdrawals) })),
      distributions,
      rewards,
      activity,
      zapAssets: [...zapAssets.entries()].map(([asset, row]) => {
        const info = assets.get(asset)
        // ArcoUSD itself can go through the Zap (no Reserve step): 18 decimals.
        const isArcoUSD = asset === deployment.arcoUSDAddress.toLowerCase()
        const decimals = info?.decimals ?? 18
        return {
          asset,
          symbol: info?.symbol ?? (isArcoUSD ? "ArcoUSD" : asset),
          deposits: row.deposits,
          depositAmount: formatUnits(row.depositAmount, decimals),
          redemptions: row.redemptions,
          redeemAmount: formatUnits(row.redeemAmount, decimals),
        }
      }),
      truncated: newest.length >= EVENT_ROWS_LIMIT,
    }
  }

  /** Unsigned distribute() for the operator's wallet, with a dry run of what it would mint. */
  async distributeTransaction(): Promise<DistributeResult> {
    const current = this.current()
    if (current.status === "not-deployed") return { ok: false, status: 409, error: "Savings is not deployed" }
    if (current.status === "unavailable") return { ok: false, status: 503, error: `ArcoUSD registry is invalid: ${current.error}` }
    const { deployment, savings } = current
    const distributor = getAddress(savings.distributorAddress) as Address
    let preview: { amountUsd: string; blockNumber: string } | { error: string }
    if (!this.deps.simulateDistribute) {
      preview = { error: "Simulation unavailable" }
    } else {
      try {
        const simulated = await this.deps.simulateDistribute({ distributor })
        preview = { amountUsd: usd(simulated.amount), blockNumber: simulated.blockNumber.toString() }
      } catch (error) {
        preview = { error: `distribute() would revert or could not be simulated: ${distributeRevertText(error)}` }
      }
    }
    const transaction = unsignedAdminTransaction(
      deployment.chainId,
      distributor,
      encodeFunctionData({ abi: distributorAbi, functionName: "distribute" }),
      "ArcoUSD Savings: mint the distributable Reserve surplus into sArcoUSD (distribute)",
    )
    return {
      ok: true,
      preview,
      transaction: {
        ...transaction,
        simulation:
          "amountUsd" in preview
            ? { status: "simulated", reason: `eth_call at block ${preview.blockNumber}: mints ${preview.amountUsd} ArcoUSD` }
            : { status: "failed", reason: preview.error },
      },
    }
  }
}

/** For an app built without the savings admin service: every view answers not-deployed. */
export function inertArcoUSDSavingsAdmin(chainId: number): ArcoUSDSavingsAdmin {
  return new ArcoUSDSavingsAdmin({
    chainId,
    loadRegistry: () => null,
    store: {
      events: async () => {
        throw new Error("ArcoUSD admin store is not configured")
      },
    },
  })
}

// ─────────────────────────────── helpers ───────────────────────────────

function parseDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_DAYS
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : DEFAULT_DAYS
}

function big(value: unknown): bigint {
  try {
    return typeof value === "bigint" ? value : BigInt(String(value ?? "0"))
  } catch {
    return 0n
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : ""
}

function usd(base18: bigint): string {
  return formatUnits(base18, 18)
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function startOfUtcDay(ms: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}
