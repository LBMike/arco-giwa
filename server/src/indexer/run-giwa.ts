import { createPublicClient, http } from "viem"
import { validateServerEnv } from "../config/env.js"
import { createPrismaClient } from "../db/prisma.js"
import { readRegistryFile } from "../registry/io.js"
import { PrismaArcoService } from "../services/prisma-arco-service.js"
import type { RawEvmLog } from "./event-decoder.js"
import { GiwaIndexer, type GiwaIndexerRpc } from "./giwa-indexer.js"
import { PrismaGiwaIndexerStore } from "./prisma-store.js"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringify(value: unknown) {
  return JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested))
}

function createRpc(rpcUrl: string): GiwaIndexerRpc {
  const client = createPublicClient({ transport: http(rpcUrl) })
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    async getBlock(args) {
      const block = await client.getBlock({ blockNumber: args.blockNumber })
      return { number: block.number ?? args.blockNumber, hash: block.hash, timestamp: block.timestamp }
    },
    async getLogs(args) {
      const logs = await client.getLogs({
        address: args.addresses.length ? [...args.addresses] : undefined,
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
      })
      return logs
        .filter(
          (log) =>
            log.blockNumber !== null &&
            log.blockHash !== null &&
            log.transactionHash !== null &&
            log.logIndex !== null,
        )
        .map(
          (log): RawEvmLog => ({
            address: log.address,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            data: log.data,
            topics: log.topics,
            removed: log.removed,
          }),
        )
    },
  }
}

export async function runGiwaIndexer(envSource: NodeJS.ProcessEnv = process.env) {
  const env = validateServerEnv(envSource)
  // Re-read each poll so vaults registered after startup are picked up without a restart; the
  // indexer guards this call and keeps the last-good registry if a read/parse ever fails.
  const loadRegistry = () => readRegistryFile(env.registryPath)
  const registry = loadRegistry()

  if (!registry.activationFlags.deployed || !registry.activationFlags.indexerEnabled) {
    console.log(
      stringify({
        service: "arco-giwa-indexer",
        mode: "inert",
        reason: "Registry is not deployed or indexerEnabled=false",
        releaseId: registry.releaseId,
      }),
    )
    return
  }

  const prisma = createPrismaClient()
  const arco = new PrismaArcoService(prisma)
  const indexer = new GiwaIndexer({
    loadRegistry,
    rpc: createRpc(env.indexerRpcUrl),
    store: new PrismaGiwaIndexerStore(arco),
    confirmations: env.indexerConfirmations,
    maxBlockRange: env.indexerMaxBlockRange,
    cursorName: "giwa",
  })

  const backfillFrom = envSource.INDEXER_BACKFILL_FROM ? BigInt(envSource.INDEXER_BACKFILL_FROM) : null
  const backfillTo = envSource.INDEXER_BACKFILL_TO ? BigInt(envSource.INDEXER_BACKFILL_TO) : null
  if (backfillFrom !== null && backfillTo !== null) {
    const result = await indexer.backfill(backfillFrom, backfillTo)
    console.log(stringify({ service: "arco-giwa-indexer", mode: "backfill", result }))
    return
  }

  let stopped = false
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopped = true
    })
  }

  let backoffMs = 1000
  while (!stopped) {
    try {
      const result = await indexer.pollOnce()
      console.log(stringify({ service: "arco-giwa-indexer", mode: "poll", result }))
      backoffMs = 1000
      await sleep(env.indexerPollIntervalMs)
    } catch (error) {
      console.error(
        stringify({
          service: "arco-giwa-indexer",
          mode: "error",
          error: error instanceof Error ? error.message : String(error),
          retryInMs: backoffMs,
        }),
      )
      await sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGiwaIndexer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
