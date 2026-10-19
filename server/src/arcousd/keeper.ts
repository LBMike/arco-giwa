import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  toEventSelector,
  type Hex,
  type PublicClient,
} from "viem"
import { distributorAbi, distributorEventsAbi } from "./abi.js"
import { processQueueAbi } from "./admin.js"
import { KEEPER_HEARTBEAT, type ArcoUSDAlertStore } from "./alerts.js"
import { maxTransactionFee, type ArcoUSDKeeperEnv, type KeeperMode } from "./keeper-config.js"
import type { ArcoUSDChainReader, AssetState } from "./reader.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD, type DeployedSavings } from "./registry.js"
import { safeErrorText } from "./safe-error.js"
import { distributeRevertReason } from "./savings-admin.js"
import { DISTRIBUTE_MIN_AMOUNT } from "./savings.js"
import { payoutsPaused } from "./watch.js"

// ArcoUSD keeper (docs/operations/arcousd-keeper.md). Two permissionless jobs, so nothing waits on
// someone pressing a button:
//   1. the Standard redemption queue (the T+2 promise): every interval it asks the chain (eth_call)
//      how many requests processQueue would pay for each asset with a backlog, and in `live` mode
//      sends processQueue for those that would pay at least one;
//   2. Savings yield: once the distributor's interval has passed and preview() shows at least a cent,
//      it dry-runs distribute() and, in `live` mode, sends it (ARCOUSD_KEEPER_DISTRIBUTE=off skips this).
// One transaction in flight at a time, the queue first, each followed to its receipt before the next.
// `dry-run` stops after the questions; `off` does nothing.
//
// Both calls are permissionless: the keeper wallet holds no role, only gas (the launcher refuses a
// wallet that holds one). The signer below signs nothing but Reserve.processQueue(<registry asset>,
// 1..50) and <registry distributor>.distribute() on chain 91342 with value 0, within the fee ceilings
// the custody enforces. It never allocates or recalls MMF funds (operator approval) and never creates
// liquidity or yield: when the Reserve is short the queue waits, and with no surplus nothing is
// distributed (the watcher says so).

export { KEEPER_HEARTBEAT }
const REDEEM_PAID_TOPIC = toEventSelector("RedeemPaid(uint256,address,address,uint256)")
const DISTRIBUTED_TOPIC = toEventSelector("Distributed(address,uint256,uint256,uint256,uint256,uint256)")
/** The one distributor call the keeper makes (no arguments: there is exactly one valid calldata). */
const DISTRIBUTE_DATA = encodeFunctionData({ abi: distributorAbi, functionName: "distribute" })
const SAVINGS_SYMBOL = "sArcoUSD"
const RECEIPT_WAIT_MS = 45_000
const RECEIPT_POLL_MS = 1_500
/** A transaction from the keeper wallet pending this long is reported as stuck. */
export const KEEPER_STUCK_MS = 10 * 60_000
/** Unknown to the node and not mined this long after sending: dropped. */
const DROPPED_AFTER_MS = 2 * 60_000
/** After a reverted transaction the keeper only simulates for this long (no gas burnt on a loop of reverts). */
export const KEEPER_REVERT_HOLD_MS = 10 * 60_000
/** processQueue's own cap the signer allows; used to step past cancelled / failed entries. */
const MAX_BATCH = 50
/** How far a "look past the batch" eth_call may walk the queue (skips cost ~5k gas each). */
const WIDE_LOOK = 200

export type KeeperReceipt = {
  readonly status: "success" | "reverted"
  readonly blockNumber: bigint
  readonly logs: readonly { readonly address: string; readonly topics: readonly Hex[]; readonly data?: Hex }[]
}

export type KeeperRpc = {
  chainId(): Promise<number>
  balance(address: `0x${string}`): Promise<bigint>
  nonce(address: `0x${string}`, tag: "latest" | "pending"): Promise<number>
  /** eth_call of processQueue from the keeper wallet with the keeper's gas limit: requests it would pay. */
  simulate(input: { from: `0x${string}`; reserve: `0x${string}`; asset: `0x${string}`; maxCount: number; gas: bigint }): Promise<bigint>
  /** distributor.preview(): what distribute() would mint now, and the earliest time it may run (unix seconds). */
  distributorPreview(distributor: `0x${string}`): Promise<{ amount: bigint; nextAt: bigint }>
  /** eth_call of distribute() from the keeper wallet: the amount, or the decoded revert reason. Throws only when the chain could not be asked. */
  simulateDistribute(input: { from: `0x${string}`; distributor: `0x${string}`; gas: bigint }): Promise<{ ok: true; amount: bigint } | { ok: false; revert: string }>
  sendRaw(raw: Hex): Promise<Hex>
  /** null while not mined. */
  receipt(hash: Hex): Promise<KeeperReceipt | null>
  /** Whether the node knows the transaction at all (pending or mined); null when it does not. */
  transaction(hash: Hex): Promise<{ readonly mined: boolean } | null>
}

export type KeeperSignRequest = Readonly<{ chainId: 91342; nonce: bigint; to: `0x${string}`; data: Hex; value: 0n }>
export type KeeperSigner = { readonly address: `0x${string}`; sign(request: KeeperSignRequest): Promise<Hex> }

