import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type PublicClient } from "viem"
import { unsignedAdminTransaction, type UnsignedAdminTransaction } from "../evm/admin-transactions.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD } from "./registry.js"
import { scrubUrls } from "./safe-error.js"

// ArcoUSD Reserve recalls in the vault-admin redemption flow (docs/specs/arcousd-v1.md §3.7).
//
// Reserve.requestRecall files an ordinary requestRedeem on a product's redemption vault, so the
// core indexer records it like a customer redemption whose SENDER is the Reserve (only the
// Reserve can be that sender; anyone could name it as a recipient). The console treats it apart:
//   • paid by direct transfer (payout → settle → SETTLED): the Reserve still counts the amount
//     as pendingRecall on top of the cash it received, so backing is overstated until
//     acknowledgeRecallPaid(strategyId, requestId) — signed by a RESERVE_MANAGER wallet;
//   • paid through fulfillRedeem (FULFILLED): the funds wait in the vault until
//     claimRecall(strategyId, requestId) (permissionless) pulls them into the Reserve.
// Acknowledging BEFORE payment would understate backing, so the server only builds that
// transaction for a SETTLED row whose exact amount the chain still counts as pending, on the
// strategy whose redemption vault is the row's vault.

export const reserveRecallAbi = parseAbi([
  "function recallRequests(uint256 strategyId, uint256 vaultRequestId) view returns (uint256)",
  "function recallOpen(uint256 strategyId, uint256 vaultRequestId) view returns (bool)",
  "struct Strategy { address asset; address depositVault; address redemptionVault; address productToken; address priceFeed; bool enabled; uint256 maxAllocation; uint256 pendingRecall; }",
  "function getStrategy(uint256 strategyId) view returns (Strategy)",
  "function acknowledgeRecallPaid(uint256 strategyId, uint256 vaultRequestId)",
  "function claimRecall(uint256 strategyId, uint256 vaultRequestId) returns (uint256 assetsReceived)",
])

export type RedemptionKind = "customer" | "arcousd-recall"

/** The fields of an IndexedRedemptionRequest row this module reads. */
export type RecallRow = {
  readonly productId?: string
  readonly requestId?: string
  readonly walletAddress?: string
  readonly redemptionVaultAddress?: string
  readonly status?: string
  readonly lockedAssetsOut?: string
  readonly settledTxHash?: string | null
  readonly createdAt?: Date | string
}

export type RecallChainState = { readonly pending: bigint; readonly open: boolean }

/** Reserve reads, all pinned to one block per snapshot / action. */
export type RecallReader = {
  blockNumber(): Promise<bigint>
  request(deployment: DeployedArcoUSD, strategyId: number, vaultRequestId: bigint, blockNumber: bigint): Promise<RecallChainState>
  /** The strategy's redemption vault (where its recall requests live). */
  strategyVault(deployment: DeployedArcoUSD, strategyId: number, blockNumber: bigint): Promise<string>
}

/**
 * requested / settling: being paid like any redemption (payout or fulfill).
 * awaiting-acknowledgement: SETTLED by direct transfer; the Reserve still counts it as pending.
 * claimable: FULFILLED in the vault; claimRecall moves it into the Reserve.
 * done: acknowledged or claimed.
 */
export type RecallState = "requested" | "settling" | "awaiting-acknowledgement" | "claimable" | "done" | "unknown"

export type RecallView = {
  readonly productId: string
  readonly requestId: string
  readonly strategyId: number | null
  readonly status: string
  readonly state: RecallState
  readonly action: "acknowledge" | "claim" | null
  /** Asset base units the Reserve still counts as pending (string), null when unread. */
  readonly pending: string | null
  readonly open: boolean | null
  readonly lockedAssetsOut: string | null
  readonly settledTxHash: string | null
  readonly createdAt: string | null
  /** An inconsistency the operator should look at (not an action). */
  readonly warning: string | null
  readonly error: string | null
}

