import { formatUnits } from "viem"
import type { QueueAssetSummary } from "./admin.js"
import type { AssetState, ReserveState } from "./reader.js"
import type { RecallView } from "./recall.js"
import { DISTRIBUTE_MIN_AMOUNT, type DistributorPreview, type SavingsState } from "./savings.js"
import type { BuyGate } from "./service.js"

/** What the keeper last wrote to its heartbeat (keeper.ts KeeperReport, as stored). */
export type KeeperSeen = {
  readonly lastRunAt: Date
  readonly lastOkAt: Date | null
  readonly lastError: string | null
  readonly report: {
    readonly mode?: string
    readonly intervalMs?: number
    readonly address?: string | null
    readonly gasBalanceWei?: string | null
    readonly lowGasWei?: string
    readonly lowGas?: boolean | null
    readonly pending?: { readonly nonce: number; readonly since: string; readonly stuck: boolean } | null
    readonly distribute?: { readonly state?: string } | null
  } | null
}

/** What the watcher read of Savings this round (the input is absent while Savings is not deployed). */
export type SavingsSeen = {
  /** null when the vault or the distributor could not be read (`error` says why). */
  readonly state: SavingsState | null
  readonly error: string | null
  /** Blocks the savings indexer is behind the head; null when unknown this round. */
  readonly lagBlocks: number | null
  /** The savings indexer's last share-price snapshot; null before the first, or unread. */
  readonly lastSnapshotAt: Date | null
}

// ArcoUSD watcher rules (docs/operations/arcousd-alerts.md): one pure pass over what the watcher
// read this round → the conditions that are true right now. No I/O, no clock of its own; the alert
// book (alerts.ts) turns findings into PENDING / OPEN / RESOLVED and decides what to send.
// Text is English (like the admin console); amounts show at most 2 decimals.

export type Severity = "CRITICAL" | "WARNING"

export type Finding = {
  /** Stable per condition (and per asset / recall): one alert row each. */
  readonly key: string
  readonly severity: Severity
  readonly title: string
  readonly detail: string
  /** The condition must hold this long before anyone is told (filters one-off blips). */
  readonly sustainMs: number
  /** A change while the alert is open re-notifies at once (e.g. which pauses are on). */
  readonly fingerprint: string
}

export const T2_SECONDS = 2 * 24 * 60 * 60
export const AGING_SECONDS = 36 * 60 * 60
/** MMF share of backing this far from the target (once allocation has started) is "off target". */
export const MMF_BAND_BPS = 1_000
/** Mint-cap room under this share of the cap is "nearly full". */
export const MINT_HEADROOM_BPS = 1_000
const MINUTE = 60_000
/** A distribution that is due and would mint ≥ $0.01, not sent this long after its time: overdue
 *  (the keeper checks every minute; savers lose APR room for every day it is late). */
export const SAVINGS_OVERDUE_MS = 2 * 60 * MINUTE
/** Savers beyond the seed and no distribution for this long: "earning nothing". */
export const SAVINGS_NO_YIELD_MS = 7 * 24 * 60 * MINUTE
/** sArcoUSD MIN_SHARES, held by 0x…dEaD after the seed: a supply above it means real savers. */
const SEED_SHARES = 10n ** 18n

export type WatchInput = {
  readonly now: number
  readonly stalledMs: number
  readonly indexerLagBlocks: number
  readonly snapshotIntervalMs: number
  /** A present-but-invalid ArcoUSD registry (nothing else can be read). */
  readonly registryError?: string | null
  readonly state: ReserveState | null
  readonly stateError?: string | null
  readonly gate?: BuyGate | null
  /** The state was read at the indexer's last block, so the queue can be compared exactly. */
  readonly pinnedToIndexer: boolean
  readonly queue: readonly QueueAssetSummary[] | null
  /** The queue summary hit its row limit: totals are not complete, so no reconciliation. */
  readonly queueTruncated?: boolean
  readonly queueError?: string | null
  readonly indexer: { readonly lagBlocks: number } | null
  readonly lastSnapshotAt: Date | null
  readonly recalls: readonly RecallView[] | null
  /** The keeper's heartbeat; null when it has never run. */
  readonly keeper?: KeeperSeen | null
  /** Savings (sArcoUSD); absent or null while it is not deployed. */
  readonly savings?: SavingsSeen | null
}