export type KeeperAction = "processQueue" | "distribute"

export type KeeperTx = {
  readonly hash: Hex
  /** Absent in reports written before Savings: processQueue. */
  readonly action?: KeeperAction
  /** The asset paid (processQueue), or "sArcoUSD" (distribute). */
  readonly symbol: string
  readonly asset?: string
  readonly nonce: number
  readonly sentAt: string
  readonly status: "pending" | "success" | "reverted" | "replaced" | "failed"
  /** RedeemPaid events in the receipt (processQueue). */
  readonly paid: number | null
  /** ArcoUSD minted into sArcoUSD, from the receipt's Distributed event (distribute): base18, and in ArcoUSD. */
  readonly amount?: string | null
  readonly amountUsd?: string | null
  readonly blockNumber: string | null
  readonly error: string | null
}

/**
 * The Savings step of a round. off: ARCOUSD_KEEPER_DISTRIBUTE=off · not-deployed: no Savings in the
 * registry · waiting: before the distributor's next time · nothing: due, under a cent · ready: due and
 * the dry run passes, not sent this round (dry run, hold, no gas, a failed send) · sent: sent this
 * round · reverts: the dry run reverts (`detail` says why) · error: the chain could not be asked.
 */
export type KeeperDistribute = {
  readonly state: "off" | "not-deployed" | "waiting" | "nothing" | "ready" | "sent" | "reverts" | "error"
  /** When distribute() may next run (preview's nextAt). */
  readonly nextAt: string | null
  /** What it would mint (preview, or the dry run), or what it minted; in ArcoUSD. */
  readonly amountUsd: string | null
  readonly detail: string | null
}

export type KeeperSimulation = {
  readonly symbol: string
  readonly paid: number | null
  readonly error: string | null
  /** Pays nothing within the batch, but cancelled / failed entries hide payable requests behind them. */
  readonly clearing?: boolean
}

export type KeeperReport = {
  readonly mode: KeeperMode
  readonly address: string | null
  readonly intervalMs: number
  readonly batch: number
  readonly gasBalanceWei: string | null
  /** ARCOUSD_KEEPER_LOW_GAS_WEI: below it the watcher warns. */
  readonly lowGasWei: string
  readonly lowGas: boolean | null
  /** The balance covers one transaction at the fee ceiling. */
  readonly canAffordTx: boolean | null
  /** false when this round stopped before asking the chain (waiting, paused, …). */
  readonly simulated: boolean
  readonly simulations: readonly KeeperSimulation[]
  readonly lastTx: KeeperTx | null
  /** A transaction from the keeper wallet not mined yet (hash null: not sent by this process). */
  readonly pending: { readonly hash: string | null; readonly nonce: number; readonly since: string; readonly stuck: boolean } | null
  /** Simulating only until then, after a reverted processQueue. */
  readonly holdUntil: string | null
  /** The Savings step; null when off, or when the round stopped before it. */
  readonly distribute: KeeperDistribute | null
  /** No distribute() until then, after a reverted one (the queue is not held by it). */
  readonly distributeHoldUntil: string | null
  readonly note: string | null
}

export type KeeperTick = KeeperReport & { readonly ok: boolean; readonly error: string | null; readonly sent: number }

/** `raw`: the signed bytes, kept in memory to re-broadcast the very same transaction if a node drops it. */
type Inflight = { action: KeeperAction; hash: Hex; nonce: number; symbol: string; asset?: `0x${string}`; sentAt: number; raw?: Hex }
type Payable = { symbol: string; asset: `0x${string}`; maxCount: number }
/** One transaction to sign: the call and what it is for. */
type Call = { action: KeeperAction; to: `0x${string}`; data: Hex; symbol: string; asset?: `0x${string}` }