export type RecallsSnapshot =
  | { readonly status: "not-deployed"; readonly recalls: readonly RecallView[] }
  | { readonly status: "live"; readonly recalls: readonly RecallView[] }
  | { readonly status: "unavailable"; readonly error: string; readonly recalls: readonly RecallView[] }

export type RecallTransactionResult =
  | { readonly ok: true; readonly transaction: UnsignedAdminTransaction }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * What the registry says, kept apart from its validation: recalls are recognised by the Reserve
 * address alone, so an invalid registry still LABELS them (and reports itself unavailable),
 * while every Reserve action needs a fully valid deployment.
 */
type RegistryView =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly error: string }
  | {
      readonly kind: "present"
      readonly reserve: string | null
      readonly strategyIds: ReadonlyMap<string, number | null>
      readonly deployment: DeployedArcoUSD | null
      readonly error: string | null
    }

const SNAPSHOT_CACHE_MS = 5_000
const READ_CONCURRENCY = 4

const sameAddress = (a: string | undefined | null, b: string | undefined | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase())

// Without RPC URLs: their path carries the provider key.
const errorText = (error: unknown) => scrubUrls(error instanceof Error ? error.message : String(error))

export function createRecallReader(client: Pick<PublicClient, "readContract" | "getBlockNumber">): RecallReader {
  return {
    blockNumber: () => client.getBlockNumber(),
    async request(deployment, strategyId, vaultRequestId, blockNumber) {
      const args = [BigInt(strategyId), vaultRequestId] as const
      const [pending, open] = await Promise.all([
        client.readContract({ address: deployment.reserveAddress, abi: reserveRecallAbi, functionName: "recallRequests", args, blockNumber }),
        client.readContract({ address: deployment.reserveAddress, abi: reserveRecallAbi, functionName: "recallOpen", args, blockNumber }),
      ])
      return { pending: BigInt(pending), open: Boolean(open) }
    },
    async strategyVault(deployment, strategyId, blockNumber) {
      const strategy = await client.readContract({
        address: deployment.reserveAddress,
        abi: reserveRecallAbi,
        functionName: "getStrategy",
        args: [BigInt(strategyId)],
        blockNumber,
      })
      return String((strategy as { redemptionVault: string }).redemptionVault)
    },
  }
}

const DOUBLE_PAID =
  "Paid twice: a direct-transfer payout was settled AND the vault fulfilled this recall. Return the extra payment to the product."

