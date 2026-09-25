// A direct trade, start to finish: the wallet's own transaction (depositForOrder for a Buy, escrowForOrder for a Sell),
// GIWA's receipt, then the server's progress for that key until it is completed or held. Nothing here infers an outcome:
// the receipt says whether the transaction ran, and only the server says what it settled. No sign-in is involved.
import { walletSignatureFailure } from "../stocks-host/sign-in-errors"
import { orderStatusMeaning } from "../stocks-investor/status"
import type { HexAddress, StocksDirectStatus } from "../stocks-investor/types"
import type { DirectContracts } from "./contracts"
import type { DirectOrderKey } from "./key"

export type DirectSide = "BUY" | "SELL"
export type TxHash = `0x${string}`

export type DirectTradeInput = Readonly<{
  side: DirectSide
  /** The connected wallet, lower-case: it pays (Buy) or escrows (Sell), and receives. */
  owner: HexAddress
  contracts: DirectContracts
  /** What the transaction moves: tUSDC base units for a Buy, NVDA base units for a Sell. */
  amount: string
  /** What the page expected back at its price (NVDA for a Buy, tUSDC for a Sell); the server's price decides. */
  estimate: string | null
}>

/** Nothing moved: the wallet declined or could not send, or GIWA reverted the transaction. */
export type DirectTradeCode = "WALLET_REQUEST_REJECTED" | "WALLET_REQUEST_PENDING" | "NOT_ACCEPTED" | "SEND_FAILED" | "REVERTED"

export type DirectTradeState =
  | { phase: "WALLET" }
  | { phase: "CONFIRMING"; hash: TxHash }
  | { phase: "SETTLING"; hash: TxHash; status: StocksDirectStatus | null }
  | { phase: "DONE"; hash: TxHash; status: StocksDirectStatus }
  | { phase: "HELD"; hash: TxHash; status: StocksDirectStatus }
  /** Still going after the page stopped asking: the receipt or the settlement took longer than usual. */
  | { phase: "SLOW"; hash: TxHash; status: StocksDirectStatus | null; stage: "RECEIPT" | "SETTLEMENT" }
  | { phase: "FAILED"; code: DirectTradeCode }

export type DirectTrade = Readonly<{ id: number; key: DirectOrderKey; input: DirectTradeInput; state: DirectTradeState }>

export type DirectTradePorts = {
  /** Simulates, then asks the wallet to send; resolves with the hash. A failed simulation throws DirectTradeError. */
  send(input: DirectTradeInput, key: DirectOrderKey): Promise<TxHash>
  /** GIWA's receipt: null while there is none yet. */
  receipt(hash: TxHash): Promise<"success" | "reverted" | null>
  /** The server's status: null while it has not seen the transaction. */
  status(key: DirectOrderKey, side: DirectSide): Promise<StocksDirectStatus | null>
  sleep(ms: number): Promise<void>
  newKey(): DirectOrderKey
}

export class DirectTradeError extends Error {
  constructor(readonly code: DirectTradeCode) {
    super(code)
    this.name = "DirectTradeError"
  }
}

export type DirectPolling = Readonly<{ receiptMs: number; receiptPolls: number; statusMs: number; statusPolls: number }>
/** About 90 s for GIWA's receipt, then about 4 minutes for the server's settlement, before the page stops asking. */
export const DIRECT_POLLING: DirectPolling = Object.freeze({ receiptMs: 1_000, receiptPolls: 90, statusMs: 1_500, statusPolls: 160 })

/** The phase a server status puts the trade in: completed, held (review, returned, refunded, expired), or still settling. */
export function settledPhase(status: StocksDirectStatus): "DONE" | "HELD" | "SETTLING" {
  const category = orderStatusMeaning({ side: status.side, state: status.state }).category
  if (category === "COMPLETED") return "DONE"
  if (category === "REVIEW_REQUIRED" || category === "RETURNED" || category === "EXPIRED" || category === "DEADLINE_PASSED") return "HELD"
  return "SETTLING"
}

export function failureCode(error: unknown): DirectTradeCode {
  if (error instanceof DirectTradeError) return error.code
  const code = walletSignatureFailure(error).code
  return code === "WALLET_REQUEST_REJECTED" || code === "WALLET_REQUEST_PENDING" ? code : "SEND_FAILED"
}

// ── one store per page: the trade of each wallet, kept while the panel remounts ──

const trades = new Map<string, DirectTrade>()
const listeners = new Set<() => void>()
let nextId = 1