export class ArcoUSDKeeper {
  private inflight: Inflight | null = null
  private lastTx: KeeperTx | null = null
  private foreignPendingSince: number | null = null
  private holdUntil = 0
  private distributeHoldUntil = 0
  private preferAsset: string | null = null
  private rotation = 0
  private restored = false

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly config: ArcoUSDKeeperEnv
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly readState: ArcoUSDChainReader
      readonly rpc: KeeperRpc
      /** Required in live mode only. */
      readonly signer: KeeperSigner | null
      readonly store: Pick<ArcoUSDAlertStore, "beat" | "heartbeat">
      readonly now?: () => number
      readonly sleep?: (ms: number) => Promise<void>
      readonly receiptWaitMs?: number
    },
  ) {
    if (deps.config.mode === "live" && (!deps.signer || !deps.config.address || getAddress(deps.signer.address) !== deps.config.address)) {
      throw new Error("Live mode needs the keeper signer for ARCOUSD_KEEPER_ADDRESS")
    }
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  /** One round; never throws (the outcome, and any error made safe, go to the heartbeat and back). */
  async tick(): Promise<KeeperTick> {
    const config = this.deps.config
    const report = {
      mode: config.mode,
      address: config.address,
      intervalMs: config.intervalMs,
      batch: config.batch,
      gasBalanceWei: null as string | null,
      lowGasWei: config.lowGasWei.toString(),
      lowGas: null as boolean | null,
      canAffordTx: null as boolean | null,
      simulated: false,
      simulations: [] as KeeperSimulation[],
      pending: null as KeeperReport["pending"],
      distribute: null as KeeperDistribute | null,
      note: null as string | null,
    }
    let sent = 0
    const snapshot = (note: string | null, ok: boolean, error: string | null): KeeperTick => {
      const until = (at: number) => (at > this.now() ? new Date(at).toISOString() : null)
      return { ...report, note, lastTx: this.lastTx, holdUntil: until(this.holdUntil), distributeHoldUntil: until(this.distributeHoldUntil), ok, error, sent }
    }
    const beat = (result: KeeperTick, keepStoredData = false) =>
      this.deps.store
        .beat(this.deps.chainId, KEEPER_HEARTBEAT, {
          at: new Date(this.now()),
          ok: result.ok,
          error: result.error ?? undefined,
          // undefined leaves the stored report as it is (see PrismaArcoUSDAlertStore.beat)
          data: keepStoredData ? undefined : { ...result, ok: undefined, error: undefined, sent: undefined },
        })
        .catch(() => undefined)
    const finish = async (ok: boolean, error: string | null, note: string | null = report.note): Promise<KeeperTick> => {
      const result = snapshot(note, ok, error)
      await beat(result)
      return result
    }

    // Restored even when off, so switching off and on again keeps the last transaction. Until the last
    // state is read, nothing is sent and the stored state is not overwritten (a hold or an in-flight
    // transaction recorded by the previous process must not be lost to a database blip).
    await this.restore()
    if (!this.restored) {
      const result = snapshot("Could not read the keeper's last state; trying again next round", false, "Keeper state unreadable")
      await beat(result, true)
      return result
    }
    if (config.mode === "off") return finish(true, null, "Off: set ARCOUSD_KEEPER_MODE to dry-run or live")

    let deployment: DeployedArcoUSD | null
    try {
      deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
    } catch (error) {
      return finish(false, `ArcoUSD registry is invalid: ${safeErrorText(error)}`)
    }
    if (!deployment) return finish(true, null, "ArcoUSD is not deployed")
    const address = config.address!

    try {
      const balance = await this.deps.rpc.balance(address)
      report.gasBalanceWei = balance.toString()
      report.lowGas = balance < config.lowGasWei
      report.canAffordTx = balance >= maxTransactionFee(config)

      const errors: string[] = []
      const done = (note: string | null) => finish(errors.length === 0, errors.length ? errors.join("; ") : null, note)
      // A revert is reported once per job and round: the hold it starts is the same news.
      const reverted = { queue: false, distribute: false }
      const onRevert = (tx: KeeperTx) => {
        errors.push(this.revertError(tx))
        reverted[tx.action === "distribute" ? "distribute" : "queue"] = true
      }

      // One transaction in flight at a time: settle it (or keep waiting) before anything else.
      const [latestNonce, pendingNonce] = await Promise.all([this.deps.rpc.nonce(address, "latest"), this.deps.rpc.nonce(address, "pending")])
      if (this.inflight) {
        const outcome = await this.settleInflight(deployment, latestNonce)
        if (outcome.kind === "waiting") {
          report.pending = outcome.pending
          return finish(true, null, "Waiting for the last transaction")
        }
        // Held from now on (that job only); the other job still runs this round.
        if (outcome.kind === "reverted") onRevert(outcome.tx)
      }
      if (pendingNonce > latestNonce) {
        // A pending transaction this process did not send (a restart lost it, or a manual send).
        this.foreignPendingSince ??= this.now()
        report.pending = {
          hash: null,
          nonce: latestNonce,
          since: new Date(this.foreignPendingSince).toISOString(),
          stuck: this.now() - this.foreignPendingSince > KEEPER_STUCK_MS,
        }
        return done("A transaction from the keeper wallet is pending; waiting for it")
      }
      this.foreignPendingSince = null

      let nonce = latestNonce
      // Recorded right after signing, before the broadcast: a worker killed mid-wait still leaves the
      // hash in the heartbeat for the next start to follow.
      const checkpoint = () => beat(snapshot("Sending", true, null))
      const cannotAfford = "The keeper wallet cannot cover one transaction at the fee ceiling: top up its gas"

      // ── 1. The redemption queue ── (a failure here is reported, and Savings is still checked)
      let note = ""
      const sentNote = () => `Sent ${sent} transaction${sent === 1 ? "" : "s"}`
      try {
        queue: {
          const state = await this.deps.readState(deployment)
          if (payoutsPaused(state)) {
            note = "Payouts are paused (Reserve, processQueue, ArcoUSD or burn)"
            break queue
          }
          const reserve = getAddress(deployment.reserveAddress)
          const queued = state.assets.filter((asset) => asset.queueBacklog > 0)
          const payable: Payable[] = []
          report.simulated = true
          for (const asset of queued) {
            const found = await this.look(address, reserve, asset)
            report.simulations.push(found.simulation)
            if (found.payable) payable.push(found.payable)
          }
          const simulationError = report.simulations.find((simulation) => simulation.error)?.error ?? null
          if (simulationError) errors.push(`Simulation failed: ${simulationError}`)
          const clearing = payable.filter((item) => item.maxCount === MAX_BATCH && report.simulations.find((sim) => sim.symbol === item.symbol)?.clearing)
          if (config.mode === "dry-run" || !payable.length) {
            note = !queued.length
              ? "Queue empty"
              : payable.length
                ? `Dry run: would pay ${payable.map((item) => item.symbol).join(", ")}${clearing.length ? " (stepping past cancelled or failed entries first)" : ""}`
                : "Nothing payable now (in delay, or the Reserve is short)"
            break queue
          }
          if (!report.canAffordTx) {
            note = "Payable, not sent: no gas"
            errors.unshift(cannotAfford)
            break queue
          }
          if (this.now() < this.holdUntil) {
            // Not ok: a keeper that keeps reverting must surface (watcher `keeper:failing`), not look healthy.
            note = "Payable, holding"
            if (!reverted.queue) errors.unshift(`Holding after a reverted transaction until ${new Date(this.holdUntil).toISOString()} (simulating only)`)
            break queue
          }

          // Live: in turn, starting from a rotating asset so one busy asset cannot starve the others — or
          // from the asset of a dropped transaction, so its nonce is reused for the very same call.
          const start = this.rotation++ % payable.length
          let ordered = [...payable.slice(start), ...payable.slice(0, start)]
          if (this.preferAsset) {
            const preferred = this.preferAsset
            ordered = [...ordered.filter((item) => item.asset === preferred), ...ordered.filter((item) => item.asset !== preferred)]
            this.preferAsset = null
          }
          for (const item of ordered) {
            const data = encodeFunctionData({ abi: processQueueAbi, functionName: "processQueue", args: [item.asset, BigInt(item.maxCount)] })
            const call: Call = { action: "processQueue", to: reserve, data, symbol: item.symbol, asset: item.asset }
            const outcome = await this.send(deployment, call, nonce, checkpoint)
            if (outcome.kind === "mined") {
              sent++
              nonce++
              if (outcome.tx.status === "reverted") {
                onRevert(outcome.tx)
                note = sentNote()
                break queue
              }
              continue
            }
            if (outcome.kind === "pending") {
              sent++
              report.pending = outcome.pending
              return done("Sent; waiting for the receipt")
            }
            // Not sent (signing refused, or the node never took it): its nonce is still free.
            errors.push(outcome.error)
            note = sentNote()
            break queue
          }
          note = sentNote()
        }
      } catch (error) {
        // A transaction out of this step is settled next round before anything else is sent.
        if (this.inflight) throw error
        note = "Could not check the queue"
        errors.unshift(safeErrorText(error))
      }

      // ── 2. Savings: distribute() once it is due ──
      const savings = deployment.savings
      if (!config.distribute) {
        report.distribute = { state: "off", nextAt: null, amountUsd: null, detail: "ARCOUSD_KEEPER_DISTRIBUTE=off: distribute from the console" }
      } else if (!savings) {
        report.distribute = { state: "not-deployed", nextAt: null, amountUsd: null, detail: "Savings is not deployed" }
      } else {
        const check = await this.checkDistribute(address, savings)
        report.distribute = check
        if (check.state === "error") errors.push(`Savings: ${check.detail}`)
        if (check.state === "ready") {
          if (config.mode === "dry-run") {
            report.distribute = { ...check, detail: "Dry run: would distribute" }
          } else if (!report.canAffordTx) {
            report.distribute = { ...check, detail: "Not sent: no gas" }
            if (!errors.includes(cannotAfford)) errors.unshift(cannotAfford)
          } else if (this.now() < this.distributeHoldUntil) {
            const until = new Date(this.distributeHoldUntil).toISOString()
            report.distribute = { ...check, detail: "Held after a reverted distribute()" }
            if (!reverted.distribute) errors.push(`Holding Savings distributions after a reverted distribute() until ${until}`)
          } else {
            const call: Call = { action: "distribute", to: getAddress(savings.distributorAddress), data: DISTRIBUTE_DATA, symbol: SAVINGS_SYMBOL }
            const outcome = await this.send(deployment, call, nonce, checkpoint)
            if (outcome.kind === "mined") {
              sent++
              nonce++
              if (outcome.tx.status === "reverted") {
                onRevert(outcome.tx)
                report.distribute = { ...check, state: "sent", detail: "Reverted; holding Savings distributions for 10 minutes" }
              } else {
                report.distribute = { ...check, state: "sent", amountUsd: outcome.tx.amountUsd ?? check.amountUsd, detail: "Distributed" }
              }
            } else if (outcome.kind === "pending") {
              sent++
              report.pending = outcome.pending
              report.distribute = { ...check, state: "sent", detail: "Sent; waiting for the receipt" }
              return done(note)
            } else {
              report.distribute = { ...check, detail: outcome.error }
              errors.push(outcome.error)
            }
          }
        }
      }
      return done(note)
    } catch (error) {
      return finish(false, safeErrorText(error))
    }
  }

  /**
   * Whether distribute() is due and would mint at least a cent. preview() first (one eth_call, and the
   * next time for the console); only when due, a dry run from the keeper wallet — the authority on
   * pauses and the caps. A revert is a reading (nothing to do now, the watcher judges it), not a failure.
   */
  private async checkDistribute(from: `0x${string}`, savings: DeployedSavings): Promise<KeeperDistribute> {
    const distributor = getAddress(savings.distributorAddress)
    let preview: { amount: bigint; nextAt: bigint }
    try {
      preview = await this.deps.rpc.distributorPreview(distributor)
    } catch (error) {
      return { state: "error", nextAt: null, amountUsd: null, detail: `preview() could not be read: ${safeErrorText(error)}` }
    }
    const nextAtMs = Number(preview.nextAt) * 1000
    const nextAt = Number.isSafeInteger(nextAtMs) ? new Date(nextAtMs).toISOString() : null
    const amountUsd = formatUnits(preview.amount, 18)
    if (nextAt === null || nextAtMs > this.now()) return { state: "waiting", nextAt, amountUsd, detail: null }
    if (preview.amount < DISTRIBUTE_MIN_AMOUNT) return { state: "nothing", nextAt, amountUsd, detail: "Nothing to distribute now (under $0.01)" }
    try {
      const simulated = await this.deps.rpc.simulateDistribute({ from, distributor, gas: this.deps.config.gasLimit })
      if (!simulated.ok) return { state: "reverts", nextAt, amountUsd, detail: simulated.revert }
      if (simulated.amount < DISTRIBUTE_MIN_AMOUNT) {
        return { state: "nothing", nextAt, amountUsd: formatUnits(simulated.amount, 18), detail: "Nothing to distribute now (under $0.01)" }
      }
      return { state: "ready", nextAt, amountUsd: formatUnits(simulated.amount, 18), detail: null }
    } catch (error) {
      return { state: "error", nextAt, amountUsd, detail: `distribute() could not be simulated: ${safeErrorText(error)}` }
    }
  }

  /**
   * What processQueue would do for one asset. Pays ≥ 1 within the batch: send the batch. Pays nothing,
   * yet Queued requests exist beyond the batch: cancelled / failed entries may fill the window — if a
   * wider look pays, send the largest batch to step past them (it pays nothing itself, but unblocks).
   */
  private async look(from: `0x${string}`, reserve: `0x${string}`, asset: AssetState): Promise<{ simulation: KeeperSimulation; payable: Payable | null }> {
    const config = this.deps.config
    const assetAddress = getAddress(asset.address)
    const simulate = (maxCount: number) => this.deps.rpc.simulate({ from, reserve, asset: assetAddress, maxCount, gas: config.gasLimit })
    try {
      const paid = await simulate(config.batch)
      if (paid > 0n) return { simulation: { symbol: asset.symbol, paid: Number(paid), error: null }, payable: { symbol: asset.symbol, asset: assetAddress, maxCount: config.batch } }
      if (BigInt(asset.queued) > 0n && asset.queueBacklog > config.batch) {
        const wider = await simulate(Math.min(asset.queueBacklog, WIDE_LOOK)).catch(() => 0n)
        if (wider > 0n) {
          return {
            simulation: { symbol: asset.symbol, paid: 0, error: null, clearing: true },
            payable: { symbol: asset.symbol, asset: assetAddress, maxCount: MAX_BATCH },
          }
        }
      }
      return { simulation: { symbol: asset.symbol, paid: 0, error: null }, payable: null }
    } catch (error) {
      return { simulation: { symbol: asset.symbol, paid: null, error: safeErrorText(error) }, payable: null }
    }
  }

  /** Holds the job whose transaction reverted (the other job carries on). */
  private revertError(tx: KeeperTx): string {
    if (tx.action === "distribute") {
      this.distributeHoldUntil = this.now() + KEEPER_REVERT_HOLD_MS
      return `distribute() reverted (${tx.hash}); holding Savings distributions for 10 minutes`
    }
    this.holdUntil = this.now() + KEEPER_REVERT_HOLD_MS
    return `processQueue for ${tx.symbol} reverted (${tx.hash}); holding for 10 minutes`
  }

  private async send(
    deployment: DeployedArcoUSD,
    call: Call,
    nonce: number,
    checkpoint: () => Promise<unknown>,
  ): Promise<{ kind: "mined"; tx: KeeperTx } | { kind: "pending"; pending: NonNullable<KeeperReport["pending"]> } | { kind: "failed"; error: string }> {
    let raw: Hex
    try {
      raw = await this.deps.signer!.sign({ chainId: 91342, nonce: BigInt(nonce), to: call.to, data: call.data, value: 0n })
    } catch (error) {
      return { kind: "failed", error: `Signing refused: ${safeErrorText(error)}` }
    }
    const hash = keccak256(raw)
    const sentAt = this.now()
    this.inflight = { action: call.action, hash, nonce, symbol: call.symbol, asset: call.asset, sentAt, raw }
    this.lastTx = {
      hash,
      action: call.action,
      symbol: call.symbol,
      ...(call.asset ? { asset: call.asset } : {}),
      nonce,
      sentAt: new Date(sentAt).toISOString(),
      status: "pending",
      paid: null,
      blockNumber: null,
      error: null,
    }
    await checkpoint()
    try {
      await this.deps.rpc.sendRaw(raw)
    } catch (error) {
      // The node may have taken it anyway (a timeout after acceptance): follow it only if the node
      // knows this exact transaction.
      const known = await this.deps.rpc.transaction(hash).catch(() => null)
      if (!known) {
        this.inflight = null
        this.lastTx = { ...this.lastTx, status: "failed", error: safeErrorText(error) }
        return { kind: "failed", error: `Send failed: ${safeErrorText(error)}` }
      }
    }
    const deadline = this.now() + (this.deps.receiptWaitMs ?? RECEIPT_WAIT_MS)
    for (;;) {
      const receipt = await this.deps.rpc.receipt(hash).catch(() => null)
      if (receipt) return { kind: "mined", tx: this.settled(deployment, receipt) }
      if (this.now() >= deadline) break
      await this.sleep(RECEIPT_POLL_MS)
    }
    return { kind: "pending", pending: { hash, nonce, since: new Date(sentAt).toISOString(), stuck: false } }
  }

  /** Settles the in-flight transaction if it is mined, replaced or dropped; else says what is pending. */
  private async settleInflight(
    deployment: DeployedArcoUSD,
    latestNonce: number,
  ): Promise<{ kind: "settled" } | { kind: "reverted"; tx: KeeperTx } | { kind: "waiting"; pending: NonNullable<KeeperReport["pending"]> }> {
    const inflight = this.inflight!
    const receipt = await this.deps.rpc.receipt(inflight.hash)
    if (receipt) {
      const tx = this.settled(deployment, receipt)
      return tx.status === "reverted" ? { kind: "reverted", tx } : { kind: "settled" }
    }
    const waiting = () => ({
      kind: "waiting" as const,
      pending: { hash: inflight.hash, nonce: inflight.nonce, since: new Date(inflight.sentAt).toISOString(), stuck: this.now() - inflight.sentAt > KEEPER_STUCK_MS },
    })
    const known = await this.deps.rpc.transaction(inflight.hash)
    const mine = this.lastTx && this.lastTx.hash === inflight.hash
    if (latestNonce > inflight.nonce) {
      // Its nonce is used. Ours (receipt not served yet by this node) or another transaction's.
      if (known) return waiting()
      if (mine) this.lastTx = { ...this.lastTx!, status: "replaced" }
      this.inflight = null
      return { kind: "settled" }
    }
    if (!known && this.now() - inflight.sentAt > DROPPED_AFTER_MS) {
      // Not mined, nonce unused, unknown to the node: dropped. Broadcast the very same signed bytes
      // again when this process still has them; after a restart (bytes gone) the nonce is freed for the
      // next send, preferring the same asset — another call at that nonce is safe (one per nonce mines).
      if (inflight.raw) {
        const rebroadcast = await this.deps.rpc.sendRaw(inflight.raw).then(
          () => true,
          () => false,
        )
        if (rebroadcast) {
          inflight.sentAt = this.now()
          return waiting()
        }
      }
      if (mine) this.lastTx = { ...this.lastTx!, status: "failed", error: "Dropped before it was mined" }
      if (inflight.asset) this.preferAsset = inflight.asset
      this.inflight = null
      return { kind: "settled" }
    }
    return waiting()
  }

  private settled(deployment: DeployedArcoUSD, receipt: KeeperReceipt): KeeperTx {
    const inflight = this.inflight!
    const base = {
      hash: inflight.hash,
      action: inflight.action,
      symbol: inflight.symbol,
      ...(inflight.asset ? { asset: inflight.asset } : {}),
      nonce: inflight.nonce,
      sentAt: new Date(inflight.sentAt).toISOString(),
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      error: null,
    }
    let tx: KeeperTx
    if (inflight.action === "distribute") {
      const amount = distributedAmount(receipt, deployment.savings?.distributorAddress ?? null)
      tx = { ...base, paid: null, amount: amount?.toString() ?? null, amountUsd: amount === null ? null : formatUnits(amount, 18) }
    } else {
      const reserve = deployment.reserveAddress.toLowerCase()
      tx = { ...base, paid: receipt.logs.filter((log) => log.address.toLowerCase() === reserve && log.topics[0] === REDEEM_PAID_TOPIC).length }
    }
    this.lastTx = tx
    this.inflight = null
    return tx
  }

  // After a restart: keep showing the last transaction, keep waiting on it if it was pending, and keep
  // a revert hold. A failed read is retried next round (an in-flight record must not be lost to a blip).
  private async restore() {
    if (this.restored) return
    let beat: Awaited<ReturnType<ArcoUSDAlertStore["heartbeat"]>>
    try {
      beat = await this.deps.store.heartbeat(this.deps.chainId, KEEPER_HEARTBEAT)
    } catch {
      return
    }
    this.restored = true
    const data = (beat?.data ?? null) as { lastTx?: KeeperTx | null; holdUntil?: string | null; distributeHoldUntil?: string | null } | null
    const hold = data?.holdUntil ? Date.parse(data.holdUntil) : Number.NaN
    if (Number.isFinite(hold)) this.holdUntil = Math.max(this.holdUntil, hold)
    const distributeHold = data?.distributeHoldUntil ? Date.parse(data.distributeHoldUntil) : Number.NaN
    if (Number.isFinite(distributeHold)) this.distributeHoldUntil = Math.max(this.distributeHoldUntil, distributeHold)
    const last = data?.lastTx
    if (!last || !/^0x[0-9a-f]{64}$/.test(last.hash)) return
    this.lastTx = last
    if (last.status !== "pending") return
    const sentAt = Date.parse(last.sentAt) || this.now()
    if (last.action === "distribute") {
      this.inflight = { action: "distribute", hash: last.hash, nonce: last.nonce, symbol: last.symbol, sentAt }
    } else if (last.asset && /^0x[0-9a-fA-F]{40}$/.test(last.asset)) {
      this.inflight = { action: "processQueue", hash: last.hash, nonce: last.nonce, symbol: last.symbol, asset: getAddress(last.asset), sentAt }
    }
  }
}

