import type { IndexedEventInput, JsonObject } from "../services/types.js"
import { SAVINGS_SEED_HOLDER } from "./abi.js"

// Portfolio activity for ArcoUSD and Savings (docs/specs/arcousd-v1.md §5, 4c backend). The feed
// (/api/v1/activity/:wallet, PrismaArcoService.activityForWallet) lists the indexed events whose
// args carry `walletAddress` (lowercase), the core indexer's rule. One user action is one row:
//   • a Zap deposit is ZapDeposit (receiver); a Zap redeem is ZapRedeem (caller). The Reserve and
//     sArcoUSD steps the Zap makes on the way (sender = the Zap) belong to nobody;
//   • a Router buy is the deposit vault's ProductDeposit (core indexer); the Reserve deposit a
//     stablecoin-paid buy makes first (sender = the Router) belongs to nobody;
//   • a direct call is its own event: Deposited → recipient, RedeemedInstant → sender,
//     RedeemQueued / RedeemCancelled → owner, RedeemPaid / RedeemPayoutFailed → the request's owner
//     (from ArcoUSDRedeemRequest; the event names only the recipient), sArcoUSD Deposit / Withdraw → owner;
//   • the Savings seed (owner 0x…dEaD) and everything operational (settlement, MMF, distributions,
//     configuration, roles, pauses) belong to nobody.

const SEED = SAVINGS_SEED_HOLDER.toLowerCase()

/** Contracts whose internal steps are not a wallet's own action (lowercase addresses, null when absent). */
export type ActivityContracts = {
  readonly zap: string | null
  readonly router: string | null
}

const lower = (value: unknown): string | null => (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null)

const isOneOf = (address: string | null, ...contracts: (string | null)[]) =>
  address !== null && contracts.some((contract) => contract !== null && contract.toLowerCase() === address)

/**
 * The wallet a Reserve event belongs to, or null. `requestOwner` is the owner of the request a
 * RedeemPaid / RedeemPayoutFailed refers to (null when the request is not in the table).
 */
export function reserveEventWallet(
  eventName: string,
  args: Readonly<Record<string, unknown>>,
  contracts: ActivityContracts,
  requestOwner: string | null = null,
): string | null {
  switch (eventName) {
    case "Deposited": {
      const sender = lower(args.sender)
      return isOneOf(sender, contracts.zap, contracts.router) ? null : lower(args.recipient)
    }
    case "RedeemedInstant": {
      const sender = lower(args.sender)
      return isOneOf(sender, contracts.zap, contracts.router) ? null : sender
    }
    case "RedeemQueued":
    case "RedeemCancelled":
      return lower(args.owner)
    case "RedeemPaid":
    case "RedeemPayoutFailed":
      return lower(requestOwner)
    default:
      return null
  }
}

/** The wallet a Savings event belongs to (sArcoUSD, the distributor or the Zap), or null. */
export function savingsEventWallet(eventName: string, args: Readonly<Record<string, unknown>>, contracts: Pick<ActivityContracts, "zap">): string | null {
  switch (eventName) {
    case "Deposit":
    case "Withdraw": {
      if (isOneOf(lower(args.sender), contracts.zap)) return null
      const owner = lower(args.owner)
      return owner === SEED ? null : owner
    }
    case "ZapDeposit":
      return lower(args.receiver)
    case "ZapRedeem":
      return lower(args.caller)
    default:
      return null
  }
}

/** args with `walletAddress` set (lowercase), or as they are when the event is nobody's. */
export function withActivityWallet(args: JsonObject, wallet: string | null): JsonObject {
  return wallet ? { ...args, walletAddress: wallet } : args
}

export type IndexedEventDelegate = {
  evmIndexedEvent: { upsert(args: unknown): Promise<unknown> }
}

/**
 * Like PrismaArcoService.insertIndexedEvent, except that indexing an event again rewrites its args.
 * The ArcoUSD and Savings indexers use it so re-indexing (a cursor moved back) brings older rows
 * up to the current attribution rules; the core indexer's rows are left as they are.
 */
export function upsertIndexedEvent(prisma: IndexedEventDelegate, input: IndexedEventInput) {
  return prisma.evmIndexedEvent.upsert({
    where: { chainId_txHash_logIndex: { chainId: input.chainId, txHash: input.txHash, logIndex: input.logIndex } },
    create: {
      ...input,
      contractAddress: input.contractAddress.toLowerCase(),
      blockNumber: typeof input.blockNumber === "bigint" ? input.blockNumber : BigInt(input.blockNumber),
      blockTimestamp: input.blockTimestamp ?? null,
      removed: input.removed ?? false,
    },
    update: { args: input.args },
  })
}
