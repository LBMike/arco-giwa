import assert from "node:assert/strict"
import test from "node:test"
import { EvmPortfolioService } from "./evm-portfolio-service.js"
import { EvmRegistryService } from "./evm-registry-service.js"
import { PrismaArcoService } from "./prisma-arco-service.js"

type Row = Record<string, any>

function withId(row: Row): Row {
  return { id: row.id ?? `row_${Math.random().toString(16).slice(2)}`, ...row }
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  for (const [key, value] of Object.entries(where)) {
    if (key === "args" && value?.path && row.args?.[value.path[0]] !== value.equals) return false
    if (key === "expiresAt" && value?.gt && !(row.expiresAt > value.gt)) return false
    if (key === "consumedAt" && value === null && row.consumedAt !== null) return false
    if (key === "chainId" && row.chainId !== value) return false
    if (key === "walletAddress" && row.walletAddress !== value) return false
    if (key === "redemptionVaultAddress" && row.redemptionVaultAddress !== value) return false
    if (key === "requestId" && row.requestId !== value) return false
    if (key === "domain" && row.domain !== value) return false
    if (key === "nonce" && row.nonce !== value) return false
  }
  return true
}

function uniqueMatcher(where: Row): (row: Row) => boolean {
  if ("chainId" in where) return (row) => row.chainId === where.chainId
  if ("nonce" in where) return (row) => row.nonce === where.nonce
  if ("chainId_symbol" in where) {
    return (row) => row.chainId === where.chainId_symbol.chainId && row.symbol === where.chainId_symbol.symbol
  }
  if ("chainId_productId" in where) {
    return (row) =>
      row.chainId === where.chainId_productId.chainId && row.productId === where.chainId_productId.productId
  }
  if ("chainId_txHash_logIndex" in where) {
    return (row) =>
      row.chainId === where.chainId_txHash_logIndex.chainId &&
      row.txHash === where.chainId_txHash_logIndex.txHash &&
      row.logIndex === where.chainId_txHash_logIndex.logIndex
  }
  if ("chainId_name" in where) {
    return (row) => row.chainId === where.chainId_name.chainId && row.name === where.chainId_name.name
  }
  if ("chainId_redemptionVaultAddress_requestId" in where) {
    return (row) =>
      row.chainId === where.chainId_redemptionVaultAddress_requestId.chainId &&
      row.redemptionVaultAddress === where.chainId_redemptionVaultAddress_requestId.redemptionVaultAddress &&
      row.requestId === where.chainId_redemptionVaultAddress_requestId.requestId
  }
  throw new Error(`Unsupported unique where ${JSON.stringify(where)}`)
}

function table(seed: Row[] = []) {
  const rows = seed.map(withId)
  return {
    rows,
    async upsert(args: any) {
      const index = rows.findIndex(uniqueMatcher(args.where))
      if (index === -1) {
        const created = withId(args.create)
        rows.push(created)
        return created
      }
      rows[index] = { ...rows[index], ...args.update }
      return rows[index]
    },
    async create(args: any) {
      const created = withId(args.data)
      rows.push(created)
      return created
    },
    async findMany(args?: any) {
      return rows.filter((row) => matches(row, args?.where))
    },
    async count(args?: any) {
      return rows.filter((row) => matches(row, args?.where)).length
    },
    async update(args: any) {
      const index = rows.findIndex(uniqueMatcher(args.where))
      if (index === -1) throw new Error("Record to update not found")
      rows[index] = { ...rows[index], ...args.data }
      return rows[index]
    },
    async delete(args: any) {
      const index = rows.findIndex(uniqueMatcher(args.where))
      if (index === -1) throw new Error("Record to delete not found")
      const [removed] = rows.splice(index, 1)
      return removed
    },
    async findUnique(args: any) {
      return rows.find(uniqueMatcher(args.where)) ?? null
    },
    async findFirst(args?: any) {
      return rows.find((row) => matches(row, args?.where)) ?? null
    },
    async updateMany(args: any) {
      let count = 0
      for (const row of rows) {
        if (!matches(row, args.where)) continue
        Object.assign(row, args.data)
        count += 1
      }
      return { count }
    },
  }
}

function makePrisma() {
  return {
    evmNetwork: table(),
    evmAssetDeployment: table(),
    evmProductDeployment: table(),
    evmIndexedEvent: table(),
    evmIndexerCursor: table(),
    indexedRedemptionRequest: table(),
    vaultConfig: table(),
    featuredCard: table(),
    walletAttestation: table(),
    authNonce: table(),
  }
}