/**
 * The keeper's only signing path: Reserve.processQueue(<registry asset>, 1..50) or
 * <registry distributor>.distribute(), chain 91342, value 0. Anything else is refused before the
 * custody sees it; the custody then checks the signed bytes (signer, nonce, target, data, value and
 * fee ceilings) before they can be sent.
 */
export function guardedKeeperSigner(input: {
  readonly address: `0x${string}`
  readonly loadRegistry: () => ArcoUSDRegistryFile | null
  readonly chainId: number
  readonly signOriginal: (request: KeeperSignRequest) => Promise<unknown>
}): KeeperSigner {
  const address = getAddress(input.address)
  return {
    address,
    async sign(request) {
      const deployment = deployedArcoUSD(input.loadRegistry(), input.chainId)
      if (!deployment) throw new Error("ArcoUSD is not deployed")
      if (request.chainId !== 91342 || request.value !== 0n) throw new Error("Only chain 91342 and value 0")
      const distributor = deployment.savings ? getAddress(deployment.savings.distributorAddress) : null
      if (distributor !== null && getAddress(request.to) === distributor) {
        if (request.data !== DISTRIBUTE_DATA) throw new Error("Only canonical distribute() calldata to the Savings distributor")
        return signed(await input.signOriginal(request))
      }
      if (getAddress(request.to) !== getAddress(deployment.reserveAddress)) throw new Error("Only the ArcoUSD Reserve or the Savings distributor")
      let call: { functionName: string; args: readonly unknown[] }
      try {
        call = decodeFunctionData({ abi: processQueueAbi, data: request.data }) as typeof call
      } catch {
        throw new Error("Only processQueue")
      }
      if (encodeFunctionData({ abi: processQueueAbi, functionName: "processQueue", args: call.args as [`0x${string}`, bigint] }) !== request.data) {
        throw new Error("Only canonical processQueue calldata")
      }
      const [asset, maxCount] = call.args as [string, bigint]
      const assets = (deployment.reserveAssets ?? []).flatMap((item) => (item.address ? [getAddress(item.address)] : []))
      if (!assets.includes(getAddress(asset))) throw new Error("Only a Reserve asset from the registry")
      if (maxCount < 1n || maxCount > BigInt(MAX_BATCH)) throw new Error("Batch must be 1..50")
      return signed(await input.signOriginal(request))
    },
  }
}