function publish(owner: string, trade: DirectTrade | null) {
  if (trade === null) trades.delete(owner)
  else trades.set(owner, trade)
  for (const listener of [...listeners]) listener()
}

export function subscribeDirectTrades(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function directTradeOf(owner: string | null): DirectTrade | null {
  return owner === null ? null : trades.get(owner.toLowerCase()) ?? null
}

/** True while the trade's transaction may still be sent or settled by this page (a new one must wait). */
export function directTradeActive(trade: DirectTrade | null): boolean {
  return trade !== null && (trade.state.phase === "WALLET" || trade.state.phase === "CONFIRMING" || trade.state.phase === "SETTLING")
}

/** Forgets a finished or failed trade (Buy more / Sell more, or a new amount after a failure). Never an active one. */
export function clearDirectTrade(owner: string | null): void {
  const trade = directTradeOf(owner)
  if (owner !== null && trade !== null && !directTradeActive(trade)) publish(owner.toLowerCase(), null)
}

function updater(owner: string, id: number) {
  return (state: DirectTradeState) => {
    const trade = trades.get(owner)
    if (trade?.id === id) publish(owner, { ...trade, state })
  }
}

async function followReceipt(trade: DirectTrade, hash: TxHash, ports: DirectTradePorts, polling: DirectPolling, set: (state: DirectTradeState) => void) {
  set({ phase: "CONFIRMING", hash })
  for (let poll = 0; poll < polling.receiptPolls; poll += 1) {
    const receipt = await ports.receipt(hash).catch(() => null)
    if (receipt === "reverted") return set({ phase: "FAILED", code: "REVERTED" })
    if (receipt === "success") return followSettlement(trade, hash, null, ports, polling, set)
    await ports.sleep(polling.receiptMs)
  }
  set({ phase: "SLOW", hash, status: null, stage: "RECEIPT" })
}

async function followSettlement(trade: DirectTrade, hash: TxHash, last: StocksDirectStatus | null, ports: DirectTradePorts, polling: DirectPolling, set: (state: DirectTradeState) => void) {
  let status = last
  set({ phase: "SETTLING", hash, status })
  for (let poll = 0; poll < polling.statusPolls; poll += 1) {
    // A failed read is not an answer: ask again (the server may be restarting).
    const next = await ports.status(trade.key, trade.input.side).catch(() => undefined)
    if (next) {
      status = next
      const phase = settledPhase(next)
      if (phase === "DONE") return set({ phase: "DONE", hash, status: next })
      if (phase === "HELD") return set({ phase: "HELD", hash, status: next })
      set({ phase: "SETTLING", hash, status: next })
    }
    await ports.sleep(polling.statusMs)
  }
  set({ phase: "SLOW", hash, status, stage: "SETTLEMENT" })
}

/**
 * Starts one direct trade for `input.owner` and follows it. Refused (null) while that wallet's previous trade is still
 * active. The wallet request is the user's own press; nothing is sent again on its own.
 */
export function startDirectTrade(input: DirectTradeInput, ports: DirectTradePorts, polling: DirectPolling = DIRECT_POLLING): DirectTrade | null {
  const owner = input.owner.toLowerCase()
  if (directTradeActive(trades.get(owner) ?? null)) return null
  const trade: DirectTrade = Object.freeze({ id: nextId++, key: ports.newKey(), input, state: { phase: "WALLET" as const } })
  publish(owner, trade)
  const set = updater(owner, trade.id)
  void (async () => {
    let hash: TxHash
    try {
      hash = await ports.send(input, trade.key)
    } catch (error) {
      set({ phase: "FAILED", code: failureCode(error) })
      return
    }
    await followReceipt(trade, hash, ports, polling, set)
  })()
  return trade
}

/** "Check again" after the page stopped asking: follows the same transaction and key again. Sends nothing. */
export function resumeDirectTrade(owner: string | null, ports: DirectTradePorts, polling: DirectPolling = DIRECT_POLLING): void {
  const trade = directTradeOf(owner)
  if (owner === null || trade === null || trade.state.phase !== "SLOW") return
  const set = updater(owner.toLowerCase(), trade.id)
  const { hash, status, stage } = trade.state
  void (stage === "RECEIPT" ? followReceipt(trade, hash, ports, polling, set) : followSettlement(trade, hash, status, ports, polling, set))
}

/** Tests only: a fresh page. */
export function resetDirectTradesForTests(): void {
  trades.clear()
  nextId = 1
  for (const listener of [...listeners]) listener()
}
