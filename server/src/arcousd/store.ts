import type { PrismaArcoService } from "../services/prisma-arco-service.js"
import { upsertIndexedEvent, type IndexedEventDelegate } from "./activity.js"
import {
  REDEEM_TRANSITION_FROM,
  type ArcoUSDIndexerStore,
  type RedeemQueuedInput,
  type RedeemTransitionInput,
  type ReserveSnapshotInput,
} from "./indexer.js"

// Prisma-backed ArcoUSD indexer store. The cursor reuses PrismaArcoService (same table as the core
// indexer, different cursor name); events go to the same EvmIndexedEvent table, but re-indexing one
// rewrites its args (activity.ts upsertIndexedEvent); the two ArcoUSD tables are written here so
// prisma-arco-service.ts stays untouched.

export type PrismaArcoUSDDelegates = IndexedEventDelegate & {
  arcoUSDRedeemRequest: {
    upsert(args: unknown): Promise<unknown>
    updateMany(args: unknown): Promise<{ count: number }>
    findUnique(args: unknown): Promise<{ owner: string } | null>
  }
  arcoUSDReserveSnapshot: {
    upsert(args: unknown): Promise<unknown>
  }
}

const TIMESTAMP_COLUMN = { PAID: "paid", PAYOUT_FAILED: "failed", CANCELLED: "cancelled" } as const

export class PrismaArcoUSDIndexerStore implements ArcoUSDIndexerStore {
  constructor(
    private readonly prisma: PrismaArcoUSDDelegates,
    private readonly arco: Pick<PrismaArcoService, "getIndexerCursor" | "upsertIndexerCursor">,
  ) {}

  getCursor(chainId: number, name: string) {
    return this.arco.getIndexerCursor(chainId, name) as ReturnType<ArcoUSDIndexerStore["getCursor"]>
  }

  upsertCursor(input: Parameters<ArcoUSDIndexerStore["upsertCursor"]>[0]) {
    return this.arco.upsertIndexerCursor(input)
  }

  insertIndexedEvent(input: Parameters<ArcoUSDIndexerStore["insertIndexedEvent"]>[0]) {
    return upsertIndexedEvent(this.prisma, input)
  }

  async redeemOwner(input: { chainId: number; reserveAddress: string; requestId: string }) {
    const row = await this.prisma.arcoUSDRedeemRequest.findUnique({
      where: {
        chainId_reserveAddress_requestId: { chainId: input.chainId, reserveAddress: input.reserveAddress.toLowerCase(), requestId: input.requestId },
      },
      select: { owner: true },
    })
    return row ? row.owner.toLowerCase() : null
  }

  recordRedeemQueued(input: RedeemQueuedInput) {
    const lower = (value: string) => value.toLowerCase()
    return this.prisma.arcoUSDRedeemRequest.upsert({
      where: {
        chainId_reserveAddress_requestId: {
          chainId: input.chainId,
          reserveAddress: lower(input.reserveAddress),
          requestId: input.requestId,
        },
      },
      create: {
        ...input,
        reserveAddress: lower(input.reserveAddress),
        owner: lower(input.owner),
        recipient: lower(input.recipient),
        asset: lower(input.asset),
        queuedTxHash: lower(input.queuedTxHash),
        status: "QUEUED",
      },
      update: {}, // never reset the status of a request a later event already moved
    })
  }

  async transitionRedeem(input: RedeemTransitionInput) {
    const column = TIMESTAMP_COLUMN[input.to]
    const result = await this.prisma.arcoUSDRedeemRequest.updateMany({
      where: {
        chainId: input.chainId,
        reserveAddress: input.reserveAddress.toLowerCase(),
        requestId: input.requestId,
        status: { in: [...REDEEM_TRANSITION_FROM[input.to]] },
      },
      data: {
        status: input.to,
        [`${column}TxHash`]: input.txHash.toLowerCase(),
        [`${column}At`]: input.at,
      },
    })
    return result.count
  }

  insertSnapshot(input: ReserveSnapshotInput) {
    const reserveAddress = input.reserveAddress.toLowerCase()
    return this.prisma.arcoUSDReserveSnapshot.upsert({
      where: {
        chainId_reserveAddress_blockNumber: { chainId: input.chainId, reserveAddress, blockNumber: input.blockNumber },
      },
      create: {
        chainId: input.chainId,
        reserveAddress,
        blockNumber: input.blockNumber,
        takenAt: input.takenAt,
        totalBacking: input.state.totalBacking,
        totalLiabilities: input.state.totalLiabilities,
        navOk: input.state.navOk,
        mmfBps: input.state.mmfBps,
        paused: input.state.reservePaused,
        settlementPaused: input.state.settlementPaused,
        data: input.state,
      },
      update: {},
    })
  }
}