function signed(raw: unknown): Hex {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(raw)) throw new Error("Custody returned no transaction")
  return raw as Hex
}

/** ArcoUSD minted by distribute(), from its Distributed event; null when the receipt has none. */
function distributedAmount(receipt: KeeperReceipt, distributor: string | null): bigint | null {
  if (!distributor) return null
  let total: bigint | null = null
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== distributor.toLowerCase() || log.topics[0] !== DISTRIBUTED_TOPIC || !log.data) continue
    try {
      const event = decodeEventLog({ abi: distributorEventsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
      if (event.eventName === "Distributed") total = (total ?? 0n) + event.args.amount
    } catch {
      // not decodable: leave the amount unknown
    }
  }
  return total
}

const accessAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"])
const role = (name: string) => keccak256(new TextEncoder().encode(name))
const ZERO_ROLE = `0x${"00".repeat(32)}` as Hex

/**
 * Roles the keeper wallet must NOT hold (it needs none): a key with power over the Reserve, ArcoUSD, the
 * Router or Savings (sArcoUSD, its distributor) has no business on a hosted worker. Returns the ones it
 * does hold, e.g. ["Reserve:DEFAULT_ADMIN_ROLE"].
 */
export async function keeperHeldRoles(
  client: Pick<PublicClient, "readContract">,
  deployment: DeployedArcoUSD,
  account: `0x${string}`,
): Promise<string[]> {
  const checks: [string, `0x${string}`, Hex][] = [
    ["Reserve:DEFAULT_ADMIN_ROLE", deployment.reserveAddress, ZERO_ROLE],
    ["Reserve:RESERVE_MANAGER_ROLE", deployment.reserveAddress, role("RESERVE_MANAGER_ROLE")],
    ["Reserve:SETTLER_ROLE", deployment.reserveAddress, role("SETTLER_ROLE")],
    ["Reserve:PAUSER_ROLE", deployment.reserveAddress, role("PAUSER_ROLE")],
    ["ArcoUSD:DEFAULT_ADMIN_ROLE", deployment.arcoUSDAddress, ZERO_ROLE],
    ["ArcoUSD:MINTER_ROLE", deployment.arcoUSDAddress, role("MINTER_ROLE")],
    ["ArcoUSD:BURNER_ROLE", deployment.arcoUSDAddress, role("BURNER_ROLE")],
    ["ArcoUSD:PAUSER_ROLE", deployment.arcoUSDAddress, role("PAUSER_ROLE")],
    ["ArcoUSD:BLACKLIST_OPERATOR_ROLE", deployment.arcoUSDAddress, role("BLACKLIST_OPERATOR_ROLE")],
    ["ArcoUSD:GREENLIST_OPERATOR_ROLE", deployment.arcoUSDAddress, role("GREENLIST_OPERATOR_ROLE")],
    ...(deployment.routerAddress
      ? ([
          ["Router:DEFAULT_ADMIN_ROLE", deployment.routerAddress, ZERO_ROLE],
          ["Router:PAUSER_ROLE", deployment.routerAddress, role("PAUSER_ROLE")],
        ] as [string, `0x${string}`, Hex][])
      : []),
    ...(deployment.savings
      ? ([
          ["sArcoUSD:DEFAULT_ADMIN_ROLE", deployment.savings.vaultAddress, ZERO_ROLE],
          ["sArcoUSD:PAUSER_ROLE", deployment.savings.vaultAddress, role("PAUSER_ROLE")],
          ["sArcoUSD:REWARDER_ROLE", deployment.savings.vaultAddress, role("REWARDER_ROLE")],
          ["SavingsDistributor:DEFAULT_ADMIN_ROLE", deployment.savings.distributorAddress, ZERO_ROLE],
          ["SavingsDistributor:PAUSER_ROLE", deployment.savings.distributorAddress, role("PAUSER_ROLE")],
        ] as [string, `0x${string}`, Hex][])
      : []),
  ]
  const held = await Promise.all(
    checks.map(async ([name, address, id]) => ((await client.readContract({ address, abi: accessAbi, functionName: "hasRole", args: [id, account] })) ? name : null)),
  )
  return held.filter((name): name is string => name !== null)
}