test("registry sync upserts networks, assets, and products without touching legacy data", async () => {
  const prisma = makePrisma()
  const arco = new PrismaArcoService(prisma)
  const registry = new EvmRegistryService(arco)

  await registry.sync({
    chainId: 91342,
    network: "giwa-sepolia",
    name: "GIWA Sepolia",
    publicRpcUrl: "https://sepolia-rpc.giwa.io",
    explorerUrl: "https://sepolia-explorer.giwa.io",
    releaseId: "release-a",
    assets: [
      {
        symbol: "tUSDC",
        name: "Test USDC",
        decimals: 6,
        tokenAddress: "0x00000000000000000000000000000000000000AA",
      },
    ],
    products: [
      {
        productId: "acapix",
        symbol: "aCAPIX",
        name: "Arco CAPIX",
        productTokenAddress: "0x00000000000000000000000000000000000000BB",
        paymentAssetSymbol: "tUSDC",
        paymentAssetAddress: "0x00000000000000000000000000000000000000AA",
        depositVaultAddress: "0x00000000000000000000000000000000000000CC",
        redemptionVaultAddress: "0x00000000000000000000000000000000000000DD",
        priceFeedAddress: "0x00000000000000000000000000000000000000EE",
      },
    ],
  })

  await registry.sync({
    chainId: 91342,
    network: "giwa-sepolia",
    name: "GIWA Sepolia",
    releaseId: "release-b",
    assets: [
      {
        symbol: "tUSDC",
        name: "Test USDC v2",
        decimals: 6,
        tokenAddress: "0x00000000000000000000000000000000000000AA",
      },
    ],
    products: [
      {
        productId: "acapix",
        symbol: "aCAPIX",
        name: "Arco CAPIX",
        productTokenAddress: "0x00000000000000000000000000000000000000BB",
        paymentAssetSymbol: "tUSDC",
        paymentAssetAddress: "0x00000000000000000000000000000000000000AA",
        depositVaultAddress: "0x00000000000000000000000000000000000000CC",
        redemptionVaultAddress: "0x00000000000000000000000000000000000000DD",
        priceFeedAddress: "0x00000000000000000000000000000000000000EE",
      },
    ],
  })

  const synced = await registry.getRegistry(91342)
  assert.equal(prisma.evmNetwork.rows.length, 1)
  assert.equal(prisma.evmAssetDeployment.rows.length, 1)
  assert.equal(prisma.evmProductDeployment.rows.length, 1)
  assert.equal((synced.assets[0] as Row).name, "Test USDC v2")
  assert.equal((synced.products[0] as Row).paymentAssetAddress, "0x00000000000000000000000000000000000000aa")
})

test("indexed event writes are idempotent on chainId txHash logIndex", async () => {
  const prisma = makePrisma()
  const arco = new PrismaArcoService(prisma)

  const event = {
    chainId: 91342,
    contractAddress: "0x00000000000000000000000000000000000000aa",
    blockNumber: 123n,
    blockHash: "0xblock",
    txHash: "0xtx",
    logIndex: 7,
    eventName: "ProductDeposit",
    args: { walletAddress: "0xabc" },
  }

  await arco.insertIndexedEvent(event)
  await arco.insertIndexedEvent(event)

  assert.equal(prisma.evmIndexedEvent.rows.length, 1)
  assert.equal(prisma.evmIndexedEvent.rows[0].eventName, "ProductDeposit")
})

test("indexed event persists blockTimestamp and activity returns it", async () => {
  const prisma = makePrisma()
  const arco = new PrismaArcoService(prisma)
  const blockTimestamp = new Date("2026-07-05T12:00:00.000Z")

  await arco.insertIndexedEvent({
    chainId: 91342,
    contractAddress: "0x00000000000000000000000000000000000000aa",
    blockNumber: 200n,
    blockHash: "0xblock",
    txHash: "0xtx2",
    logIndex: 0,
    eventName: "ProductDeposit",
    args: { walletAddress: "0xabc", sharesOut: "1000000000000000000" },
    blockTimestamp,
  })

  assert.equal((prisma.evmIndexedEvent.rows[0].blockTimestamp as Date).getTime(), blockTimestamp.getTime())

  const activity = (await arco.activityForWallet("0xABC", 91342)) as Row[]
  assert.equal(activity.length, 1)
  assert.equal((activity[0].blockTimestamp as Date).getTime(), blockTimestamp.getTime())
})

test("auth nonce is single-use and rejects reuse or expiry", async () => {
  const prisma = makePrisma()
  const arco = new PrismaArcoService(prisma)
  const now = new Date("2026-06-25T00:00:00.000Z")

  await arco.issueAuthNonce({
    walletAddress: "0xABC",
    domain: "arco.test",
    nonce: "nonce-ok",
    ttlSeconds: 300,
    now,
  })

  const consumed = await arco.consumeAuthNonce({
    walletAddress: "0xabc",
    domain: "arco.test",
    nonce: "nonce-ok",
    now: new Date("2026-06-25T00:01:00.000Z"),
  })
  const reused = await arco.consumeAuthNonce({
    walletAddress: "0xabc",
    domain: "arco.test",
    nonce: "nonce-ok",
    now: new Date("2026-06-25T00:02:00.000Z"),
  })

  await arco.issueAuthNonce({
    walletAddress: "0xabc",
    domain: "arco.test",
    nonce: "nonce-expired",
    ttlSeconds: 1,
    now,
  })
  const expired = await arco.consumeAuthNonce({
    walletAddress: "0xabc",
    domain: "arco.test",
    nonce: "nonce-expired",
    now: new Date("2026-06-25T00:00:02.000Z"),
  })

  assert.ok(consumed)
  assert.equal(reused, null)
  assert.equal(expired, null)
})

test("portfolio service exposes activity, redemptions, and faucet status from Prisma service", async () => {
  const prisma = makePrisma()
  prisma.indexedRedemptionRequest.rows.push({
    walletAddress: "0xabc",
    chainId: 91342,
    status: "REQUESTED",
    createdAt: new Date(),
  })
  const arco = new PrismaArcoService(prisma)
  await arco.insertIndexedEvent({
    chainId: 91342,
    contractAddress: "0x00000000000000000000000000000000000000aa",
    blockNumber: 1n,
    blockHash: "0xblock",
    txHash: "0xtx",
    logIndex: 0,
    eventName: "ProductRedeemRequested",
    args: { walletAddress: "0xabc" },
  })

  const portfolio = new EvmPortfolioService(arco)

  assert.equal((await portfolio.activity("0xABC", 91342)).length, 1)
  assert.equal((await portfolio.redemptions("0xABC", 91342)).length, 1)
  assert.equal((await portfolio.faucetStatus("0xABC", 91342)).available, true)
  assert.equal((await portfolio.portfolio("0xABC", 91342)).walletAddress, "0xabc")
})