export function evaluateWatch(input: WatchInput): Finding[] {
  const findings: Finding[] = []
  const add = (finding: Omit<Finding, "fingerprint"> & { fingerprint?: string }) => findings.push({ fingerprint: "", ...finding })

  if (input.registryError) {
    add({ key: "registry:invalid", severity: "CRITICAL", title: "ArcoUSD registry invalid", detail: `The watcher cannot read deployments/91342/arcousd-giwa.json: ${input.registryError}`, sustainMs: 0 })
    return findings
  }

  const state = input.state
  if (!state) {
    add({
      key: "reserve:read-failed",
      severity: "CRITICAL",
      title: "Reserve unreadable",
      detail: `The watcher could not read the Reserve${input.stateError ? ` (${input.stateError})` : ""}. Fund buys stay blocked while the API cannot read it either.`,
      sustainMs: 5 * MINUTE,
    })
  } else {
    reserveRules(state, input, add)
  }

  if (input.queueError) {
    add({ key: "queue:read-failed", severity: "WARNING", title: "Queue unreadable", detail: `The indexed redemption queue could not be read: ${input.queueError}`, sustainMs: 5 * MINUTE })
  } else if (input.queue) {
    for (const summary of input.queue) queueRules(summary, state, input, add)
  }

  if (input.indexer && input.indexer.lagBlocks > input.indexerLagBlocks) {
    add({
      key: "indexer:lag",
      severity: "WARNING",
      title: "ArcoUSD indexer behind",
      detail: `The indexer is ${count(input.indexer.lagBlocks)} blocks behind the chain, so the console's queue and flows are stale.`,
      sustainMs: 5 * MINUTE,
    })
  }
  const snapshotAge = input.lastSnapshotAt ? input.now - input.lastSnapshotAt.getTime() : null
  if (snapshotAge !== null && snapshotAge > 3 * input.snapshotIntervalMs) {
    add({
      key: "indexer:snapshots",
      severity: "WARNING",
      title: "Reserve snapshots stale",
      detail: `The last reserve snapshot is ${duration(snapshotAge / 1000)} old (expected every ${duration(input.snapshotIntervalMs / 1000)}).`,
      sustainMs: 0,
    })
  }

  for (const recall of input.recalls ?? []) recallRules(recall, add)
  if (input.keeper) keeperRules(input.keeper, input.now, add)
  if (input.savings) savingsRules(input.savings, input, add)
  return findings
}

/** The keeper's own health (it pays the queue and distributes Savings yield in dry-run/live; `off` raises nothing). */
function keeperRules(keeper: KeeperSeen, now: number, add: Add) {
  const report = keeper.report
  const mode = report?.mode
  if (mode !== "dry-run" && mode !== "live") return
  const interval = report?.intervalMs && report.intervalMs > 0 ? report.intervalMs : 60_000
  const silentFor = now - keeper.lastRunAt.getTime()
  if (silentFor > Math.max(5 * MINUTE, 3 * interval)) {
    add({
      key: "keeper:stale",
      severity: "WARNING",
      title: "Keeper not running",
      detail: `The ${mode} keeper last ran ${duration(silentFor / 1000)} ago. Until it is back, queue payouts and Savings distributions wait for the console (processQueue, distribute).`,
      sustainMs: 0,
    })
    return // its other readings are as old as that
  }
  if (keeper.lastError && (!keeper.lastOkAt || now - keeper.lastOkAt.getTime() > 10 * MINUTE)) {
    add({ key: "keeper:failing", severity: "WARNING", title: "Keeper failing", detail: keeper.lastError, sustainMs: 0 })
  }
  if (mode === "live" && report?.lowGas && report.gasBalanceWei) {
    add({
      key: "keeper:low-gas",
      severity: "WARNING",
      title: "Keeper low on gas",
      detail: `The keeper wallet ${report.address ?? ""} holds ${eth(BigInt(report.gasBalanceWei))} ETH (warns below ${eth(BigInt(report.lowGasWei ?? "0"))} ETH). Send it GIWA Sepolia ETH.`,
      sustainMs: 0,
    })
  }
  if (report?.pending?.stuck) {
    add({
      key: "keeper:stuck",
      severity: "WARNING",
      title: "Keeper transaction stuck",
      detail: `Nonce ${report.pending.nonce} has been pending since ${report.pending.since}. The keeper sends nothing else until it is mined or dropped.`,
      sustainMs: 0,
    })
  }
}