/** Derived state for one recall row given the Reserve's view of it (null = not read). */
export function recallStateOf(
  status: string | undefined,
  chain: RecallChainState | null,
  settledTxHash: string | null = null,
): Pick<RecallView, "state" | "action" | "warning"> {
  if (status === "REQUESTED" || status === "SETTLING") {
    // Open but no longer pending = acknowledged before it was paid (a claimed recall is not open).
    const warning =
      chain && chain.open && chain.pending === 0n
        ? "The Reserve no longer counts this recall as pending although it is not paid yet: backing is understated until it is paid."
        : null
    return { state: status === "REQUESTED" ? "requested" : "settling", action: null, warning }
  }
  // Terminal on its own. A double payment is flagged while the recall is still claimable
  // (FULFILLED); once claimed it is history for reconciliation, not a standing alarm.
  if (status === "CLAIMED") return { state: "done", action: null, warning: null }
  if (!chain) return { state: "unknown", action: null, warning: null }
  if (status === "SETTLED") {
    return chain.pending > 0n
      ? { state: "awaiting-acknowledgement", action: "acknowledge", warning: null }
      : { state: "done", action: null, warning: null }
  }
  if (status === "FULFILLED") {
    const warning = settledTxHash ? DOUBLE_PAID : null
    return chain.open ? { state: "claimable", action: "claim", warning } : { state: "done", action: null, warning }
  }
  return { state: "unknown", action: null, warning: null }
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export class ArcoUSDRecalls {
  private cache: { at: number; value: RecallsSnapshot; seq: number } | null = null
  private inflight: Promise<RecallsSnapshot> | null = null
  private seq = 0
  /** Reads numbered below this started before the last invalidation / fresh read. */
  private staleBelow = 0

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly read?: RecallReader
      readonly now?: () => number
    },
  ) {}

  // Never throws: the pending list and every settle call this, customers included.
  private registry(): RegistryView {
    let registry: ArcoUSDRegistryFile | null
    try {
      registry = this.deps.loadRegistry()
    } catch (error) {
      return { kind: "unreadable", error: `ArcoUSD registry is unreadable: ${errorText(error)}` }
    }
    if (!registry) return { kind: "absent" }
    if (typeof registry !== "object") return { kind: "unreadable", error: "ArcoUSD registry is not an object" }
    const reserveProxy = (registry.reserve as { proxy?: unknown } | null | undefined)?.proxy
    const reserve = typeof reserveProxy === "string" && isAddress(reserveProxy, { strict: false }) ? reserveProxy : null
    const strategyIds = new Map<string, number | null>()
    for (const strategy of Array.isArray(registry.strategies) ? (registry.strategies as unknown[]) : []) {
      if (!strategy || typeof strategy !== "object") continue
      const { productId, strategyId } = strategy as { productId?: unknown; strategyId?: unknown }
      if (typeof productId !== "string") continue
      strategyIds.set(productId, typeof strategyId === "number" && Number.isInteger(strategyId) ? strategyId : null)
    }
    let deployment: DeployedArcoUSD | null = null
    let error: string | null = null
    try {
      deployment = deployedArcoUSD(registry, this.deps.chainId)
    } catch (validationError) {
      error = errorText(validationError)
    }
    return { kind: "present", reserve, strategyIds, deployment, error }
  }

  /** Drop the cached snapshot (after a settle): reads already running can no longer fill the cache. */
  invalidate(): void {
    this.cache = null
    this.inflight = null
    this.staleBelow = this.seq + 1
  }

  /** Deployed and valid, or null. */
  deployment(): DeployedArcoUSD | null {
    const view = this.registry()
    return view.kind === "present" ? view.deployment : null
  }

  /** The Reserve's strategyId for a recall row (null = unmapped), or undefined when the row is not a recall. */
  strategyIdOf(row: RecallRow, view: RegistryView = this.registry()): number | null | undefined {
    if (view.kind !== "present" || !view.reserve || !sameAddress(row.walletAddress, view.reserve)) return undefined
    return (row.productId ? view.strategyIds.get(row.productId) : undefined) ?? null
  }

  /** Adds `kind` (+ `strategyId` for recalls) to redemption rows; other fields untouched. */
  annotate<T extends RecallRow>(rows: readonly T[]): (T & { kind: RedemptionKind; strategyId?: number | null })[] {
    const view = this.registry()
    return rows.map((row) => {
      const strategyId = this.strategyIdOf(row, view)
      return strategyId === undefined ? { ...row, kind: "customer" as const } : { ...row, kind: "arcousd-recall" as const, strategyId }
    })
  }

  /** The Reserve address to look up recall rows by, when the registry names one. */
  reserveAddress(): string | null {
    const view = this.registry()
    return view.kind === "present" ? view.reserve : null
  }

  /**
   * Cached (5s, single-flight) snapshot: one block, bounded parallel reads, never throws.
   * `fresh` skips the cache (the console's refresh right after it sent a Reserve transaction).
   */
  async snapshot(
    loadRows: (reserve: string) => Promise<readonly RecallRow[]>,
    options: { fresh?: boolean } = {},
  ): Promise<RecallsSnapshot> {
    const clock = this.deps.now ?? Date.now
    if (!options.fresh) {
      if (this.cache && clock() - this.cache.at < SNAPSHOT_CACHE_MS) return this.cache.value
      if (this.inflight) return this.inflight
    }
    // A fresh read never joins a read that started before it (and makes those stale); later
    // plain callers join it.
    if (options.fresh) this.invalidate()
    const seq = ++this.seq
    const run: Promise<RecallsSnapshot> = this.load(loadRows)
      .then((value) => {
        // A read older than the newest cached one, or than an invalidation, never fills the cache.
        if (seq >= this.staleBelow && (!this.cache || seq > this.cache.seq)) this.cache = { at: clock(), value, seq }
        return value
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = null
      })
    this.inflight = run
    return run
  }

  private async load(loadRows: (reserve: string) => Promise<readonly RecallRow[]>): Promise<RecallsSnapshot> {
    const view = this.registry()
    if (view.kind === "absent") return { status: "not-deployed", recalls: [] }
    if (view.kind === "unreadable") return { status: "unavailable", error: view.error, recalls: [] }
    if (!view.reserve) {
      return view.error
        ? { status: "unavailable", error: `ArcoUSD registry is invalid: ${view.error}`, recalls: [] }
        : { status: "not-deployed", recalls: [] }
    }
    let rows: readonly RecallRow[]
    try {
      rows = await loadRows(view.reserve)
    } catch (error) {
      return { status: "unavailable", error: `Recall rows could not be read: ${errorText(error)}`, recalls: [] }
    }
    const recalls = await this.view(rows, view)
    if (view.error) return { status: "unavailable", error: `ArcoUSD registry is invalid: ${view.error}`, recalls }
    if (!view.deployment) return { status: "not-deployed", recalls }
    return { status: "live", recalls }
  }

  /** Every Reserve recall row with its on-chain state; a failed read marks that row, never throws. */
  async view(rows: readonly RecallRow[], view: RegistryView = this.registry()): Promise<RecallView[]> {
    if (view.kind !== "present") return []
    const deployment = view.deployment
    const recallRows = rows.filter((row) => this.strategyIdOf(row, view) !== undefined && row.productId && row.requestId)
    if (recallRows.length === 0) return []
    let blockNumber: bigint | null = null
    let blockError: string | null = null
    if (deployment && this.deps.read) {
      try {
        blockNumber = await this.deps.read.blockNumber()
      } catch (error) {
        blockError = `Reserve read failed: ${errorText(error)}`
      }
    }
    const vaults = new Map<number, Promise<string>>()
    const vaultOf = (strategyId: number) => {
      if (!vaults.has(strategyId)) vaults.set(strategyId, this.deps.read!.strategyVault(deployment!, strategyId, blockNumber!))
      return vaults.get(strategyId)!
    }
    return mapLimited(recallRows, READ_CONCURRENCY, async (row) => {
      const strategyId = this.strategyIdOf(row, view) ?? null
      let chain: RecallChainState | null = null
      let error: string | null = null
      if (row.status === "CLAIMED") {
        // Final without any read: never carries a registry or read error.
      } else if (view.error) {
        error = `ArcoUSD registry is invalid: ${view.error}`
      } else if (!deployment) {
        error = "ArcoUSD is not marked deployed"
      } else if (strategyId === null) {
        error = `No ArcoUSD strategy is registered for product ${row.productId}`
      } else if (!this.deps.read) {
        error = "Reserve reader unavailable"
      } else if (blockError) {
        error = blockError
      } else {
        try {
          const vault = await vaultOf(strategyId)
          if (!sameAddress(vault, row.redemptionVaultAddress)) {
            error = `Strategy ${strategyId} redeems through ${vault}, not this request's vault: check the ArcoUSD registry`
          } else {
            chain = await this.deps.read.request(deployment, strategyId, BigInt(row.requestId!), blockNumber!)
          }
        } catch (readError) {
          error = `Reserve read failed: ${errorText(readError)}`
        }
      }
      const derived = recallStateOf(row.status, chain, row.settledTxHash ?? null)
      return {
        productId: row.productId!,
        requestId: row.requestId!,
        strategyId,
        status: row.status ?? "UNKNOWN",
        ...derived,
        // A row that could not be checked never offers an action.
        action: error ? null : derived.action,
        pending: chain ? chain.pending.toString() : null,
        open: chain ? chain.open : null,
        lockedAssetsOut: row.lockedAssetsOut ?? null,
        settledTxHash: row.settledTxHash ?? null,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        error,
      }
    })
  }

  /** acknowledgeRecallPaid: only for a SETTLED (payout verified) recall the Reserve still counts, for exactly its amount. */
  acknowledgeTransaction(row: RecallRow | null): Promise<RecallTransactionResult> {
    return this.build(row, "acknowledge")
  }

  /** claimRecall: only for a FULFILLED recall still open on the Reserve. */
  claimTransaction(row: RecallRow | null): Promise<RecallTransactionResult> {
    return this.build(row, "claim")
  }

  private async build(row: RecallRow | null, action: "acknowledge" | "claim"): Promise<RecallTransactionResult> {
    const view = this.registry()
    if (view.kind === "unreadable") return { ok: false, status: 503, error: view.error }
    if (view.kind === "present" && view.error) return { ok: false, status: 503, error: `ArcoUSD registry is invalid: ${view.error}` }
    const deployment = view.kind === "present" ? view.deployment : null
    if (!deployment) return { ok: false, status: 409, error: "ArcoUSD is not deployed" }
    if (!row || !row.requestId) return { ok: false, status: 404, error: "Redemption request not found" }
    const strategyId = this.strategyIdOf(row, view)
    if (strategyId === undefined) return { ok: false, status: 409, error: "Not an ArcoUSD Reserve recall" }
    if (strategyId === null) return { ok: false, status: 409, error: `No ArcoUSD strategy is registered for product ${row.productId}` }
    const required = action === "acknowledge" ? "SETTLED" : "FULFILLED"
    if (row.status !== required) {
      return {
        ok: false,
        status: 409,
        error:
          action === "acknowledge"
            ? `Recall is ${row.status ?? "unknown"}; acknowledge only after its direct-transfer payout is settled`
            : `Recall is ${row.status ?? "unknown"}; claim only after the vault fulfilled it`,
      }
    }
    if (!this.deps.read) return { ok: false, status: 503, error: "Reserve reader unavailable" }
    const vaultRequestId = BigInt(row.requestId)
    let chain: RecallChainState
    try {
      const blockNumber = await this.deps.read.blockNumber()
      const vault = await this.deps.read.strategyVault(deployment, strategyId, blockNumber)
      if (!sameAddress(vault, row.redemptionVaultAddress)) {
        return {
          ok: false,
          status: 409,
          error: `Strategy ${strategyId} redeems through ${vault}, not this request's vault: check the ArcoUSD registry`,
        }
      }
      chain = await this.deps.read.request(deployment, strategyId, vaultRequestId, blockNumber)
    } catch (error) {
      return { ok: false, status: 503, error: `Reserve read failed: ${errorText(error)}` }
    }
    if (action === "acknowledge") {
      if (chain.pending === 0n) {
        return { ok: false, status: 409, error: "The Reserve no longer counts this recall as pending (already acknowledged or claimed)" }
      }
      if (!/^\d+$/.test(row.lockedAssetsOut ?? "") || chain.pending !== BigInt(row.lockedAssetsOut!)) {
        return {
          ok: false,
          status: 409,
          error: `The Reserve counts ${chain.pending.toString()} pending for this recall, not the request's locked payout (${row.lockedAssetsOut ?? "unknown"})`,
        }
      }
    }
    if (action === "claim" && !chain.open) {
      return { ok: false, status: 409, error: "The Reserve has no open recall to claim for this request" }
    }
    const functionName = action === "acknowledge" ? "acknowledgeRecallPaid" : "claimRecall"
    return {
      ok: true,
      transaction: unsignedAdminTransaction(
        deployment.chainId,
        getAddress(deployment.reserveAddress) as Address,
        encodeFunctionData({ abi: reserveRecallAbi, functionName, args: [BigInt(strategyId), vaultRequestId] }),
        action === "acknowledge"
          ? `ArcoUSD Reserve: acknowledge the direct-transfer payout of recall ${row.requestId} (${row.productId}, strategy ${strategyId})`
          : `ArcoUSD Reserve: claim fulfilled recall ${row.requestId} (${row.productId}, strategy ${strategyId})`,
      ),
    }
  }
}
