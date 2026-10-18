import { decodeEventLog, type AbiEvent, type Hex } from "viem"
import { getAbiEvents } from "../evm/abi.js"
import { RESOLVED_INDEXED_EVENTS } from "../registry/products.js"

export type RawEvmLog = {
  readonly address: `0x${string}`
  readonly blockNumber: bigint
  readonly blockHash: `0x${string}`
  readonly transactionHash: `0x${string}`
  readonly logIndex: number
  readonly data: Hex
  readonly topics: readonly Hex[]
  readonly removed?: boolean
}

export type DecodedIndexedEvent = {
  readonly eventName: string
  readonly args: Record<string, unknown>
}

function uniqueEvents(): AbiEvent[] {
  const events = [
    ...getAbiEvents("TestAssetFaucet"),
    ...getAbiEvents("ArcoDepositVault"),
    ...getAbiEvents("ArcoRedemptionVault"),
    ...getAbiEvents("ProductPriceFeed"),
    ...getAbiEvents("ProductToken"),
  ]
  const seen = new Set<string>()
  return events.filter((event) => {
    const key = `${event.name}:${event.inputs.map((input) => input.type).join(",")}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(serialize)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serialize(nested)]))
  }
  if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase()
  return value
}

// Activity attribution. A deposit belongs to whoever receives the shares: a buy through the
// ArcoRouter has the Router as `sender` and the buyer as `recipient` (direct buys set both to the
// buyer). A redemption belongs to the holder who burned the shares (`sender`).
function withWalletAddress(eventName: string, args: Record<string, unknown>) {
  const wallet =
    eventName === "FaucetDrip"
      ? args.wallet
      : eventName.startsWith("ProductDeposit")
        ? args.recipient ?? args.sender
        : eventName.startsWith("ProductRedeem")
          ? args.sender ?? args.recipient
          : undefined
  return typeof wallet === "string" ? { ...args, walletAddress: wallet.toLowerCase() } : args
}

export function decodeIndexedEventLog(log: RawEvmLog): DecodedIndexedEvent | null {
  const indexedNames = new Set<string>(RESOLVED_INDEXED_EVENTS)
  for (const event of uniqueEvents()) {
    try {
      const decoded = decodeEventLog({
        abi: [event],
        data: log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      })
      if (!indexedNames.has(decoded.eventName)) return null
      const args = withWalletAddress(decoded.eventName, serialize(decoded.args ?? {}) as Record<string, unknown>)
      return { eventName: decoded.eventName, args }
    } catch {
      // Keep trying the ABI event set until a topic/signature match decodes cleanly.
    }
  }
  return null
}