type Add = (finding: Omit<Finding, "fingerprint"> & { fingerprint?: string }) => void

/**
 * Savings (sArcoUSD and its distributor). The Reserve's own pauses, NAV and mint cap have their alerts
 * above; these say what they mean for savers, and what only Savings has: its switches, the seed, a
 * distribution that should have gone out, yield that has stopped, and the savings indexer.
 */
function savingsRules(seen: SavingsSeen, input: WatchInput, add: Add) {
  const state = seen.state
  if (!state) {
    add({
      key: "savings:read-failed",
      severity: "WARNING",
      title: "Savings unreadable",
      detail: `The watcher could not read sArcoUSD or its distributor${seen.error ? ` (${seen.error})` : ""}. The Savings tab and the public savings API cannot read them either.`,
      sustainMs: 5 * MINUTE,
    })
  } else {
    if (!state.seeded) {
      add({
        key: "savings:not-seeded",
        severity: "WARNING",
        title: "sArcoUSD not seeded",
        detail: "Savings is deployed but sArcoUSD.seed() has not run, so deposits stay closed. Finish the deploy (its seed:sArcoUSD step).",
        sustainMs: 30 * MINUTE,
      })
    }
    const paused = SAVINGS_PAUSES.filter((pause) => pause.on(state))
    if (paused.length) {
      add({
        key: "savings:pauses",
        severity: "WARNING",
        title: `Savings paused: ${paused.map((pause) => pause.label).join(", ")}`,
        detail: paused.map((pause) => `${pause.label}: ${pause.effect}.`).join(" "),
        sustainMs: 0,
        fingerprint: paused.map((pause) => pause.id).join(","),
      })
    }
    const preview = state.distributor.preview
    if (!preview) {
      add({
        key: "savings:preview",
        severity: "WARNING",
        title: "Savings distributor preview unreadable",
        detail: "distributor.preview() could not be read (the server log says why), so nobody can tell what the next distribution would be.",
        sustainMs: 15 * MINUTE,
      })
    } else {
      distributionRules(state, preview, input.now, add)
    }
  }

  if (seen.lagBlocks !== null && seen.lagBlocks > input.indexerLagBlocks) {
    add({
      key: "savings:indexer-lag",
      severity: "WARNING",
      title: "Savings indexer behind",
      detail: `The savings indexer is ${count(seen.lagBlocks)} blocks behind the chain, so the Savings tab's flows and the share-price history are stale.`,
      sustainMs: 5 * MINUTE,
    })
  }
  const snapshotAge = seen.lastSnapshotAt ? input.now - seen.lastSnapshotAt.getTime() : null
  if (snapshotAge !== null && snapshotAge > 3 * input.snapshotIntervalMs) {
    add({
      key: "savings:snapshots",
      severity: "WARNING",
      title: "Savings snapshots stale",
      detail: `The last sArcoUSD share-price snapshot is ${duration(snapshotAge / 1000)} old (expected every ${duration(input.snapshotIntervalMs / 1000)}).`,
      sustainMs: 0,
    })
  }
}

/** Overdue (yield waiting to go out) and no yield (nothing to send for a week). Silent while anything
 *  blocks distribute() or the NAV is down: the pause and NAV alerts say why then. */
