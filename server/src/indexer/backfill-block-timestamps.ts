import { createPublicClient, http } from "viem"
import { validateServerEnv } from "../config/env.js"
import { createPrismaClient } from "../db/prisma.js"

// One-time backfill for EvmIndexedEvent.blockTimestamp — populates rows indexed before the
// column existed so the portfolio Activity feed (and Monitoring v2 calendar trends) can show a
// real date rather than "—". Fetches each distinct block's timestamp at most once.

type BackfillRow = { id: string; chainId: number; blockNumber: bigint | number }

export type BackfillDeps = {
  // Minimal Prisma surface so the in-memory test fake can stand in for PrismaClient.
  prisma: {
    evmIndexedEvent: {
      findMany(args: { where: { blockTimestamp: null } }): Promise<BackfillRow[]>
      update(args: { where: { id: string }; data: { blockTimestamp: Date } }): Promise<unknown>
    }
  }
  // Resolve a block's wall-clock time; injected so tests avoid real RPC.
  getBlockTimestamp(chainId: number, blockNumber: bigint): Promise<Date>
}

export async function backfillBlockTimestamps(
  deps: BackfillDeps,
): Promise<{ scanned: number; updated: number; blocksFetched: number }> {
  const rows = await deps.prisma.evmIndexedEvent.findMany({ where: { blockTimestamp: null } })
  const cache = new Map<string, Date>()
  let updated = 0
  for (const row of rows) {
    const blockNumber = BigInt(row.blockNumber)
    const key = `${row.chainId}:${blockNumber.toString()}`
    let timestamp = cache.get(key)
    if (!timestamp) {
      timestamp = await deps.getBlockTimestamp(row.chainId, blockNumber)
      cache.set(key, timestamp)
    }
    await deps.prisma.evmIndexedEvent.update({ where: { id: row.id }, data: { blockTimestamp: timestamp } })
    updated += 1
  }
  return { scanned: rows.length, updated, blocksFetched: cache.size }
}

// CLI entry: wire the real Prisma client + a viem block-time reader, then backfill.
export async function runBackfillBlockTimestamps(envSource: NodeJS.ProcessEnv = process.env) {
  const env = validateServerEnv(envSource)
  const prisma = createPrismaClient()
  const client = createPublicClient({ transport: http(env.indexerRpcUrl) })
  try {
    return await backfillBlockTimestamps({
      prisma: prisma as unknown as BackfillDeps["prisma"],
      async getBlockTimestamp(_chainId, blockNumber) {
        const block = await client.getBlock({ blockNumber })
        return new Date(Number(block.timestamp) * 1000)
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}
