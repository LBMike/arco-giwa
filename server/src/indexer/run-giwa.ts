import { createPublicClient, http } from "viem"
import { ArcoUSDAdmin, PrismaArcoUSDAdminStore } from "../arcousd/admin.js"
import { parseArcoUSDAlertEnv } from "../arcousd/alert-config.js"
import { PrismaArcoUSDAlertStore } from "../arcousd/alerts.js"
import { parseArcoUSDEnv } from "../arcousd/config.js"
import { ArcoUSDIndexer } from "../arcousd/indexer.js"
import { alertChannels } from "../arcousd/notify.js"
import { createArcoUSDChainReader } from "../arcousd/reader.js"
import { ArcoUSDRecalls, createRecallReader, type RecallRow } from "../arcousd/recall.js"
import { readArcoUSDRegistry } from "../arcousd/registry.js"
import { createSavingsChainReader } from "../arcousd/savings.js"
import { ArcoUSDSavingsIndexer, PrismaSavingsIndexerStore } from "../arcousd/savings-indexer.js"
import { PrismaArcoUSDIndexerStore } from "../arcousd/store.js"
import { safeErrorText } from "../arcousd/safe-error.js"
import { ArcoUSDWatcher } from "../arcousd/watcher.js"
import { validateServerEnv } from "../config/env.js"
import { createPrismaClient } from "../db/prisma.js"
import { readRegistryFile } from "../registry/io.js"
import { GIWA_CHAIN_ID } from "../registry/products.js"
import { PrismaArcoService } from "../services/prisma-arco-service.js"
import type { RawEvmLog } from "./event-decoder.js"
import { GiwaIndexer, type GiwaIndexerRpc } from "./giwa-indexer.js"
import { PrismaGiwaIndexerStore } from "./prisma-store.js"

/** The most the indexer loop waits for one watcher round. */
const WATCHER_BUDGET_MS = 20_000

/**
 * The promise's result, or "over-budget" after `ms`. The promise keeps running; how it ends then is
 * reported to `onLate` (its result, or its error made safe for logs).
 */