function distributionRules(state: SavingsState, preview: DistributorPreview, now: number, add: Add) {
  const distributor = state.distributor
  if (distributor.paused || distributor.reservePaused || state.vaultPaused || state.rewardsPaused || distributor.arcoUSDMintPaused || !preview.navOk) return
  const amount = BigInt(preview.amount)
  const nextAt = Date.parse(distributor.nextDistributionAt)
  if (amount >= DISTRIBUTE_MIN_AMOUNT && Number.isFinite(nextAt) && now - nextAt > SAVINGS_OVERDUE_MS) {
    add({
      key: "savings:overdue",
      severity: "WARNING",
      title: "Savings distribution overdue",
      detail: `Due for ${duration((now - nextAt) / 1000)}, and ${usd(amount)} can be distributed now. The keeper sends distribute() once it is due: check the Keeper bot (Queue tab), or distribute from the Savings tab. Savers lose APR room for every day it waits.`,
      // Yield that only just became distributable (a pause lifted, the mint cap raised) is the keeper's
      // to send within a round or two, however long ago the distribution became due.
      sustainMs: 10 * MINUTE,
    })
  }
  const last = Date.parse(distributor.lastDistributionAt)
  const reason = amount < DISTRIBUTE_MIN_AMOUNT ? noYieldReason(preview, distributor.reserveMarginBps) : null
  if (reason && BigInt(state.totalSupply) > SEED_SHARES && Number.isFinite(last) && now - last > SAVINGS_NO_YIELD_MS) {
    add({
      key: "savings:no-yield",
      severity: "WARNING",
      title: "Savers earning nothing",
      detail: `No distribution for ${duration((now - last) / 1000)} (since ${distributor.lastDistributionAt}, or the deploy): ${reason}.`,
      sustainMs: 0,
    })
  }
}

/**
 * Why nothing can be distributed, when someone can do something about it: the mint cap, or no surplus.
 * null when only the APR cap binds (a vault too small or too new to earn a cent a day): nothing to fix.
 */
function noYieldReason(preview: DistributorPreview, marginBps: number): string | null {
  const under = (value: string) => BigInt(value) < DISTRIBUTE_MIN_AMOUNT
  if (under(preview.mintHeadroom)) return "the Reserve mint cap is reached; raise mintCap"
  if (under(preview.surplus)) return `the Reserve has no surplus above its ${pct(marginBps)} margin (MMF income has not built up)`
  return null
}

const SAVINGS_PAUSES: readonly { id: string; label: string; effect: string; on: (state: SavingsState) => boolean }[] = [
  { id: "distributor", label: "Savings distributor", effect: "no yield is distributed", on: (state) => state.distributor.paused },
  { id: "vault", label: "sArcoUSD (all)", effect: "deposits, withdrawals and yield", on: (state) => state.vaultPaused },
  // Closed until the seed by design: "not seeded" covers that.
  { id: "deposit", label: "sArcoUSD deposit", effect: "new savings deposits, the Zap's too", on: (state) => state.seeded && state.depositPaused },
  { id: "withdraw", label: "sArcoUSD withdraw", effect: "savings withdrawals, the Zap's too", on: (state) => state.withdrawPaused },
  { id: "rewards", label: "sArcoUSD addRewards", effect: "no yield can be added", on: (state) => state.rewardsPaused },
]