/** viem public client → the keeper's RPC port (reads, eth_call, and the one raw send). */
export function viemKeeperRpc(
  client: Pick<PublicClient, "getChainId" | "getBalance" | "getTransactionCount" | "simulateContract" | "readContract" | "request" | "getTransactionReceipt" | "getTransaction">,
): KeeperRpc {
  return {
    chainId: () => client.getChainId(),
    balance: (address) => client.getBalance({ address }),
    nonce: (address, blockTag) => client.getTransactionCount({ address, blockTag }),
    async simulate({ from, reserve, asset, maxCount, gas }) {
      const { result } = await client.simulateContract({
        address: reserve,
        abi: processQueueAbi,
        functionName: "processQueue",
        args: [asset, BigInt(maxCount)],
        account: from,
        gas,
      })
      return result as bigint
    },
    async distributorPreview(distributor) {
      const [amount, , , , nextAt] = await client.readContract({ address: distributor, abi: distributorAbi, functionName: "preview" })
      return { amount, nextAt }
    },
    async simulateDistribute({ from, distributor, gas }) {
      try {
        const { result } = await client.simulateContract({ address: distributor, abi: distributorAbi, functionName: "distribute", account: from, gas })
        return { ok: true, amount: result }
      } catch (error) {
        const revert = distributeRevertReason(error)
        if (revert === null) throw error
        return { ok: false, revert }
      }
    },
    sendRaw: (raw) => client.request({ method: "eth_sendRawTransaction", params: [raw] }) as Promise<Hex>,
    async receipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash })
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics as readonly Hex[], data: log.data })),
        }
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null
        throw error
      }
    },
    async transaction(hash) {
      try {
        const tx = await client.getTransaction({ hash })
        return { mined: tx.blockNumber !== null }
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return null
        throw error
      }
    },
  }
}

/** Ticks until `signal` aborts; a tick in progress always finishes (a sent transaction is followed up). */
export async function runKeeperLoop(input: {
  readonly keeper: Pick<ArcoUSDKeeper, "tick">
  readonly intervalMs: number
  readonly signal: AbortSignal
  readonly log: (line: Record<string, unknown>) => void
}): Promise<void> {
  while (!input.signal.aborted) {
    const tick = await input.keeper.tick()
    input.log({
      service: "arco-arcousd-keeper",
      mode: tick.mode,
      ok: tick.ok,
      sent: tick.sent,
      note: tick.note,
      error: tick.error,
      distribute: tick.distribute?.state ?? null,
      lastTx: tick.lastTx ? { hash: tick.lastTx.hash, action: tick.lastTx.action ?? "processQueue", status: tick.lastTx.status, paid: tick.lastTx.paid } : null,
    })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, input.intervalMs)
      input.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}
