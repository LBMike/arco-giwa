import { isAddress, keccak256, toBytes, type Address, type Hex } from "viem"

/** What a direct-transfer redemption payout must have done on-chain. */
export type PayoutExpectation = {
  readonly txHash: Hex
  /** Payment-token contract the transfer must be emitted by. */
  readonly token: Address
  /** Redemption recipient that must receive the transfer. */
  readonly recipient: Address
  /** Exact amount (payment-token base units) locked at requestRedeem. */
  readonly amount: bigint
  /**
   * Wallets allowed to have signed the payout (the vault:write operator directory). The tx
   * sender must be one of them AND the transfer must move tokens out of that same wallet, so an
   * unrelated transfer to the recipient (a faucet drip, a past claim, a self-transfer) cannot
   * settle the request. Empty refuses every payout.
   */
  readonly allowedSenders: readonly string[]
  /** The payout must be mined strictly after this block (the requestRedeem block), when known. */
  readonly afterBlock?: bigint | null
  /**
   * The transaction must call the payment token itself (a plain transfer, as the console builds
   * it). Used for ArcoUSD Reserve recalls: an operator's own Reserve.deposit of the same amount
   * also emits operator → Reserve, but is not a payment of the recall.
   */
  readonly requireDirectTransfer?: boolean
}

export type PayoutVerification = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type PayoutVerifier = (expected: PayoutExpectation) => Promise<PayoutVerification>

/** Minimal receipt shape (viem's TransactionReceipt satisfies it). */
export type PayoutReceipt = {
  readonly status: "success" | "reverted"
  readonly from: string
  /** Contract the transaction called (null for a contract creation). */
  readonly to?: string | null
  readonly blockNumber: bigint
  readonly logs: readonly { readonly address: string; readonly topics: readonly (Hex | null | undefined)[]; readonly data: Hex }[]
}

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"))

// Compare addresses case-insensitively: receipts, the registry and checksums may differ in case.
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function topicAddress(topic: Hex | null | undefined): string | null {
  if (!topic || topic.length !== 66) return null
  const candidate = `0x${topic.slice(26)}`
  return isAddress(candidate, { strict: false }) ? candidate.toLowerCase() : null
}

/**
 * Pure check: the receipt succeeded, was sent by an allowed operator wallet after the request
 * block, and contains an ERC-20 Transfer emitted by `token` from that wallet to `recipient` for
 * exactly `amount`. Kept separate from RPC access so it is unit-testable.
 */
export function matchPayoutReceipt(receipt: PayoutReceipt, expected: PayoutExpectation): PayoutVerification {
  if (receipt.status !== "success") return { ok: false, reason: "transaction reverted" }
  if (!expected.allowedSenders.some((sender) => sameAddress(sender, receipt.from))) {
    return { ok: false, reason: "payout was not sent by an operator wallet" }
  }
  if (expected.afterBlock != null && receipt.blockNumber <= expected.afterBlock) {
    return { ok: false, reason: "payout transaction predates the redemption request" }
  }
  if (expected.requireDirectTransfer && !(receipt.to && sameAddress(receipt.to, expected.token))) {
    return { ok: false, reason: "payout must be a direct payment-token transfer (the transaction did not call the token)" }
  }
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, expected.token)) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    const from = topicAddress(log.topics[1])
    if (!from || !sameAddress(from, receipt.from)) continue
    const to = topicAddress(log.topics[2])
    if (!to || !sameAddress(to, expected.recipient)) continue
    let value: bigint
    try {
      value = BigInt(log.data)
    } catch {
      continue
    }
    if (value === expected.amount) return { ok: true }
  }
  return { ok: false, reason: "no payment-token transfer of the locked amount from the operator wallet to the redemption recipient" }
}

export type PayoutVerifierOptions = {
  /** Receipt lookups before giving up (RPC read-after-write lag right after the wallet confirms). */
  readonly attempts?: number
  readonly delayMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Reads the receipt through `getReceipt` (e.g. viem's getTransactionReceipt) and matches it. */
export function createPayoutVerifier(
  getReceipt: (hash: Hex) => Promise<PayoutReceipt>,
  options: PayoutVerifierOptions = {},
): PayoutVerifier {
  const attempts = Math.max(1, options.attempts ?? 5)
  const delayMs = options.delayMs ?? 1500
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  return async (expected) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return matchPayoutReceipt(await getReceipt(expected.txHash), expected)
      } catch {
        if (attempt < attempts) await sleep(delayMs)
      }
    }
    return { ok: false, reason: "receipt not found (not mined yet or unknown hash) — retry settle shortly" }
  }
}