function reserveRules(state: ReserveState, input: WatchInput, add: Add) {
  const backing = BigInt(state.totalBacking)
  const supply = BigInt(state.totalLiabilities)
  if (!state.navOk) {
    add({
      key: "reserve:nav",
      severity: "CRITICAL",
      title: "MMF NAV unavailable",
      detail: "A strategy's NAV could not be read, so its holdings count as $0 in backing. Allocations and recalls revert until the price feed answers.",
      sustainMs: 10 * MINUTE,
    })
  } else if (backing < supply) {
    // With the NAV down, backing leaves the MMF out and the gap says nothing — that alert covers it.
    add({
      key: "reserve:under-backed",
      severity: "CRITICAL",
      title: "Reserve under-backed",
      detail: `Backing ${usd(backing)} is below ArcoUSD supply ${usd(supply)} (short ${usd(supply - backing)}).`,
      sustainMs: 5 * MINUTE,
    })
  }

  const gate = input.gate
  if (gate && gate.status === "closed") {
    add({
      key: "gate:closed",
      severity: "WARNING",
      title: "Fund buys blocked",
      detail: `The buy gate is closed: ${GATE_REASON[gate.reason ?? ""] ?? gate.reason ?? "unknown reason"}.${
        gate.reason === "insufficient-buffer" && gate.available !== null ? ` ${gate.asset} buffer ${amount(gate.available)}, threshold ${amount(gate.threshold)}.` : ""
      }`,
      sustainMs: 5 * MINUTE,
      fingerprint: gate.reason ?? "",
    })
  }

  const cap = BigInt(state.mintCap)
  const room = cap - supply
  if (cap > 0n && room * 10_000n < cap * BigInt(MINT_HEADROOM_BPS)) {
    add({
      key: "reserve:mint-cap",
      severity: "WARNING",
      title: "Mint cap nearly full",
      detail: `${usd(room > 0n ? room : 0n)} of the ${usd(cap)} mint cap is left. Deposits and stablecoin-paid buys stop at the cap; raise mintCap if this is expected growth.`,
      sustainMs: 0,
    })
  }

  // Before the first allocation (spec §7: it waits for the payment-feed fix) the MMF share is
  // simply 0, which is not drift.
  const invested = state.strategies.reduce((sum, strategy) => sum + BigInt(strategy.value), 0n)
  if (state.mmfTargetBps > 0 && invested > 0n && Math.abs(state.mmfBps - state.mmfTargetBps) > MMF_BAND_BPS) {
    add({
      key: "reserve:mmf-band",
      severity: "WARNING",
      title: "MMF allocation off target",
      detail: `MMF is ${pct(state.mmfBps)} of backing against a ${pct(state.mmfTargetBps)} target (band ±${pct(MMF_BAND_BPS)}). Allocations and recalls need operator approval.`,
      sustainMs: 60 * MINUTE,
    })
  }

  const paused = PAUSES.filter((pause) => state[pause.flag])
  if (paused.length) {
    add({
      key: "pauses",
      severity: "WARNING",
      title: `Paused: ${paused.map((pause) => pause.label).join(", ")}`,
      detail: paused.map((pause) => `${pause.label}: ${pause.effect}.`).join(" "),
      sustainMs: 0,
      fingerprint: paused.map((pause) => pause.flag).join(","),
    })
  }
}