async function withinBudget<T>(promise: Promise<T>, ms: number, onLate: (outcome: unknown) => void): Promise<T | { readonly mode: "over-budget" }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const late = new Promise<{ readonly mode: "over-budget" }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ mode: "over-budget" })
    }, ms)
  })
  promise
    .then(
      (value) => timedOut && onLate(value),
      (error) => timedOut && onLate({ error: safeErrorText(error) }),
    )
    .catch(() => undefined) // a failing logger must never become an unhandled rejection
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

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

  // ArcoUSD runs in the same process with its own cursor and its own try/catch below: inert until
  // deployments/91342/arcousd-giwa.json exists and is deployed, and its failures never back off
  // or stop the core indexer (nor the reverse).
  const arcoUSDEnv = parseArcoUSDEnv(envSource) // never throws; invalid values fall back to defaults
  if (arcoUSDEnv.invalid.length) {
    console.error(stringify({ service: "arco-arcousd-indexer", mode: "config-invalid", invalid: arcoUSDEnv.invalid }))
  }
  const arcoUSDIndexer = new ArcoUSDIndexer({
    loadRegistry: () => readArcoUSDRegistry(arcoUSDEnv.registryPath),
    rpc: createRpc(env.indexerRpcUrl),
    store: new PrismaArcoUSDIndexerStore(prisma, arco),
    readState: createArcoUSDChainReader(createPublicClient({ transport: http(env.indexerRpcUrl) })),
    confirmations: env.indexerConfirmations,
    maxBlockRange: env.indexerMaxBlockRange,
    snapshotIntervalMs: arcoUSDEnv.snapshotIntervalMs,
  })

  // Savings (sArcoUSD) events and share-price snapshots: its own cursor ("arcousd-savings") from the
  // Savings deploy block; inert until the Savings contracts are in the ArcoUSD registry.
  const savingsIndexer = new ArcoUSDSavingsIndexer({
    loadRegistry: () => readArcoUSDRegistry(arcoUSDEnv.registryPath),
    rpc: createRpc(env.indexerRpcUrl),
    store: new PrismaSavingsIndexerStore(prisma, arco),
    readState: createSavingsChainReader(createPublicClient({ transport: http(env.indexerRpcUrl) })),
    confirmations: env.indexerConfirmations,
    maxBlockRange: env.indexerMaxBlockRange,
    snapshotIntervalMs: arcoUSDEnv.snapshotIntervalMs,
  })

  // ArcoUSD watcher (docs/operations/arcousd-alerts.md): after the ArcoUSD poll, once per
  // ARCOUSD_ALERT_INTERVAL_MS, with its own try/catch. Reads only; sends alerts to the configured
  // Telegram / Slack channels (none configured: rows and logs only). Inert like the indexer.
  const alertEnv = parseArcoUSDAlertEnv(envSource)
  if (alertEnv.invalid.length) {
    console.error(stringify({ service: "arco-arcousd-watcher", mode: "config-invalid", invalid: alertEnv.invalid }))
  }
  // Short, no-retry RPC reads: the watcher runs inline and must never hold up the indexer for long.
  const watchClient = createPublicClient({ transport: http(env.indexerRpcUrl, { retryCount: 0, timeout: 5_000 }) })
  const loadArcoUSDRegistry = () => readArcoUSDRegistry(arcoUSDEnv.registryPath)
  let watcher: ArcoUSDWatcher | null = null
  let lastBusyLogAt = 0
  let arcoUSDPollSeq = 0
  const recalls = new ArcoUSDRecalls({ chainId: GIWA_CHAIN_ID, loadRegistry: loadArcoUSDRegistry, read: createRecallReader(watchClient) })
  watcher = new ArcoUSDWatcher({
    chainId: GIWA_CHAIN_ID,
    network: "GIWA Sepolia",
    env: arcoUSDEnv,
    alertEnv,
    loadRegistry: loadArcoUSDRegistry,
    readState: createArcoUSDChainReader(watchClient),
    latestBlock: () => watchClient.getBlockNumber(),
    indexedBlock: async () => {
      const cursor = (await arco.getIndexerCursor(GIWA_CHAIN_ID, "arcousd")) as { lastBlock: bigint | number } | null
      return cursor ? BigInt(cursor.lastBlock) : null
    },
    admin: new ArcoUSDAdmin({
      chainId: GIWA_CHAIN_ID,
      loadRegistry: loadArcoUSDRegistry,
      store: new PrismaArcoUSDAdminStore(prisma),
      liveQueueMinDelay: async () => (watcher ? watcher.liveQueueMinDelay() : null),
    }),
    lastSnapshotAt: async (deployment) => {
      const row = await prisma.arcoUSDReserveSnapshot.findFirst({
        where: { chainId: GIWA_CHAIN_ID, reserveAddress: deployment.reserveAddress.toLowerCase() },
        orderBy: { takenAt: "desc" },
        select: { takenAt: true },
      })
      return row?.takenAt ?? null
    },
    recalls: () => recalls.snapshot(async (reserve) => (await arco.redemptionsForWallet(reserve, GIWA_CHAIN_ID)) as RecallRow[]),
    store: new PrismaArcoUSDAlertStore(prisma),
    channels: alertChannels(alertEnv),
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
    let coreError: unknown = null
    try {
      const result = await indexer.pollOnce()
      console.log(stringify({ service: "arco-giwa-indexer", mode: "poll", result }))
    } catch (error) {
      coreError = error
    }
    let arcoUSDPollOk = false
    try {
      arcoUSDPollSeq++
      const result = await arcoUSDIndexer.pollOnce()
      arcoUSDPollOk = true
      if (result.mode === "poll") console.log(stringify({ service: "arco-arcousd-indexer", mode: "poll", result }))
    } catch (error) {
      console.error(
        stringify({
          service: "arco-arcousd-indexer",
          mode: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    try {
      const result = await savingsIndexer.pollOnce()
      if (result.mode === "poll") console.log(stringify({ service: "arco-arcousd-savings-indexer", mode: "poll", result }))
    } catch (error) {
      console.error(stringify({ service: "arco-arcousd-savings-indexer", mode: "error", error: safeErrorText(error) }))
    }
    try {
      // Bounded: a slow round keeps running on its own (the next maybeRun answers "busy") while the
      // indexer moves on. A poll that failed midway leaves rows past its cursor: no reconciling then.
      const round = await withinBudget(watcher.maybeRun({ indexerPollOk: arcoUSDPollOk, pollSeq: () => arcoUSDPollSeq }), WATCHER_BUDGET_MS, (late) =>
        console.log(stringify({ service: "arco-arcousd-watcher", mode: "late", outcome: late })),
      )
      if (round.mode === "run" || round.mode === "over-budget") console.log(stringify({ service: "arco-arcousd-watcher", mode: round.mode, round }))
      // A round that never ends (a hung DB call) would silence the watcher: say so, once a minute.
      if (round.mode === "busy" && round.sinceMs > 3 * WATCHER_BUDGET_MS && Date.now() - lastBusyLogAt > 60_000) {
        lastBusyLogAt = Date.now()
        console.error(stringify({ service: "arco-arcousd-watcher", mode: "stuck", sinceMs: round.sinceMs }))
      }
    } catch (error) {
      console.error(stringify({ service: "arco-arcousd-watcher", mode: "error", error: safeErrorText(error) }))
    }
    if (coreError === null) {
      backoffMs = 1000
      await sleep(env.indexerPollIntervalMs)
    } else {
      console.error(
        stringify({
          service: "arco-giwa-indexer",
          mode: "error",
          error: coreError instanceof Error ? coreError.message : String(coreError),
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