function queueRules(summary: QueueAssetSummary, state: ReserveState | null, input: WatchInput, add: Add) {
  const symbol = summary.symbol
  const chainAsset = state?.assets.find((asset) => asset.address.toLowerCase() === summary.asset.toLowerCase()) ?? null

  // Reconciliation: at the indexer's own block the Reserve's queued obligation must equal the sum
  // of the indexer's QUEUED requests, and the indexer cannot hold more QUEUED requests than the
  // Reserve still has in front of its queue head (that backlog may also hold cancelled entries).
  if (state && chainAsset && input.pinnedToIndexer && !input.queueTruncated) {
    const chainQueued = BigInt(chainAsset.queued)
    const indexed = BigInt(summary.queuedAmount)
    const problems: string[] = []
    if (chainQueued !== indexed) {
      // A sub-cent gap would read "100 vs 100 (difference 0)" at 2 decimals: show every digit then.
      const exact = units(chainQueued, chainAsset.decimals) === units(indexed, chainAsset.decimals)
      const show = (value: bigint) => (exact ? formatUnits(value, chainAsset.decimals) : units(value, chainAsset.decimals))
      problems.push(
        `the Reserve owes ${show(chainQueued)} ${symbol} to queued requests, the indexer has ${show(indexed)} (difference ${show(
          chainQueued > indexed ? chainQueued - indexed : indexed - chainQueued,
        )})`,
      )
    }
    if (summary.queuedCount > chainAsset.queueBacklog) {
      problems.push(`the indexer has ${summary.queuedCount} queued requests but only ${chainAsset.queueBacklog} are left in the Reserve's queue`)
    }
    if (problems.length) {
      add({
        key: `reconcile:${symbol}`,
        severity: "CRITICAL",
        title: `${symbol} queue out of sync with the chain`,
        detail: `At block ${state.blockNumber} ${problems.join("; ")}. Check the indexer before trusting the console's queue.`,
        sustainMs: 10 * MINUTE,
      })
    }
  }

  const oldest = summary.oldestRequestedAt ? Date.parse(summary.oldestRequestedAt) : null
  const age = oldest === null ? null : (input.now - oldest) / 1000
  if (summary.overdueCount > 0) {
    add({
      key: `queue:${symbol}:overdue`,
      severity: "CRITICAL",
      title: `${summary.overdueCount === 1 ? "1 redemption" : `${summary.overdueCount} redemptions`} past T+2 (${symbol})`,
      detail: `The oldest${summary.head ? `, request #${summary.head.requestId},` : ""} has waited ${duration(age ?? 0)}. Standard redemptions promise payment by T+2.`,
      sustainMs: 0,
      fingerprint: String(summary.overdueCount),
    })
  } else if (age !== null && age > AGING_SECONDS) {
    add({
      key: `queue:${symbol}:aging`,
      severity: "WARNING",
      title: `${symbol} redemption close to T+2`,
      detail: `Request #${summary.head?.requestId ?? "?"} has waited ${duration(age)}; T+2 is reached in ${duration(T2_SECONDS - age)}.`,
      sustainMs: 0,
    })
  }

  if (summary.failedCount > 0) {
    add({
      key: `queue:${symbol}:payout-failed`,
      severity: "WARNING",
      title: `${summary.failedCount === 1 ? "1 payout" : `${summary.failedCount} payouts`} failed (${symbol})`,
      detail: "The recipient was blocked by the stablecoin or blacklisted on ArcoUSD. The owner gets the escrowed ArcoUSD back with cancelRedeem.",
      sustainMs: 0,
      fingerprint: String(summary.failedCount),
    })
  }

  const head = summary.head
  if (!head || !chainAsset || !state) return
  if (Date.parse(head.eligibleAt) > input.now) return // still inside queueMinDelay
  if (payoutsPaused(state)) return // the pause alert says why nothing moves
  const balance = BigInt(chainAsset.balance)
  const need = BigInt(head.assetAmount)
  if (balance >= need) {
    add({
      key: `queue:${symbol}:stalled`,
      severity: "WARNING",
      title: `${symbol} queue payable but not processed`,
      detail: `Request #${head.requestId} (${units(need, chainAsset.decimals)} ${symbol}) can be paid now. Run processQueue from the console (Queue tab).`,
      sustainMs: input.stalledMs,
    })
  } else {
    add({
      key: `queue:${symbol}:liquidity`,
      severity: "WARNING",
      title: `${symbol} queue short of liquidity`,
      detail: `Request #${head.requestId} needs ${units(need, chainAsset.decimals)} ${symbol}; the Reserve holds ${units(balance, chainAsset.decimals)} (short ${units(
        need - balance,
        chainAsset.decimals,
      )}).${recallHint(state, chainAsset)}`,
      sustainMs: 10 * MINUTE,
    })
  }
}

function recallHint(state: ReserveState, asset: AssetState): string {
  const sources = state.strategies.filter((strategy) => strategy.asset.toLowerCase() === asset.address.toLowerCase() && BigInt(strategy.value) > 0n)
  if (!sources.length) return " No MMF strategy holds this asset: refill the Reserve directly."
  const list = sources.map((strategy) => `#${strategy.strategyId}${strategy.productId ? ` ${strategy.productId}` : ""} (${usd(BigInt(strategy.value))})`).join(", ")
  return ` Recall from ${sources.length === 1 ? "strategy" : "strategies"} ${list} with operator approval.`
}

function recallRules(recall: RecallView, add: Add) {
  const name = `${recall.productId} recall #${recall.requestId}`
  const base = `recall:${recall.productId}:${recall.requestId}`
  if (recall.state === "awaiting-acknowledgement") {
    add({
      key: `${base}:acknowledge`,
      severity: "WARNING",
      title: `${name} paid, not acknowledged`,
      detail: "It was settled by direct transfer, so backing counts it twice until a reserve manager signs acknowledgeRecallPaid (Redemptions in the console).",
      sustainMs: 30 * MINUTE,
    })
  } else if (recall.state === "claimable") {
    add({
      key: `${base}:claim`,
      severity: "WARNING",
      title: `${name} ready to claim`,
      detail: "The vault fulfilled it; claimRecall moves the funds into the Reserve (anyone can call it).",
      sustainMs: 30 * MINUTE,
    })
  }
  if (recall.warning) {
    add({ key: `${base}:warning`, severity: "WARNING", title: `${name} needs a look`, detail: recall.warning, sustainMs: 0, fingerprint: recall.warning })
  }
}

/** processQueue pays nothing while any of these is on (the Reserve, its processQueue, or ArcoUSD burn). */
export function payoutsPaused(state: Pick<ReserveState, "reservePaused" | "queuePaused" | "arcoUSDPaused" | "arcoUSDBurnPaused">): boolean {
  return state.reservePaused || state.queuePaused || state.arcoUSDPaused || state.arcoUSDBurnPaused
}

const PAUSES: readonly { flag: keyof Pick<ReserveState, "reservePaused" | "settlementPaused" | "queuePaused" | "arcoUSDPaused" | "arcoUSDBurnPaused" | "depositPaused" | "arcoUSDMintPaused" | "routerPaused">; label: string; effect: string }[] = [
  { flag: "reservePaused", label: "Reserve (all)", effect: "every Reserve function except cancel" },
  { flag: "arcoUSDPaused", label: "ArcoUSD (all)", effect: "mint and burn" },
  { flag: "settlementPaused", label: "Reserve settleFor", effect: "every fund buy" },
  { flag: "queuePaused", label: "Reserve processQueue", effect: "Standard-queue payouts" },
  { flag: "arcoUSDBurnPaused", label: "ArcoUSD burn", effect: "settlement and queue payouts" },
  { flag: "depositPaused", label: "Reserve deposit", effect: "deposits and stablecoin-paid buys" },
  { flag: "arcoUSDMintPaused", label: "ArcoUSD mint", effect: "deposits and stablecoin-paid buys" },
  { flag: "routerPaused", label: "Router buy", effect: "fund buys through the Router" },
]

const GATE_REASON: Record<string, string> = {
  "read-failed": "the reserve could not be read",
  "settlement-paused": "settlement is paused (Reserve, settleFor, ArcoUSD or burn)",
  "buy-paused": "buys are paused (Router, deposit or mint)",
  "mint-cap": "less than one threshold-sized buy is left under the mint cap",
  "insufficient-buffer": "the settlement buffer is below the threshold",
  "asset-missing": "the gate asset is not a Reserve asset",
  "config-invalid": "the ARCOUSD_BUY_GATE_* setting is invalid",
}

// ─────────────────────────────── text ───────────────────────────────

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

/** "$1,234.56" from base18 USD. */
export function usd(base18: bigint): string {
  return `$${NUMBER.format(Number(formatUnits(base18, 18)))}`
}

/** "0.0123" ETH from wei (gas balances need more than 2 decimals). */
function eth(wei: bigint): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(formatUnits(wei, 18)))
}

/** "1,234.56" from asset base units. */
export function units(value: bigint, decimals: number): string {
  return NUMBER.format(Number(formatUnits(value, decimals)))
}

function amount(human: string): string {
  const value = Number(human)
  return Number.isFinite(value) ? NUMBER.format(value) : human
}

function count(value: number): string {
  return NUMBER.format(value)
}

function pct(bps: number): string {
  return `${NUMBER.format(bps / 100)}%`
}

/** "2d 3h", "5h 20m", "12m", "40s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86_400)
  const hours = Math.floor((s % 86_400) / 3_600)
  const minutes = Math.floor((s % 3_600) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${s}s`
}
