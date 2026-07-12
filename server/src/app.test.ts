import assert from "node:assert/strict"
import test from "node:test"
import { SiweMessage } from "siwe"
import { decodeFunctionData, formatUnits, getAddress, parseAbi, parseUnits } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { buildApp } from "./app.js"
import { buildDryRunGiwaRegistry } from "./registry/generate.js"
import { EvmMarketService } from "./services/evm-market-service.js"
import { EvmMonitoringService } from "./services/evm-monitoring-service.js"
import { EvmRegisterService, type RegisterProbe } from "./services/evm-register-service.js"
import { EvmPortfolioService } from "./services/evm-portfolio-service.js"
import { EvmRegistryService } from "./services/evm-registry-service.js"
import { PrismaArcoService, type PrismaLike } from "./services/prisma-arco-service.js"

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
    if (key === "eventName") {
      if (typeof value === "string" && row.eventName !== value) return false
      if (value && typeof value === "object" && Array.isArray((value as any).in) && !(value as any).in.includes(row.eventName))
        return false
    }
    if (key === "contractAddress") {
      if (typeof value === "string" && row.contractAddress !== value) return false
      if (
        value &&
        typeof value === "object" &&
        Array.isArray((value as any).in) &&
        !(value as any).in.includes(row.contractAddress)
      )
        return false
    }
    if (key === "productId" && row.productId !== value) return false
    if (key === "walletAddress" && row.walletAddress !== value) return false
    if (key === "redemptionVaultAddress" && row.redemptionVaultAddress !== value) return false
    if (key === "requestId" && row.requestId !== value) return false
    if (key === "domain" && row.domain !== value) return false
    if (key === "nonce" && row.nonce !== value) return false
    if (key === "status") {
      if (typeof value === "string" && row.status !== value) return false
      if (value && typeof value === "object" && Array.isArray((value as any).in) && !(value as any).in.includes(row.status))
        return false
    }
  }
  return true
}

function uniqueMatcher(where: Row): (row: Row) => boolean {
  if ("id" in where) return (row) => row.id === where.id
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
    // Harness stand-in for Prisma's atomic $transaction: the ops already execute against the
    // in-memory tables, so awaiting them together is sufficient (validation rejects before any
    // write, so the happy path is all we exercise). Not truly atomic — fine for tests.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
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

function deployedRegistry() {
  const registry = structuredClone(buildDryRunGiwaRegistry(new Date("2026-06-25T00:00:00.000Z"))) as any
  const addresses = Array.from({ length: 80 }, (_value, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`)
  const next = () => addresses.shift() as `0x${string}`
  registry.activationFlags = {
    deployed: true,
    dryRun: false,
    frontendEnabled: false,
    indexerEnabled: true,
    onchainAttestationRequired: true,
  }
  registry.deploymentBlock = 10
  registry.deployer = next()
  registry.proxyAdmin = { proxy: next(), implementation: next(), bytecodeHash: "0x01" }
  registry.faucet = { proxy: next(), implementation: next(), bytecodeHash: "0x02" }
  registry.assets = registry.assets.map((asset: any) => ({
    ...asset,
    contract: { proxy: next(), implementation: next(), bytecodeHash: "0x03" },
    faucet: registry.faucet.proxy,
    deploymentBlock: 10,
  }))
  registry.products = registry.products.map((product: any) => ({
    ...product,
    productToken: { proxy: next(), implementation: next(), bytecodeHash: "0x04" },
    depositVault: { proxy: next(), implementation: next(), bytecodeHash: "0x05" },
    redemptionVault: { proxy: next(), implementation: next(), bytecodeHash: "0x06" },
    priceFeed: { proxy: next(), implementation: next(), bytecodeHash: "0x07" },
    deploymentBlock: 10,
  }))
  return registry as ReturnType<typeof buildDryRunGiwaRegistry>
}

// All-green on-chain probe derived from the fixture registry itself: addresses, impl
// records and bytecode hashes line up, all roles granted. Tests override pieces of it
// to exercise each failure branch of the register route.
function matchingProbe(product: Row, registry: Row): RegisterProbe {
  const paymentToken =
    registry.assets.find((asset: Row) => asset.symbol === product.paymentAssetSymbol)?.contract.proxy ?? null
  const per = (pick: (slot: Row) => any) => ({
    productToken: pick(product.productToken),
    depositVault: pick(product.depositVault),
    redemptionVault: pick(product.redemptionVault),
    priceFeed: pick(product.priceFeed),
  })
  return {
    code: per(() => true),
    token: { symbol: product.symbol, name: product.name, decimals: 18 },
    depositPaymentToken: paymentToken,
    redemptionPaymentToken: paymentToken,
    roles: {
      feedAdmin: true,
      depositVaultAdmin: true,
      depositPauser: true,
      redemptionVaultAdmin: true,
      redemptionPauser: true,
      minterIsDepositVault: true,
      burnerIsRedemptionVault: true,
    },
    proxyAdmins: per(() => registry.proxyAdmin.proxy),
    implementations: per((slot) => slot.implementation),
    implCodeHashes: per((slot) => slot.bytecodeHash),
    proxyAdminOwner: registry.deployer,
  }
}

function extraProduct() {
  const addr = (n: number) => `0x${(0xa000 + n).toString(16).padStart(40, "0")}`
  return {
    productId: "anew",
    symbol: "aNEW",
    name: "Arco NEW",
    paymentAssetSymbol: "tUSDC",
    productToken: { proxy: addr(1), implementation: addr(2), bytecodeHash: "0x14" },
    depositVault: { proxy: addr(3), implementation: addr(4), bytecodeHash: "0x15" },
    redemptionVault: { proxy: addr(5), implementation: addr(6), bytecodeHash: "0x16" },
    priceFeed: { proxy: addr(7), implementation: addr(8), bytecodeHash: "0x17" },
    deploymentBlock: 10,
    activationFlags: {},
  }
}

function makeApp(options?: {
  supplies?: Record<string, { supply: string; decimals: number }>
  balances?: Record<string, string>
  pauseStates?: Record<
    string,
    { depositPaused: boolean; withdrawPaused: boolean; depositPartial: boolean; withdrawPartial: boolean }
  >
  extraProducts?: Row[]
  registerProbe?: (product: Row, registry: Row) => RegisterProbe | null
  vaultLimits?: {
    minimumDeposit: string
    maxSupplyCap: string
    vaultMintAllowance: string
    minimumRedeem: string
    vaultRedeemAllowance: string
  } | null
}) {
  const prisma = makePrisma()
  const arco = new PrismaArcoService(prisma as PrismaLike)
  const registry = new EvmRegistryService(arco)
  const portfolio = new EvmPortfolioService(arco)
  const fullRegistry = deployedRegistry()
  if (options?.extraProducts) (fullRegistry as any).products.push(...options.extraProducts)
  const registerService = new EvmRegisterService({
    arco,
    loadRegistry: () => fullRegistry,
    probeProduct: async (product, probeRegistry) =>
      (options?.registerProbe ?? matchingProbe)(product as Row, probeRegistry as Row),
  })
  const market = new EvmMarketService({
    arco,
    loadRegistry: () => fullRegistry,
    fetchRates: async () => ({ USDC: 1, BTC: 60000, ETH: 3000, XRP: 0.5 }),
  })
  const monitoring = new EvmMonitoringService({
    arco,
    market,
    loadRegistry: () => fullRegistry,
    readShareSupply: async (tokenAddress) =>
      options?.supplies?.[tokenAddress.toLowerCase()] ?? { supply: "0", decimals: 18 },
    readTokenBalances: async (_tokenAddress, addresses) =>
      Object.fromEntries(addresses.map((address) => [address, options?.balances?.[address] ?? "0"])),
  })
  const app = buildApp(
    {
      corsAllowedOrigins: ["http://localhost:5173"],
      authNonceTtlSeconds: 300,
      authJwtSecret: "test-secret-test-secret-test-secret",
      adminOperatorToken: "operator-token",
      registryPath: "unused",
    },
    {
      arco,
      registry,
      portfolio,
      readiness: { check: async () => ({ ok: true, checks: { db: { ok: true } } }) },
      loadRegistry: () => fullRegistry,
      market,
      monitoring,
      register: registerService,
      ...(options?.pauseStates
        ? { readPauseState: async () => options.pauseStates ?? null }
        : {}),
      // `vaultLimits: undefined` leaves the reader absent (→ 503); an explicit value (or null)
      // installs a stub returning it.
      ...("vaultLimits" in (options ?? {}) ? { readVaultLimits: async () => options!.vaultLimits ?? null } : {}),
    },
  )
  return { app, prisma, registry: fullRegistry }
}

test("public routes and readiness do not require admin credentials", async () => {
  const { app } = makeApp()
  const health = await app.inject({ method: "GET", url: "/health" })
  const ready = await app.inject({ method: "GET", url: "/ready" })
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })

  assert.equal(health.statusCode, 200)
  assert.equal(ready.statusCode, 200)
  assert.equal(catalog.statusCode, 200)
  assert.ok(catalog.json().length >= 6)
})

test("catalog route serializes BigInt-backed registry rows as decimal strings", async () => {
  const fileRegistry = deployedRegistry()
  const deploymentBlock = 29212771n
  const dbRegistry = {
    network: { chainId: 91342, network: "giwa-sepolia", latestRegistryId: "bigint-fixture" },
    assets: fileRegistry.assets.map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      tokenAddress: asset.contract.proxy,
      faucetAddress: asset.faucet,
      deploymentBlock,
    })),
    products: fileRegistry.products.map((product, index) => ({
      productId: product.productId,
      symbol: product.symbol,
      name: product.name,
      productTokenAddress: product.productToken.proxy,
      paymentAssetSymbol: product.paymentAssetSymbol,
      paymentAssetAddress: fileRegistry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)?.contract.proxy,
      depositVaultAddress: product.depositVault.proxy,
      redemptionVaultAddress: product.redemptionVault.proxy,
      priceFeedAddress: product.priceFeed.proxy,
      deploymentBlock: deploymentBlock + BigInt(index),
      activationFlags: product.activationFlags,
    })),
  }
  const app = buildApp(
    {
      corsAllowedOrigins: ["http://localhost:5173"],
      authNonceTtlSeconds: 300,
      authJwtSecret: "test-secret-test-secret-test-secret",
      adminOperatorToken: "operator-token",
      registryPath: "unused",
    },
    {
      arco: { vaultConfigs: async () => [] } as any,
      registry: {
        listNetworks: async () => [],
        getRegistry: async () => dbRegistry,
      } as any,
      portfolio: {} as any,
      readiness: { check: async () => ({ ok: true, checks: { db: { ok: true } } }) },
      loadRegistry: () => fileRegistry,
    },
  )

  const response = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const body = response.json()

  assert.equal(response.statusCode, 200)
  assert.ok(body.length >= 6)
  assert.equal(body[0].deploymentBlock, "29212771")
  assert.equal(body[0].paymentAsset.deploymentBlock, "29212771")
})

const OPERATOR = { "x-operator-token": "operator-token" }

async function catalogProductIds(app: ReturnType<typeof makeApp>["app"]): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  return (res.json() as { productId: string }[]).map((product) => product.productId)
}

test("featured cards: add starts hidden, public read is shown-only, admin can register/hide/remove", async () => {
  const { app } = makeApp()
  const [p0] = await catalogProductIds(app)

  // Operator-guarded write.
  const denied = await app.inject({ method: "POST", url: "/api/v1/admin/featured/91342", payload: { productId: p0 } })
  assert.equal(denied.statusCode, 401)

  // Add → starts HIDDEN (shown=false), about null, position 0.
  const added = await app.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId: p0 } })
  assert.equal(added.statusCode, 200)
  assert.equal(added.json().shown, false)
  assert.equal(added.json().about, null)
  assert.equal(added.json().position, 0)
  const id = added.json().id as string

  // Public carousel read excludes hidden cards.
  const publicHidden = await app.inject({ method: "GET", url: "/api/v1/evm/featured/91342" })
  assert.equal(publicHidden.statusCode, 200)
  assert.deepEqual(publicHidden.json().cards, [])

  // Register (show) + set about.
  const shown = await app.inject({
    method: "PUT",
    url: `/api/v1/admin/featured/91342/${id}`,
    headers: OPERATOR,
    payload: { shown: true, about: "  Featured intro  " },
  })
  assert.equal(shown.statusCode, 200)
  assert.equal(shown.json().shown, true)
  assert.equal(shown.json().about, "Featured intro") // trimmed

  // Public read now includes it.
  const publicShown = await app.inject({ method: "GET", url: "/api/v1/evm/featured/91342" })
  assert.equal(publicShown.json().cards.length, 1)
  assert.equal(publicShown.json().cards[0].productId, p0)

  // Admin list shows it; DELETE removes; second DELETE 404s.
  const adminList = await app.inject({ method: "GET", url: "/api/v1/admin/featured/91342", headers: OPERATOR })
  assert.equal(adminList.json().cards.length, 1)
  const removed = await app.inject({ method: "DELETE", url: `/api/v1/admin/featured/91342/${id}`, headers: OPERATOR })
  assert.equal(removed.statusCode, 200)
  assert.equal(removed.json().ok, true)
  const removeAgain = await app.inject({ method: "DELETE", url: `/api/v1/admin/featured/91342/${id}`, headers: OPERATOR })
  assert.equal(removeAgain.statusCode, 404)
})

test("featured cards: max 3 total rows; duplicate 409; non-eligible + about>140 rejected", async () => {
  const { app } = makeApp()
  const ids = await catalogProductIds(app)
  assert.ok(ids.length >= 4, "fixture needs >= 4 deployed products")

  for (const productId of ids.slice(0, 3)) {
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId } })
    assert.equal(res.statusCode, 200)
  }
  const fourth = await app.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId: ids[3] } })
  assert.equal(fourth.statusCode, 400)
  assert.match(fourth.json().error, /maximum/i)

  // Fresh app for the remaining branches (avoid the max cap).
  const { app: app2 } = makeApp()
  const ids2 = await catalogProductIds(app2)
  await app2.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId: ids2[0] } })
  const dup = await app2.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId: ids2[0] } })
  assert.equal(dup.statusCode, 409)

  const bad = await app2.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId: "not-a-vault" } })
  assert.equal(bad.statusCode, 400)

  const longAbout = await app2.inject({
    method: "POST",
    url: "/api/v1/admin/featured/91342",
    headers: OPERATOR,
    payload: { productId: ids2[1], about: "x".repeat(141) },
  })
  assert.equal(longAbout.statusCode, 400)
  assert.match(longAbout.json().error, /140/)
})

test("featured cards: a hidden vault cannot be featured", async () => {
  const { app } = makeApp()
  const [p0] = await catalogProductIds(app)
  const hide = await app.inject({ method: "PUT", url: `/api/v1/admin/vault-config/91342/${p0}`, headers: OPERATOR, payload: { hidden: true } })
  assert.equal(hide.statusCode, 200)
  const res = await app.inject({ method: "POST", url: "/api/v1/admin/featured/91342", headers: OPERATOR, payload: { productId: p0 } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /non-hidden/)
})

test("SIWE nonce is single-use and attestations require a valid session", async () => {
  const { app, prisma } = makeApp()
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945384dbb2c0f25b563eab2bfb184c3f8816d1")
  const nonceResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/nonce",
    payload: { walletAddress: account.address, domain: "localhost" },
  })
  assert.equal(nonceResponse.statusCode, 200)
  const nonce = nonceResponse.json().nonce as string
  const message = new SiweMessage({
    domain: "localhost",
    address: account.address,
    statement: "Sign in to Arco GIWA",
    uri: "http://localhost",
    version: "1",
    chainId: 91342,
    nonce,
  }).prepareMessage()
  const signature = await account.signMessage({ message })

  const verifyResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { message, signature },
  })
  const replayResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { message, signature },
  })
  const token = verifyResponse.json().token as string
  const attestationResponse = await app.inject({
    method: "POST",
    url: "/api/v1/attestations",
    headers: { authorization: `Bearer ${token}` },
    payload: { statement: "Accredited test attestation", signature: "0x1234" },
  })

  assert.equal(verifyResponse.statusCode, 200)
  assert.equal(replayResponse.statusCode, 401)
  assert.equal(attestationResponse.statusCode, 200)
  assert.equal(prisma.walletAttestation.rows.length, 1)
})

test("admin endpoints are gated and return unsigned transactions only", async () => {
  const { app, prisma, registry } = makeApp()
  const wallet = "0x00000000000000000000000000000000000000aa"
  const denied = await app.inject({
    method: "POST",
    url: `/api/v1/admin/wallets/${wallet}/greenlist`,
  })
  const greenlist = await app.inject({
    method: "POST",
    url: `/api/v1/admin/wallets/${wallet}/greenlist`,
    headers: { "x-operator-token": "operator-token" },
  })
  const price = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/price",
    headers: { "x-operator-token": "operator-token" },
    payload: { answer: "1000000000000000000" },
  })
  const healthyDiff = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/healthy-diff",
    headers: { "x-operator-token": "operator-token" },
    payload: { seconds: "31536000" },
  })
  const healthyDiffBadBody = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/healthy-diff",
    headers: { "x-operator-token": "operator-token" },
    payload: {},
  })
  prisma.indexedRedemptionRequest.rows.push({
    chainId: 91342,
    requestId: "1",
    redemptionVaultAddress: registry.products[0].redemptionVault.proxy?.toLowerCase(),
    createdAt: new Date(),
  })
  const fulfill = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/1/fulfill",
    headers: { "x-operator-token": "operator-token" },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(greenlist.statusCode, 200)
  assert.equal(price.statusCode, 200)
  assert.equal(healthyDiff.statusCode, 200)
  assert.match(healthyDiff.json().transaction.data, /^0x/)
  assert.equal(healthyDiffBadBody.statusCode, 400)
  assert.equal(fulfill.statusCode, 200)
  const tx = greenlist.json().transactions[0]
  assert.equal(tx.value, "0x0")
  assert.match(tx.data, /^0x/)
  assert.equal("signature" in tx, false)
  assert.equal("privateKey" in tx, false)
})

test("vault-management admin routes: withdraw, pending list, payout double-pay guard, settle", async () => {
  const { app, prisma, registry } = makeApp()
  const acapix = registry.products.find((product: any) => product.productId === "acapix")!
  const requester = "0x00000000000000000000000000000000000000bb"
  prisma.indexedRedemptionRequest.rows.push({
    chainId: 91342,
    requestId: "7",
    walletAddress: requester,
    productId: "acapix",
    redemptionVaultAddress: acapix.redemptionVault.proxy?.toLowerCase(),
    sharesIn: "5000000000000000000",
    lockedAssetsOut: "5001000",
    status: "REQUESTED",
    createdAt: new Date(),
  })

  // withdraw: operator-guarded, validates `to`, targets the deposit vault
  const withdrawDenied = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/withdraw" })
  assert.equal(withdrawDenied.statusCode, 401)
  const withdrawBadTo = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/withdraw",
    headers: { "x-operator-token": "operator-token" },
    payload: { to: "not-an-address", amount: "1000000" },
  })
  assert.equal(withdrawBadTo.statusCode, 400)
  const withdraw = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/withdraw",
    headers: { "x-operator-token": "operator-token" },
    payload: { to: requester, amount: "1000000" },
  })
  assert.equal(withdraw.statusCode, 200)
  assert.equal(withdraw.json().transaction.to.toLowerCase(), acapix.depositVault.proxy?.toLowerCase())

  // pending list contains the REQUESTED row
  const pending = await app.inject({
    method: "GET",
    url: "/api/v1/admin/redemptions/pending",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(pending.statusCode, 200)
  assert.equal(pending.json().redemptions.length, 1)
  assert.equal(pending.json().redemptions[0].requestId, "7")

  // payout: builds the payment-asset transfer AND claims REQUESTED -> SETTLING
  const payout = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/payout",
    headers: { "x-operator-token": "operator-token" },
    payload: { amount: "5001000" },
  })
  assert.equal(payout.statusCode, 200)
  const paymentAsset = registry.assets.find((asset: any) => asset.symbol === acapix.paymentAssetSymbol)!
  assert.equal(payout.json().transaction.to.toLowerCase(), paymentAsset.contract.proxy?.toLowerCase())
  assert.equal(prisma.indexedRedemptionRequest.rows[0].status, "SETTLING")

  // double-pay guards: second payout 409s; fulfill 409s while settling
  const payoutAgain = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/payout",
    headers: { "x-operator-token": "operator-token" },
    payload: { amount: "5001000" },
  })
  assert.equal(payoutAgain.statusCode, 409)
  const fulfillWhileSettling = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/fulfill",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(fulfillWhileSettling.statusCode, 409)

  // settle: bad hash 400; good hash persists SETTLED + tx hash; pending list drains
  const settleBadHash = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/settle",
    headers: { "x-operator-token": "operator-token" },
    payload: { txHash: "0x123" },
  })
  assert.equal(settleBadHash.statusCode, 400)
  const payoutTxHash = `0x${"ab".repeat(32)}`
  const settle = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/settle",
    headers: { "x-operator-token": "operator-token" },
    payload: { txHash: payoutTxHash },
  })
  assert.equal(settle.statusCode, 200)
  assert.equal(prisma.indexedRedemptionRequest.rows[0].status, "SETTLED")
  assert.equal(prisma.indexedRedemptionRequest.rows[0].settledTxHash, payoutTxHash)
  const pendingAfter = await app.inject({
    method: "GET",
    url: "/api/v1/admin/redemptions/pending",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(pendingAfter.json().redemptions.length, 0)

  // post-settlement guards: settle and fulfill both 409
  const settleAgain = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/settle",
    headers: { "x-operator-token": "operator-token" },
    payload: { txHash: payoutTxHash },
  })
  assert.equal(settleAgain.statusCode, 409)
  const fulfillAfterSettle = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/7/fulfill",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(fulfillAfterSettle.statusCode, 409)
})

// setLimits ABIs (same fragments the builder encodes) to decode the produced calldata.
const depositLimitsAbi = parseAbi([
  "function setLimits(uint256 minimumDeposit_, uint256 maxSupplyCap_, uint256 vaultMintAllowance_)",
])
const redemptionLimitsAbi = parseAbi(["function setLimits(uint256 minimumRedeem_, uint256 vaultRedeemAllowance_)"])

test("deposit-limits builds setLimits with human->raw per decimals (payment vs 18-dec shares), targeting the deposit vault", async () => {
  const { app, registry } = makeApp()
  const acapix = registry.products.find((product: any) => product.productId === "acapix")!
  const paymentDecimals = registry.assets.find((asset: any) => asset.symbol === acapix.paymentAssetSymbol)!.decimals

  const denied = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/deposit-limits" })
  assert.equal(denied.statusCode, 401)

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/deposit-limits",
    headers: OPERATOR,
    payload: { minimumDeposit: "100", maxSupplyCap: "50000000", vaultMintAllowance: "1000000" },
  })
  assert.equal(res.statusCode, 200)
  const transaction = res.json().transaction
  assert.equal(transaction.to.toLowerCase(), acapix.depositVault.proxy?.toLowerCase()) // deposit vault, not redemption
  assert.equal(transaction.value, "0x0")
  const decoded = decodeFunctionData({ abi: depositLimitsAbi, data: transaction.data })
  assert.equal(decoded.functionName, "setLimits")
  assert.deepEqual(decoded.args, [
    parseUnits("100", paymentDecimals), // minimumDeposit = PAYMENT units
    parseUnits("50000000", 18), // maxSupplyCap = 18-dec shares
    parseUnits("1000000", 18), // vaultMintAllowance = 18-dec shares
  ])
  // The API never signs: no secret material in the payload.
  assert.ok(!("signature" in transaction) && !("privateKey" in transaction))
})

test("redemption-limits builds setLimits with shares/payment scaling, targeting the redemption vault", async () => {
  const { app, registry } = makeApp()
  const acapix = registry.products.find((product: any) => product.productId === "acapix")!
  const paymentDecimals = registry.assets.find((asset: any) => asset.symbol === acapix.paymentAssetSymbol)!.decimals

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/redemption-limits",
    headers: OPERATOR,
    payload: { minimumRedeem: "0.5", vaultRedeemAllowance: "250000" },
  })
  assert.equal(res.statusCode, 200)
  const transaction = res.json().transaction
  assert.equal(transaction.to.toLowerCase(), acapix.redemptionVault.proxy?.toLowerCase()) // redemption vault, NOT deposit
  const decoded = decodeFunctionData({ abi: redemptionLimitsAbi, data: transaction.data })
  assert.deepEqual(decoded.args, [
    parseUnits("0.5", 18), // minimumRedeem = 18-dec shares
    parseUnits("250000", paymentDecimals), // vaultRedeemAllowance = PAYMENT units
  ])
})

test("limit routes reject a 0 cap (400) and malformed/missing fields (400); no >= constraint blocks", async () => {
  const { app } = makeApp()
  const base = { minimumDeposit: "0", maxSupplyCap: "1000", vaultMintAllowance: "500" }

  // minimumDeposit MAY be 0 (no floor) but the 3 caps may not.
  const zeroCap = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/deposit-limits", headers: OPERATOR, payload: { ...base, maxSupplyCap: "0" } })
  assert.equal(zeroCap.statusCode, 400)
  const zeroAllow = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/deposit-limits", headers: OPERATOR, payload: { ...base, vaultMintAllowance: "0" } })
  assert.equal(zeroAllow.statusCode, 400)
  const zeroRedeemAllow = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/redemption-limits", headers: OPERATOR, payload: { minimumRedeem: "1", vaultRedeemAllowance: "0" } })
  assert.equal(zeroRedeemAllow.statusCode, 400)

  // Missing / non-numeric → 400.
  const missing = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/deposit-limits", headers: OPERATOR, payload: { maxSupplyCap: "1000", vaultMintAllowance: "500" } })
  assert.equal(missing.statusCode, 400)
  const junk = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/deposit-limits", headers: OPERATOR, payload: { ...base, maxSupplyCap: "abc" } })
  assert.equal(junk.statusCode, 400)

  // No >= vaultMintAllowance/maxSupplyCap constraint: allowance BELOW cap is accepted (matches deployed vaults).
  const belowCap = await app.inject({ method: "POST", url: "/api/v1/admin/products/acapix/deposit-limits", headers: OPERATOR, payload: { minimumDeposit: "0", maxSupplyCap: "50000000", vaultMintAllowance: "1000000" } })
  assert.equal(belowCap.statusCode, 200)
})

test("GET limits de-scales raw on-chain values to human units per decimals; 503 when the reader is absent", async () => {
  const raw = {
    minimumDeposit: "100000000", // 100 @ 6-dec payment
    maxSupplyCap: "50000000000000000000000000", // 50,000,000 @ 18-dec
    vaultMintAllowance: "1000000000000000000000000", // 1,000,000 @ 18-dec
    minimumRedeem: "500000000000000000", // 0.5 @ 18-dec
    vaultRedeemAllowance: "250000000000", // 250,000 @ 6-dec payment
  }
  const { app, registry } = makeApp({ vaultLimits: raw })
  const paymentDecimals = registry.assets.find((asset: any) => asset.symbol === "tUSDC")!.decimals

  const gated = await app.inject({ method: "GET", url: "/api/v1/admin/products/acapix/limits" })
  assert.equal(gated.statusCode, 401)

  const res = await app.inject({ method: "GET", url: "/api/v1/admin/products/acapix/limits", headers: OPERATOR })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.paymentDecimals, paymentDecimals)
  assert.equal(body.limits.deposit.minimumDeposit, formatUnits(BigInt(raw.minimumDeposit), paymentDecimals))
  assert.equal(body.limits.deposit.maxSupplyCap, formatUnits(BigInt(raw.maxSupplyCap), 18))
  assert.equal(body.limits.redemption.minimumRedeem, formatUnits(BigInt(raw.minimumRedeem), 18))
  assert.equal(body.limits.redemption.vaultRedeemAllowance, formatUnits(BigInt(raw.vaultRedeemAllowance), paymentDecimals))

  // Reader absent (makeApp with no vaultLimits option) → 503; unknown product → 404.
  const { app: appNoReader } = makeApp()
  const absent = await appNoReader.inject({ method: "GET", url: "/api/v1/admin/products/acapix/limits", headers: OPERATOR })
  assert.equal(absent.statusCode, 503)
  const unknown = await app.inject({ method: "GET", url: "/api/v1/admin/products/nope/limits", headers: OPERATOR })
  assert.equal(unknown.statusCode, 404)
})

test("release recovers a cancelled payout (SETTLING -> REQUESTED) but never re-opens SETTLED", async () => {
  const { app, prisma, registry } = makeApp()
  const acapix = registry.products.find((product: any) => product.productId === "acapix")!
  prisma.indexedRedemptionRequest.rows.push({
    chainId: 91342,
    requestId: "9",
    walletAddress: "0x00000000000000000000000000000000000000cc",
    productId: "acapix",
    redemptionVaultAddress: acapix.redemptionVault.proxy?.toLowerCase(),
    sharesIn: "1000000000000000000",
    lockedAssetsOut: "1000200",
    status: "REQUESTED",
    createdAt: new Date(),
  })
  const operator = { "x-operator-token": "operator-token" }

  // guards: 401 without token; 409 while still REQUESTED (nothing to release)
  const releaseDenied = await app.inject({ method: "POST", url: "/api/v1/admin/redemptions/9/release" })
  assert.equal(releaseDenied.statusCode, 401)
  const releaseRequested = await app.inject({ method: "POST", url: "/api/v1/admin/redemptions/9/release", headers: operator })
  assert.equal(releaseRequested.statusCode, 409)

  // claim -> release -> the request is payable again
  const claim = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/9/payout",
    headers: operator,
    payload: { amount: "1000200" },
  })
  assert.equal(claim.statusCode, 200)
  assert.equal(prisma.indexedRedemptionRequest.rows[0].status, "SETTLING")
  const release = await app.inject({ method: "POST", url: "/api/v1/admin/redemptions/9/release", headers: operator })
  assert.equal(release.statusCode, 200)
  assert.equal(prisma.indexedRedemptionRequest.rows[0].status, "REQUESTED")
  const reclaim = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/9/payout",
    headers: operator,
    payload: { amount: "1000200" },
  })
  assert.equal(reclaim.statusCode, 200)

  // once settled, release must refuse — a landed payout can never be re-opened
  const settle = await app.inject({
    method: "POST",
    url: "/api/v1/admin/redemptions/9/settle",
    headers: operator,
    payload: { txHash: `0x${"cd".repeat(32)}` },
  })
  assert.equal(settle.statusCode, 200)
  const releaseAfterSettle = await app.inject({ method: "POST", url: "/api/v1/admin/redemptions/9/release", headers: operator })
  assert.equal(releaseAfterSettle.statusCode, 409)
  assert.equal(prisma.indexedRedemptionRequest.rows[0].status, "SETTLED")
})

test("market + history routes return nav/apy from indexed PriceUpdated (apy only for configured products)", async () => {
  const { app, prisma, registry } = makeApp()
  const acapix = registry.products.find((product: any) => product.productId === "acapix")!
  prisma.evmIndexedEvent.rows.push({
    chainId: 91342,
    eventName: "PriceUpdated",
    contractAddress: String(acapix.priceFeed.proxy).toLowerCase(),
    blockNumber: 100n,
    blockHash: "0x0",
    txHash: "0xprice",
    logIndex: 0,
    args: { roundId: "1", answer: "100000000", updatedAt: "1700000000" },
  })

  const market = await app.inject({ method: "GET", url: "/api/v1/evm/market/91342" })
  assert.equal(market.statusCode, 200)
  const entries = market.json()
  const acapixEntry = entries.find((entry: any) => entry.productId === "acapix")
  assert.equal(acapixEntry.apy, 11.58)
  assert.equal(acapixEntry.navBase, 1)
  assert.equal(acapixEntry.baseUsd, 1)
  assert.equal(acapixEntry.navUsd, 1)
  const otherEntry = entries.find((entry: any) => entry.productId !== "acapix")
  assert.equal(otherEntry.apy, null)

  const history = await app.inject({ method: "GET", url: "/api/v1/evm/market/91342/acapix/history" })
  assert.equal(history.statusCode, 200)
  const body = history.json()
  assert.equal(body.apy, 11.58)
  assert.equal(body.points.length, 1)
  assert.equal(body.points[0].navBase, 1)
  assert.equal(body.points[0].navUsd, 1)
})

test("market impliedApy: registered non-builtin with ≥2 posts computes; <2 posts and built-ins stay null (apy unchanged)", async () => {
  const { app, prisma, registry } = makeApp({ extraProducts: [extraProduct()] })
  const anew = registry.products.find((product: any) => product.productId === "anew")!
  const acapix = registry.products.find((product: any) => product.productId === "acapix")!
  const priceRow = (feed: string | null, txHash: string, blockNumber: bigint, answer: string, updatedAt: string) => ({
    chainId: 91342,
    eventName: "PriceUpdated",
    contractAddress: String(feed).toLowerCase(),
    blockNumber,
    blockHash: "0x0",
    txHash,
    logIndex: 0,
    args: { roundId: txHash, answer, updatedAt },
  })
  // aNEW (a newly-registered vault): two posts, +2% over exactly 365 days → implied APY 2.0%.
  prisma.evmIndexedEvent.rows.push(
    priceRow(anew.priceFeed.proxy, "0xa1", 10n, "100000000", "1700000000"),
    priceRow(anew.priceFeed.proxy, "0xa2", 20n, "102000000", "1731536000"),
  )
  // aCAPIX (built-in): a single post — not enough to imply an APY.
  prisma.evmIndexedEvent.rows.push(priceRow(acapix.priceFeed.proxy, "0xc1", 10n, "100000000", "1700000000"))

  const res = await app.inject({ method: "GET", url: "/api/v1/evm/market/91342" })
  assert.equal(res.statusCode, 200)
  const entries = res.json()

  const anewEntry = entries.find((entry: any) => entry.productId === "anew")
  assert.equal(anewEntry.apy, null) // no published/static rate for a registered vault
  assert.equal(anewEntry.navBase, 1.02) // latest post
  assert.ok(anewEntry.impliedApy !== null && Math.abs(anewEntry.impliedApy - 2) < 1e-9)

  const acapixEntry = entries.find((entry: any) => entry.productId === "acapix")
  assert.equal(acapixEntry.apy, 11.58) // built-in static rate unchanged
  assert.equal(acapixEntry.impliedApy, null) // <2 posts → no implied APY

  // A built-in with zero indexed posts → both apy paths null (unchanged).
  const zeroPost = entries.find((entry: any) => entry.productId !== "anew" && entry.productId !== "acapix")
  assert.equal(zeroPost.impliedApy, null)
})

test("monitoring routes require the operator credential", async () => {
  const { app } = makeApp()
  const overview = await app.inject({ method: "GET", url: "/api/v1/admin/monitoring/91342/overview" })
  assert.equal(overview.statusCode, 401)
})

test("monitoring overview sums TVL and outstanding/today pending values", async () => {
  const supplies: Record<string, { supply: string; decimals: number }> = {}
  const registryProbe = deployedRegistry()
  const acapixProbe = registryProbe.products.find((product: any) => product.productId === "acapix")! as any
  supplies[String(acapixProbe.productToken.proxy).toLowerCase()] = {
    supply: "1000000000000000000000", // 1000 shares
    decimals: 18,
  }
  const { app, prisma, registry } = makeApp({ supplies })
  const acapix = registry.products.find((product: any) => product.productId === "acapix")! as any

  prisma.evmIndexedEvent.rows.push({
    chainId: 91342,
    eventName: "PriceUpdated",
    contractAddress: String(acapix.priceFeed.proxy).toLowerCase(),
    blockNumber: 100n,
    blockHash: "0x0",
    txHash: "0xprice1",
    logIndex: 0,
    args: { roundId: "1", answer: "100000000", updatedAt: "1700000000" }, // navBase 1, tUSDC => navUsd 1
  })

  const oldDate = new Date("2026-01-01T12:00:00.000Z")
  prisma.indexedRedemptionRequest.rows.push(
    {
      chainId: 91342,
      productId: "acapix",
      requestId: "1",
      walletAddress: "0x00000000000000000000000000000000000000aa",
      redemptionVaultAddress: String(acapix.redemptionVault.proxy).toLowerCase(),
      sharesIn: "500000000000000000000",
      lockedAssetsOut: "500000000", // 500 tUSDC (6 decimals) => $500
      status: "REQUESTED",
      createdAt: oldDate,
    },
    {
      chainId: 91342,
      productId: "acapix",
      requestId: "2",
      walletAddress: "0x00000000000000000000000000000000000000ab",
      redemptionVaultAddress: String(acapix.redemptionVault.proxy).toLowerCase(),
      sharesIn: "250000000000000000000",
      lockedAssetsOut: "250000000", // $250, created today
      status: "SETTLING",
      createdAt: new Date(),
    },
    {
      chainId: 91342,
      productId: "acapix",
      requestId: "3",
      walletAddress: "0x00000000000000000000000000000000000000ac",
      redemptionVaultAddress: String(acapix.redemptionVault.proxy).toLowerCase(),
      sharesIn: "990000000000000000000",
      lockedAssetsOut: "990000000", // settled — must not count anywhere
      status: "SETTLED",
      createdAt: oldDate,
      settledAt: oldDate,
    },
  )

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/monitoring/91342/overview",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.vaultCount, 6)
  assert.equal(body.tvlUsd, 1000) // 1000 shares x navUsd 1; zero-supply vaults contribute 0
  assert.equal(body.complete.tvl, true)
  assert.equal(body.pendingOutstandingCount, 2)
  assert.equal(body.pendingOutstandingUsd, 750)
  assert.equal(body.pendingTodayCount, 1)
  assert.equal(body.pendingTodayUsd, 250)
  assert.equal(body.complete.pending, true)
})

test("monitoring overview: unpriceable vaults are 0-contribution in TVL (flagged incomplete); pending totals stay null-guarded", async () => {
  const supplies: Record<string, { supply: string; decimals: number }> = {}
  const registryProbe = deployedRegistry()
  const abtcProbe = registryProbe.products.find((product: any) => product.productId === "abtc")! as any
  supplies[String(abtcProbe.productToken.proxy).toLowerCase()] = {
    supply: "5000000000000000000", // 5 shares but no price posted => that vault is unpriceable
    decimals: 18,
  }
  const { app, prisma, registry } = makeApp({ supplies })
  const aeth = registry.products.find((product: any) => product.productId === "aeth")! as any

  // Pending row with no locked quote and no NAV for the product => row value unknown.
  prisma.indexedRedemptionRequest.rows.push({
    chainId: 91342,
    productId: "aeth",
    requestId: "9",
    walletAddress: "0x00000000000000000000000000000000000000ad",
    redemptionVaultAddress: String(aeth.redemptionVault.proxy).toLowerCase(),
    sharesIn: "1000000000000000000",
    lockedAssetsOut: "0",
    status: "REQUESTED",
    createdAt: new Date(),
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/monitoring/91342/overview",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  // abtc is unpriceable (null contribution), every other vault has zero supply (exact 0):
  // the aggregate is the partial sum 0 — not null — with complete.tvl flagging the gap.
  assert.equal(body.tvlUsd, 0)
  assert.equal(body.complete.tvl, false)
  assert.equal(body.pendingOutstandingCount, 1) // counts stay exact
  assert.equal(body.pendingOutstandingUsd, null)
  assert.equal(body.pendingTodayUsd, null)
  assert.equal(body.complete.pending, false)
})

test("monitoring overview TVL partial-sums non-null vaults and is null only when all are null", async () => {
  const supplies: Record<string, { supply: string; decimals: number }> = {}
  const registryProbe = deployedRegistry()
  const probe = (id: string) => registryProbe.products.find((product: any) => product.productId === id)! as any
  supplies[String(probe("aeth").productToken.proxy).toLowerCase()] = { supply: "1000000000000000000", decimals: 18 } // 1 share
  supplies[String(probe("umint").productToken.proxy).toLowerCase()] = { supply: "20000000000000000000", decimals: 18 } // 20 shares
  supplies[String(probe("abtc").productToken.proxy).toLowerCase()] = { supply: "500000000000000000", decimals: 18 } // 0.5 shares, NO price => null
  const { app, prisma, registry } = makeApp({ supplies })

  for (const id of ["aeth", "umint"]) {
    const product = registry.products.find((candidate: any) => candidate.productId === id)! as any
    prisma.evmIndexedEvent.rows.push({
      chainId: 91342,
      eventName: "PriceUpdated",
      contractAddress: String(product.priceFeed.proxy).toLowerCase(),
      blockNumber: 100n,
      blockHash: "0x0",
      txHash: `0xprice-${id}`,
      logIndex: 0,
      args: { roundId: "1", answer: "100000000", updatedAt: "1700000000" }, // navBase 1
    })
  }

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/monitoring/91342/overview",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  // aeth: 1 share x $3000 (tWETH rate) + umint: 20 shares x $1 = $3,020; abtc (0.5 shares,
  // unpriceable) contributes 0 instead of nulling the sum; zero-supply vaults contribute 0.
  assert.equal(body.tvlUsd, 3020)
  assert.equal(body.complete.tvl, false) // abtc's gap is still flagged
})

test("monitoring vaults aggregates flows, apy trend, depositors and pending per product", async () => {
  const registryProbe = deployedRegistry()
  const acapixProbe = registryProbe.products.find((product: any) => product.productId === "acapix")! as any
  const depositor = "0x00000000000000000000000000000000000000aa"
  const { app, prisma, registry } = makeApp({
    supplies: {
      [String(acapixProbe.productToken.proxy).toLowerCase()]: { supply: "600000000000000000000", decimals: 18 },
    },
    balances: { [depositor]: "600000000000000000000" },
  })
  const acapix = registry.products.find((product: any) => product.productId === "acapix")! as any
  const feed = String(acapix.priceFeed.proxy).toLowerCase()
  const depositVault = String(acapix.depositVault.proxy).toLowerCase()
  const redemptionVault = String(acapix.redemptionVault.proxy).toLowerCase()

  const week = 7 * 86_400
  prisma.evmIndexedEvent.rows.push(
    {
      chainId: 91342,
      eventName: "PriceUpdated",
      contractAddress: feed,
      blockNumber: 90n,
      blockHash: "0x0",
      txHash: "0xp1",
      logIndex: 0,
      args: { roundId: "1", answer: "100000000", updatedAt: "1700000000" },
    },
    {
      chainId: 91342,
      eventName: "PriceUpdated",
      contractAddress: feed,
      blockNumber: 95n,
      blockHash: "0x0",
      txHash: "0xp2",
      logIndex: 0,
      args: { roundId: "2", answer: "100200000", updatedAt: String(1700000000 + week) },
    },
    {
      chainId: 91342,
      eventName: "ProductDeposit",
      contractAddress: depositVault,
      blockNumber: 100n,
      blockHash: "0x0",
      txHash: "0xd1",
      logIndex: 0,
      args: {
        sender: depositor,
        recipient: depositor,
        paymentAssets: "1000000000", // 1000 tUSDC in
        sharesOut: "1000000000000000000000",
      },
    },
    {
      chainId: 91342,
      eventName: "ProductRedeemInstant",
      contractAddress: redemptionVault,
      blockNumber: 110n,
      blockHash: "0x0",
      txHash: "0xr1",
      logIndex: 0,
      args: {
        sender: depositor,
        recipient: depositor,
        sharesIn: "400000000000000000000",
        assetsOut: "400000000", // 400 tUSDC out
      },
    },
  )
  prisma.indexedRedemptionRequest.rows.push({
    chainId: 91342,
    productId: "acapix",
    requestId: "7",
    walletAddress: depositor,
    redemptionVaultAddress: redemptionVault,
    sharesIn: "100000000000000000000",
    lockedAssetsOut: "100200000",
    status: "REQUESTED",
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/monitoring/91342/vaults",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.ok(body.vaults.length >= 6)

  const acapixVault = body.vaults.find((vault: any) => vault.productId === "acapix")
  assert.equal(acapixVault.apy, 11.58)
  assert.equal(acapixVault.navBase, 1.002)
  assert.equal(acapixVault.totalSupplyHuman, 600)
  assert.equal(acapixVault.tvlUsd, 600 * 1.002)
  assert.deepEqual(acapixVault.trends.netDeposit, [1000, 600])
  assert.equal(acapixVault.trends.apy.length, 1)
  const expectedApy = (Math.pow(1.002, 365 / 7) - 1) * 100
  assert.ok(Math.abs(acapixVault.trends.apy[0] - expectedApy) < 1e-9)
  assert.equal(acapixVault.depositorCount, 1)
  assert.equal(acapixVault.pendingCount, 1)
  assert.equal(acapixVault.pendingUsd, 100.2)

  // Empty-data vault renders safely: nulls and empty trends, never an error.
  const umint = body.vaults.find((vault: any) => vault.productId === "umint")
  assert.equal(umint.navBase, null)
  assert.equal(umint.totalSupplyHuman, 0)
  assert.equal(umint.pendingCount, 0)
  assert.equal(umint.pendingUsd, 0)
  assert.equal(umint.depositorCount, 0)
  assert.deepEqual(umint.trends.netDeposit, [])
  assert.deepEqual(umint.trends.apy, [])
})

test("monitoring detail returns trends, depositor and requester lists (404 unknown product)", async () => {
  const depositor = "0x00000000000000000000000000000000000000aa"
  const requester = "0x00000000000000000000000000000000000000ab"
  const { app, prisma, registry } = makeApp({
    balances: { [depositor]: "2500000000000000000" }, // 2.5 shares
  })
  const acapix = registry.products.find((product: any) => product.productId === "acapix")! as any
  const feed = String(acapix.priceFeed.proxy).toLowerCase()
  const depositVault = String(acapix.depositVault.proxy).toLowerCase()
  const redemptionVault = String(acapix.redemptionVault.proxy).toLowerCase()

  prisma.evmIndexedEvent.rows.push(
    {
      chainId: 91342,
      eventName: "PriceUpdated",
      contractAddress: feed,
      blockNumber: 90n,
      blockHash: "0x0",
      txHash: "0xp1",
      logIndex: 0,
      args: { roundId: "1", answer: "100000000", updatedAt: "1700000000" },
    },
    {
      chainId: 91342,
      eventName: "ProductDeposit",
      contractAddress: depositVault,
      blockNumber: 100n,
      blockHash: "0x0",
      txHash: "0xd1",
      logIndex: 0,
      args: { sender: depositor, recipient: depositor, paymentAssets: "1000000000", sharesOut: "1000000000000000000000" },
    },
    {
      chainId: 91342,
      eventName: "ProductRedeemRequested",
      contractAddress: redemptionVault,
      blockNumber: 110n,
      blockHash: "0x0",
      txHash: "0xr1",
      logIndex: 0,
      args: { requestId: "7", sender: requester, recipient: requester, sharesIn: "400000000000000000000", assetsOut: "400000000" },
    },
  )
  prisma.indexedRedemptionRequest.rows.push(
    {
      chainId: 91342,
      productId: "acapix",
      requestId: "7",
      walletAddress: requester,
      redemptionVaultAddress: redemptionVault,
      sharesIn: "400000000000000000000",
      lockedAssetsOut: "400000000",
      status: "REQUESTED",
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    },
    {
      chainId: 91342,
      productId: "acapix",
      requestId: "8",
      walletAddress: requester,
      redemptionVaultAddress: redemptionVault,
      sharesIn: "100000000000000000000",
      lockedAssetsOut: "100000000",
      status: "SETTLED",
      createdAt: new Date("2026-07-02T10:00:00.000Z"),
      settledAt: new Date("2026-07-03T10:00:00.000Z"),
    },
  )

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/monitoring/91342/products/acapix",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()

  assert.equal(body.trends.nav.length, 1)
  assert.equal(body.trends.nav[0].value, 1)
  assert.deepEqual(
    body.trends.netDeposit.map((point: any) => point.value),
    [1000, 600],
  )
  assert.deepEqual(
    body.trends.totalTokenShare.map((point: any) => point.value),
    [1000, 600],
  )
  // Outstanding pending, daily-bucketed on index times: +1 (Jul 1), +1 (Jul 2), -1 (Jul 3).
  assert.deepEqual(
    body.trends.pendingWithdrawals.map((point: any) => point.value),
    [1, 2, 1],
  )

  assert.equal(body.depositors.length, 1)
  assert.equal(body.depositors[0].address, depositor)
  assert.equal(body.depositors[0].balanceHuman, 2.5)
  assert.equal(body.requesters.length, 1)
  assert.equal(body.requesters[0].address, requester)
  assert.equal(body.requesters[0].status, "REQUESTED")
  assert.equal(body.requesters[0].valueUsd, 400)

  const missing = await app.inject({
    method: "GET",
    url: "/api/v1/admin/monitoring/91342/products/nope",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(missing.statusCode, 404)
})

test("vault-config GET requires the operator credential and returns defaults for all products", async () => {
  const { app } = makeApp()
  const unauthorized = await app.inject({ method: "GET", url: "/api/v1/admin/vault-config/91342" })
  assert.equal(unauthorized.statusCode, 401)

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/vault-config/91342",
    headers: { "x-operator-token": "operator-token" },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.ok(body.configs.length >= 6)
  for (const config of body.configs) {
    assert.equal(config.hidden, false) // existing vaults stay visible with no row
    assert.equal(config.pinned, false)
    assert.equal(config.cardSnapshot, true)
    assert.equal(config.cardIndustry, true)
    assert.equal(config.cardExposure, true)
    assert.equal(config.displayName, null)
  }
})

test("vault-config PUT validates cards, category taxonomy, address, and product id", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }

  const allOff = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/vault-config/91342/acapix",
    headers,
    payload: { cardSnapshot: false, cardIndustry: false, cardExposure: false },
  })
  assert.equal(allOff.statusCode, 400)
  assert.match(allOff.json().error, /at least one portfolio card view/)

  const badAddress = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/vault-config/91342/acapix",
    headers,
    payload: { adminDepositAddress: "not-an-address" },
  })
  assert.equal(badAddress.statusCode, 400)
  assert.match(badAddress.json().error, /adminDepositAddress/)

  const badCategory = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/vault-config/91342/acapix",
    headers,
    payload: { category: "Meme Coins" },
  })
  assert.equal(badCategory.statusCode, 400)
  assert.match(badCategory.json().error, /unknown category/)

  const unknownProduct = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/vault-config/91342/nope",
    headers,
    payload: { pinned: true },
  })
  assert.equal(unknownProduct.statusCode, 404)

  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/vault-config/91342/acapix",
    headers,
    payload: {
      displayName: "Arco CAPIX Prime",
      category: "Prime Credit",
      adminDepositAddress: "0x00000000000000000000000000000000000000aa",
      cardSnapshot: false,
      pinned: true,
      hidden: true,
    },
  })
  assert.equal(saved.statusCode, 200)
  const savedBody = saved.json()
  assert.equal(savedBody.displayName, "Arco CAPIX Prime")
  assert.equal(savedBody.category, "Prime Credit")
  // stored checksummed via parseAddress
  assert.equal(savedBody.adminDepositAddress, getAddress("0x00000000000000000000000000000000000000aa"))
  assert.notEqual(savedBody.adminDepositAddress, "0x00000000000000000000000000000000000000aa")
  assert.equal(savedBody.cardSnapshot, false)
  assert.equal(savedBody.cardIndustry, true)
  assert.equal(savedBody.pinned, true)
  assert.equal(savedBody.hidden, true)

  const reread = await app.inject({
    method: "GET",
    url: "/api/v1/admin/vault-config/91342",
    headers,
  })
  const acapix = reread.json().configs.find((config: any) => config.productId === "acapix")
  assert.equal(acapix.displayName, "Arco CAPIX Prime")
  assert.equal(acapix.pinned, true)
})

test("public catalog carries the nested vaultConfig (saved values + defaults, hidden NOT filtered)", async () => {
  const { app } = makeApp()
  const put = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/vault-config/91342/acapix",
    headers: { "x-operator-token": "operator-token" },
    payload: { displayName: "Arco CAPIX Prime", pinned: true, hidden: true },
  })
  assert.equal(put.statusCode, 200)

  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  assert.equal(catalog.statusCode, 200)
  const products = catalog.json()
  assert.ok(products.length >= 6) // hidden is investor-UI declutter, not filtered here

  const acapix = products.find((product: any) => product.productId === "acapix")
  assert.equal(acapix.vaultConfig.displayName, "Arco CAPIX Prime")
  assert.equal(acapix.vaultConfig.pinned, true)
  assert.equal(acapix.vaultConfig.hidden, true)
  assert.equal(acapix.vaultConfig.cardIndustry, true)

  const other = products.find((product: any) => product.productId !== "acapix")
  assert.equal(other.vaultConfig.hidden, false)
  assert.equal(other.vaultConfig.pinned, false)
  assert.equal(other.vaultConfig.displayName, null)
})

test("function-pause route emits pauseFn/unpauseFn calldata for the kind's selectors", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const pauseFnAbi = [
    { type: "function", name: "pauseFn", inputs: [{ name: "selector", type: "bytes4" }], outputs: [] },
    { type: "function", name: "unpauseFn", inputs: [{ name: "selector", type: "bytes4" }], outputs: [] },
  ] as const

  const unauthorized = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/function-pause",
    payload: { kind: "deposit", paused: true },
  })
  assert.equal(unauthorized.statusCode, 401)

  const badKind = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/function-pause",
    headers,
    payload: { kind: "everything", paused: true },
  })
  assert.equal(badKind.statusCode, 400)

  const { encodeFunctionData } = await import("viem")
  const pauseDeposits = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/function-pause",
    headers,
    payload: { kind: "deposit", paused: true },
  })
  assert.equal(pauseDeposits.statusCode, 200)
  const depositTxs = pauseDeposits.json().transactions
  assert.equal(depositTxs.length, 2)
  assert.equal(
    depositTxs[0].data,
    encodeFunctionData({ abi: pauseFnAbi, functionName: "pauseFn", args: ["0x8dbdbe6d"] }),
  )
  assert.equal(
    depositTxs[1].data,
    encodeFunctionData({ abi: pauseFnAbi, functionName: "pauseFn", args: ["0x50814a4b"] }),
  )
  // both txs target the deposit vault
  assert.equal(depositTxs[0].to, depositTxs[1].to)

  const unpauseWithdrawals = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products/acapix/function-pause",
    headers,
    payload: { kind: "withdraw", paused: false },
  })
  assert.equal(unpauseWithdrawals.statusCode, 200)
  const withdrawTxs = unpauseWithdrawals.json().transactions
  assert.equal(withdrawTxs.length, 2)
  assert.equal(
    withdrawTxs[0].data,
    encodeFunctionData({ abi: pauseFnAbi, functionName: "unpauseFn", args: ["0x8835e747"] }),
  )
  assert.equal(
    withdrawTxs[1].data,
    encodeFunctionData({ abi: pauseFnAbi, functionName: "unpauseFn", args: ["0xbff2bab5"] }),
  )
  assert.notEqual(withdrawTxs[0].to, depositTxs[0].to) // redemption vault, not deposit vault
})

test("catalog carries nested pauseState from the reader (defaults false without one)", async () => {
  const withReader = makeApp({
    pauseStates: {
      acapix: { depositPaused: true, withdrawPaused: false, depositPartial: false, withdrawPartial: false },
      aeth: { depositPaused: false, withdrawPaused: true, depositPartial: true, withdrawPartial: true },
    },
  })
  const response = await withReader.app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  assert.equal(response.statusCode, 200)
  const products = response.json()
  const acapix = products.find((product: any) => product.productId === "acapix")
  assert.equal(acapix.pauseState.depositPaused, true)
  assert.equal(acapix.pauseState.withdrawPaused, false)
  const aeth = products.find((product: any) => product.productId === "aeth")
  assert.equal(aeth.pauseState.withdrawPaused, true)
  assert.equal(aeth.pauseState.withdrawPartial, true) // half-paused surfaces to the admin UI
  const umint = products.find((product: any) => product.productId === "umint")
  assert.equal(umint.pauseState.depositPaused, false) // not in the reader map => defaults

  // No reader wired at all => every product gets safe defaults, catalog still 200s.
  const withoutReader = makeApp()
  const fallback = await withoutReader.app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  assert.equal(fallback.statusCode, 200)
  for (const product of fallback.json()) {
    assert.deepEqual(product.pauseState, {
      depositPaused: false,
      withdrawPaused: false,
      depositPartial: false,
      withdrawPartial: false,
    })
  }
})

test("CORS preflight allows PUT with content-type and x-operator-token for the app origin", async () => {
  const { app } = makeApp()
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/admin/vault-config/91342/axrp",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type,x-operator-token",
    },
  })
  assert.equal(preflight.statusCode, 204)
  assert.equal(preflight.headers["access-control-allow-origin"], "http://localhost:5173")
  assert.match(String(preflight.headers["access-control-allow-methods"]), /PUT/)
  assert.match(String(preflight.headers["access-control-allow-headers"]), /x-operator-token/)
  assert.match(String(preflight.headers["access-control-allow-headers"]), /content-type/)
})

test("register-product guards: operator token, file-visibility 409, address mismatch 400", async () => {
  const extra = extraProduct()
  const { app } = makeApp({ extraProducts: [extra] })
  const addresses = {
    productToken: extra.productToken.proxy,
    depositVault: extra.depositVault.proxy,
    redemptionVault: extra.redemptionVault.proxy,
    priceFeed: extra.priceFeed.proxy,
  }

  const unauthorized = await app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    payload: { productId: "anew", addresses },
  })
  assert.equal(unauthorized.statusCode, 401)

  const headers = { "x-operator-token": "operator-token" }
  const notInFile = await app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    headers,
    payload: { productId: "ghost", addresses },
  })
  assert.equal(notInFile.statusCode, 409)
  assert.match(notInFile.json().error, /registry file/)
  assert.match(notInFile.json().error, /same machine\/commit/)

  const mismatch = await app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    headers,
    payload: {
      productId: "anew",
      addresses: { ...addresses, depositVault: "0x000000000000000000000000000000000000dead" },
    },
  })
  assert.equal(mismatch.statusCode, 400)
  assert.match(mismatch.json().error, /depositVault address does not match the registry file/)
})

test("register-product enforces on-chain role wiring and custody references", async () => {
  const extra = extraProduct()
  const addresses = {
    productToken: extra.productToken.proxy,
    depositVault: extra.depositVault.proxy,
    redemptionVault: extra.redemptionVault.proxy,
    priceFeed: extra.priceFeed.proxy,
  }
  const headers = { "x-operator-token": "operator-token" }

  const missingRole = makeApp({
    extraProducts: [extraProduct()],
    registerProbe: (product, registry) => {
      const probe = matchingProbe(product, registry)
      probe.roles.feedAdmin = false
      return probe
    },
  })
  const roleResponse = await missingRole.app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    headers,
    payload: { productId: "anew", addresses },
  })
  assert.equal(roleResponse.statusCode, 400)
  assert.match(roleResponse.json().error, /feedAdmin/)

  const badAdmin = makeApp({
    extraProducts: [extraProduct()],
    registerProbe: (product, registry) => {
      const probe = matchingProbe(product, registry)
      probe.proxyAdmins.productToken = "0x000000000000000000000000000000000000beef"
      return probe
    },
  })
  const adminResponse = await badAdmin.app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    headers,
    payload: { productId: "anew", addresses },
  })
  assert.equal(adminResponse.statusCode, 400)
  assert.match(adminResponse.json().error, /proxy admin .* does not match/)

  const badImplHash = makeApp({
    extraProducts: [extraProduct()],
    registerProbe: (product, registry) => {
      const probe = matchingProbe(product, registry)
      probe.implCodeHashes.priceFeed = "0xffff"
      return probe
    },
  })
  const hashResponse = await badImplHash.app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    headers,
    payload: { productId: "anew", addresses },
  })
  assert.equal(hashResponse.statusCode, 400)
  assert.match(hashResponse.json().error, /bytecode hash does not match/)
})

test("register-product success inserts the DB row + hidden config and surfaces unverified custody", async () => {
  const extra = extraProduct()
  const { app, prisma } = makeApp({
    extraProducts: [extra],
    // No recorded-vs-onchain hash available for one slot => it must be listed, not trusted.
    registerProbe: (product, registry) => {
      const probe = matchingProbe(product, registry)
      probe.implCodeHashes.productToken = null
      return probe
    },
  })
  const headers = { "x-operator-token": "operator-token" }
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/registry/register-product",
    headers,
    payload: {
      productId: "anew",
      addresses: {
        productToken: extra.productToken.proxy,
        depositVault: extra.depositVault.proxy,
        redemptionVault: extra.redemptionVault.proxy,
        priceFeed: extra.priceFeed.proxy,
      },
    },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.ok, true)
  assert.equal(body.hidden, true)
  assert.ok(body.unverified.includes("proxyAdminOwner"))
  assert.ok(body.unverified.includes("implBytecode:productToken"))
  assert.ok(body.proxyAdminOwner)

  const dbRow = prisma.evmProductDeployment.rows.find((row: any) => row.productId === "anew")
  assert.ok(dbRow)
  assert.equal(dbRow.symbol, "aNEW")
  const configRow = prisma.vaultConfig.rows.find((row: any) => row.productId === "anew")
  assert.equal(configRow?.hidden, true)

  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const products = catalog.json()
  assert.equal(products.length, 7)
  const anew = products.find((product: any) => product.productId === "anew")
  assert.equal(anew.vaultConfig.hidden, true) // hidden by default until the operator un-hides

  const configs = await app.inject({ method: "GET", url: "/api/v1/admin/vault-config/91342", headers })
  const anewConfig = configs.json().configs.find((config: any) => config.productId === "anew")
  assert.equal(anewConfig?.hidden, true)
})

test("registry validation keeps the six launch products required but allows extras", async () => {
  const { validateGiwaRegistry } = await import("./registry/validation.js")

  const withExtra = deployedRegistry() as any
  withExtra.products.push(extraProduct())
  const okResult = validateGiwaRegistry(withExtra)
  assert.deepEqual(
    okResult.errors.filter((error: string) => /product/i.test(error)),
    [],
  )

  const missingRequired = deployedRegistry() as any
  missingRequired.products = missingRequired.products.filter((product: any) => product.productId !== "acapix")
  const missingResult = validateGiwaRegistry(missingRequired)
  assert.ok(missingResult.errors.some((error: string) => /missing required product aCAPIX/.test(error)))

  const badAsset = deployedRegistry() as any
  badAsset.products.push({ ...extraProduct(), paymentAssetSymbol: "tDOGE" })
  const badAssetResult = validateGiwaRegistry(badAsset)
  assert.ok(badAssetResult.errors.some((error: string) => /maps to missing asset tDOGE/.test(error)))
})

test("server vault-config taxonomy matches shared/vault-taxonomy.ts (drift guard)", async () => {
  // The server keeps a literal copy of the taxonomy (importing across its tsconfig
  // include would shift the dist layout); this guards it against drifting from the
  // canonical shared constant.
  const { readFileSync } = await import("node:fs")
  const shared = readFileSync("shared/vault-taxonomy.ts", "utf8")
  const appSource = readFileSync("server/src/app.ts", "utf8")

  const sharedMatch = shared.match(/VAULT_CATEGORIES = \[([^\]]+)\]/)
  assert.ok(sharedMatch, "shared VAULT_CATEGORIES literal not found")
  const sharedValues = [...sharedMatch![1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(sharedValues, ["U.S Treasuries", "Prime Credit", "Arco Saving", "Equity Exposure"])

  const serverMatch = appSource.match(/VAULT_CATEGORIES = \[([^\]]+)\]/)
  assert.ok(serverMatch, "server VAULT_CATEGORIES literal not found")
  const serverValues = [...serverMatch![1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(serverValues, sharedValues)

  // Same drift guard for VAULT_KINDS (product|saving).
  const sharedKinds = shared.match(/VAULT_KINDS = \[([^\]]+)\]/)
  assert.ok(sharedKinds, "shared VAULT_KINDS literal not found")
  const sharedKindValues = [...sharedKinds![1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(sharedKindValues, ["product", "saving"])
  const serverKinds = appSource.match(/VAULT_KINDS = \[([^\]]+)\]/)
  assert.ok(serverKinds, "server VAULT_KINDS literal not found")
  const serverKindValues = [...serverKinds![1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(serverKindValues, sharedKindValues)
})

test("vault-config PUT validates + persists kind (product|saving), rejecting other values", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Unset config → kind defaults to "product" (stays in Products).
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  assert.equal(catalog.json().find((row: any) => row.productId === "acapix").vaultConfig.kind, "product")

  // Bad value → 400; valid "saving" persists and appears on the catalog vaultConfig.
  const bad = await app.inject({ method: "PUT", url, headers, payload: { kind: "portfolio" } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /kind must be one of/)

  const saved = await app.inject({ method: "PUT", url, headers, payload: { kind: "saving" } })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().kind, "saving")
  const after = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  assert.equal(after.json().find((row: any) => row.productId === "acapix").vaultConfig.kind, "saving")
})

test("vault-config PUT validates + persists the display-profile fields", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Fee out of the 0–10000 bps range → 400.
  const badFee = await app.inject({ method: "PUT", url, headers, payload: { feeManagementBps: 10001 } })
  assert.equal(badFee.statusCode, 400)
  assert.match(badFee.json().error, /feeManagementBps/)

  // Non-integer bps → 400.
  const fracFee = await app.inject({ method: "PUT", url, headers, payload: { feeInstantRedemptionBps: 25.5 } })
  assert.equal(fracFee.statusCode, 400)

  // Bad image URL → 400; negative timeline → 400.
  const badUrl = await app.inject({ method: "PUT", url, headers, payload: { vaultImageUrl: "notaurl" } })
  assert.equal(badUrl.statusCode, 400)
  assert.match(badUrl.json().error, /vaultImageUrl/)
  // Protocol-relative //host must be rejected (a browser would fetch it cross-origin).
  const protocolRelative = await app.inject({ method: "PUT", url, headers, payload: { vaultImageUrl: "//evil.example/logo.png" } })
  assert.equal(protocolRelative.statusCode, 400)
  // A valid single-leading-slash /path is accepted.
  const okPath = await app.inject({ method: "PUT", url, headers, payload: { issuerImageUrl: "/logos/arco.png" } })
  assert.equal(okPath.statusCode, 200)
  assert.equal(okPath.json().issuerImageUrl, "/logos/arco.png")
  const badDays = await app.inject({ method: "PUT", url, headers, payload: { redemptionTimelineDays: -1 } })
  assert.equal(badDays.statusCode, 400)

  // Valid full profile saves and re-reads.
  const saved = await app.inject({
    method: "PUT",
    url,
    headers,
    payload: {
      assetManagerName: "Aksia",
      issuerName: "Arco",
      about: "Line one.\n\nLine two.",
      redemptionTimelineDays: 3,
      feeInstantMintingBps: 20,
      feeInstantRedemptionBps: 25,
      feeManagementBps: 125,
      feePerformanceBps: 0,
      vaultImageUrl: "https://cdn.example.com/vault.png",
      assetManagerImageUrl: "/logos/aksia.svg",
      issuerImageUrl: "https://cdn.example.com/issuer.png",
    },
  })
  assert.equal(saved.statusCode, 200)
  const body = saved.json()
  assert.equal(body.feeManagementBps, 125)
  assert.equal(body.feeInstantMintingBps, 20)
  assert.equal(body.redemptionTimelineDays, 3)
  assert.equal(body.assetManagerName, "Aksia")
  assert.equal(body.assetManagerImageUrl, "/logos/aksia.svg")

  // Catalog carries the new nested vaultConfig fields to the frontend.
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const acapix = catalog.json().find((productRow: any) => productRow.productId === "acapix")
  assert.equal(acapix.vaultConfig.feeManagementBps, 125)
  assert.equal(acapix.vaultConfig.about, "Line one.\n\nLine two.")

  // Blank string clears an override back to null.
  const cleared = await app.inject({ method: "PUT", url, headers, payload: { assetManagerName: "" } })
  assert.equal(cleared.json().assetManagerName, null)
})

test("vault-config PUT validates + persists portfolio slice arrays", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Sum not ~100 → 400.
  const badSum = await app.inject({
    method: "PUT", url, headers,
    payload: { portfolioIndustry: [{ label: "A", percent: 60 }, { label: "B", percent: 30 }] },
  })
  assert.equal(badSum.statusCode, 400)
  assert.match(badSum.json().error, /portfolioIndustry/)

  // Bad slice (out of range) → 400; non-array → 400.
  const badSlice = await app.inject({ method: "PUT", url, headers, payload: { portfolioSnapshot: [{ label: "A", percent: 150 }] } })
  assert.equal(badSlice.statusCode, 400)
  const notArray = await app.inject({ method: "PUT", url, headers, payload: { portfolioExposure: "nope" } })
  assert.equal(notArray.statusCode, 400)

  // Empty array → cleared to null (NOT an error).
  const emptied = await app.inject({ method: "PUT", url, headers, payload: { portfolioSnapshot: [] } })
  assert.equal(emptied.statusCode, 200)
  assert.equal(emptied.json().portfolioSnapshot, null)

  // Valid save: normalized (missing valueUsd → null) and re-read.
  const saved = await app.inject({
    method: "PUT", url, headers,
    payload: {
      portfolioSnapshot: [
        { label: "Alpha", percent: 60, valueUsd: 6_000_000 },
        { label: "Beta", percent: 40 },
      ],
    },
  })
  assert.equal(saved.statusCode, 200)
  const snap = saved.json().portfolioSnapshot
  assert.equal(snap.length, 2)
  assert.equal(snap[0].valueUsd, 6_000_000)
  assert.equal(snap[1].valueUsd, null)

  // Catalog carries the nested portfolio slices.
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const acapix = catalog.json().find((row: any) => row.productId === "acapix")
  assert.equal(acapix.vaultConfig.portfolioSnapshot[0].label, "Alpha")
})

test("vault-config PUT validates + persists accept-assets (real + dummy), rejecting dangling/duplicate", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Make acapix a saving vault so a real accept-asset may map to it (stricter check: ∈ saving vaults).
  const savingSet = await app.inject({ method: "PUT", url, headers, payload: { kind: "saving" } })
  assert.equal(savingSet.statusCode, 200)

  // Non-array → 400.
  const notArray = await app.inject({ method: "PUT", url, headers, payload: { acceptAssets: "nope" } })
  assert.equal(notArray.statusCode, 400)

  // Dangling savingVaultId (points at a PRODUCT vault, umint) → 400: must reference a saving vault.
  const dangling = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [{ symbol: "USDC", isDummy: false, savingVaultId: "umint" }] },
  })
  assert.equal(dangling.statusCode, 400)
  assert.match(dangling.json().error, /must reference a saving vault/)

  // Non-dummy missing savingVaultId → 400.
  const missing = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [{ symbol: "USDC", isDummy: false }] },
  })
  assert.equal(missing.statusCode, 400)

  // Dummy carrying a savingVaultId → 400 (a dummy maps to nothing).
  const dummyMapped = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [{ symbol: "RLUSD", isDummy: true, savingVaultId: "acapix" }] },
  })
  assert.equal(dummyMapped.statusCode, 400)

  // Duplicate symbol (case-insensitive) → 400.
  const dup = await app.inject({
    method: "PUT", url, headers,
    payload: {
      acceptAssets: [
        { symbol: "USDC", isDummy: false, savingVaultId: "acapix" },
        { symbol: "usdc", isDummy: true, apy: 3 },
      ],
    },
  })
  assert.equal(dup.statusCode, 400)
  assert.match(dup.json().error, /duplicate/)

  // Valid: a real asset (maps to acapix, APY read live → null) + a dummy (null map, keeps its APY).
  const saved = await app.inject({
    method: "PUT", url, headers,
    payload: {
      acceptAssets: [
        { symbol: "USDC", icon: "/logos/usdc.svg", isDummy: false, savingVaultId: "acapix" },
        { symbol: "RLUSD", isDummy: true, apy: 3.8 },
      ],
    },
  })
  assert.equal(saved.statusCode, 200)
  const assets = saved.json().acceptAssets
  assert.equal(assets.length, 2)
  assert.deepEqual(assets[0], { symbol: "USDC", icon: "/logos/usdc.svg", apy: null, savingVaultId: "acapix", isDummy: false, sortOrder: null })
  assert.deepEqual(assets[1], { symbol: "RLUSD", icon: null, apy: 3.8, savingVaultId: null, isDummy: true, sortOrder: null })

  // Catalog carries the nested accept-assets (in order) to the frontend.
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const acapix = catalog.json().find((row: any) => row.productId === "acapix")
  assert.equal(acapix.vaultConfig.acceptAssets[0].savingVaultId, "acapix")
  assert.equal(acapix.vaultConfig.acceptAssets[1].symbol, "RLUSD")

  // Empty array → cleared to null (not an error).
  const emptied = await app.inject({ method: "PUT", url, headers, payload: { acceptAssets: [] } })
  assert.equal(emptied.statusCode, 200)
  assert.equal(emptied.json().acceptAssets, null)
})

test("vault-config kind flip to product leaves stored accept-assets dormant (untouched, un-revalidated)", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Saving vault with a real accept-asset mapped to itself.
  await app.inject({ method: "PUT", url, headers, payload: { kind: "saving" } })
  const saved = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [{ symbol: "USDC", isDummy: false, savingVaultId: "acapix" }] },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().acceptAssets.length, 1)

  // A kind-only PUT back to product OMITS acceptAssets → they survive untouched (dormant), even
  // though a now-product vault would fail the saving-vault check if the field were re-validated.
  const flipped = await app.inject({ method: "PUT", url, headers, payload: { kind: "product" } })
  assert.equal(flipped.statusCode, 200)
  assert.equal(flipped.json().kind, "product")
  assert.equal(flipped.json().acceptAssets.length, 1)
  assert.equal(flipped.json().acceptAssets[0].savingVaultId, "acapix")
})

test("vault-config PUT round-trips accept-asset sortOrder (nullable integer ≥0)", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"
  await app.inject({ method: "PUT", url, headers, payload: { kind: "saving" } })

  // Non-integer / negative sortOrder → 400.
  const frac = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [{ symbol: "USDC", isDummy: false, savingVaultId: "acapix", sortOrder: 1.5 }] },
  })
  assert.equal(frac.statusCode, 400)
  assert.match(frac.json().error, /sortOrder/)
  const neg = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [{ symbol: "USDC", isDummy: false, savingVaultId: "acapix", sortOrder: -1 }] },
  })
  assert.equal(neg.statusCode, 400)

  // Valid sortOrder persists; an omitted one reads back null.
  const saved = await app.inject({
    method: "PUT", url, headers,
    payload: { acceptAssets: [
      { symbol: "USDC", isDummy: false, savingVaultId: "acapix", sortOrder: 3 },
      { symbol: "RLUSD", isDummy: true, apy: 3.8 },
    ] },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().acceptAssets[0].sortOrder, 3)
  assert.equal(saved.json().acceptAssets[1].sortOrder, null)
})

test("savings-order route reorders across vaults, preserves other fields + unlisted order, rejects unknown", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const cfg = (productId: string, payload: any) =>
    app.inject({ method: "PUT", url: `/api/v1/admin/vault-config/91342/${productId}`, headers, payload })
  const orderUrl = "/api/v1/admin/savings-order/91342"

  // Two saving vaults; USDC starts with sortOrder 5 to prove an UNLISTED asset keeps its order.
  await cfg("acapix", { kind: "saving" })
  await cfg("acapix", { acceptAssets: [
    { symbol: "USDC", isDummy: false, savingVaultId: "acapix", sortOrder: 5 },
    { symbol: "RLUSD", isDummy: true, apy: 3.8 },
  ] })
  await cfg("umint", { kind: "saving" })
  await cfg("umint", { acceptAssets: [{ symbol: "XRP", isDummy: false, savingVaultId: "umint" }] })

  // Guarded by the same operator credential as vault-config (no token → 401).
  const unauth = await app.inject({ method: "PUT", url: orderUrl, payload: { order: [] } })
  assert.equal(unauth.statusCode, 401)

  // Reject an unknown symbol and a non-saving productId (all-or-nothing before any write).
  const badSym = await app.inject({ method: "PUT", url: orderUrl, headers, payload: { order: [{ productId: "acapix", symbol: "GHOST" }] } })
  assert.equal(badSym.statusCode, 400)
  assert.match(badSym.json().error, /not an accept-asset/)
  const badVault = await app.inject({ method: "PUT", url: orderUrl, headers, payload: { order: [{ productId: "ibenji", symbol: "USDC" }] } })
  assert.equal(badVault.statusCode, 400)
  assert.match(badVault.json().error, /not a saving vault/)

  // Reorder cross-vault: XRP=0, RLUSD=1. USDC is NOT listed → keeps its existing sortOrder (5).
  const ok = await app.inject({ method: "PUT", url: orderUrl, headers, payload: { order: [
    { productId: "umint", symbol: "XRP" },
    { productId: "acapix", symbol: "RLUSD" },
  ] } })
  assert.equal(ok.statusCode, 200)

  const rows = (await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })).json()
  const bySym = (productId: string, symbol: string) =>
    rows.find((r: any) => r.productId === productId).vaultConfig.acceptAssets.find((a: any) => a.symbol === symbol)
  assert.equal(bySym("umint", "XRP").sortOrder, 0)
  assert.equal(bySym("acapix", "RLUSD").sortOrder, 1)
  assert.equal(bySym("acapix", "USDC").sortOrder, 5) // unlisted → preserved, not wiped
  // Field preservation: the reorder touched ONLY sortOrder.
  assert.equal(bySym("acapix", "USDC").savingVaultId, "acapix")
  assert.equal(bySym("acapix", "USDC").isDummy, false)
  assert.equal(bySym("acapix", "RLUSD").apy, 3.8)
  assert.equal(bySym("acapix", "RLUSD").isDummy, true)
  assert.equal(bySym("acapix", "RLUSD").savingVaultId, null)
})

test("vault-config PUT validates + persists the AUM display field", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Over the 24-char cap → 400.
  const tooLong = await app.inject({ method: "PUT", url, headers, payload: { aum: "x".repeat(25) } })
  assert.equal(tooLong.statusCode, 400)
  assert.match(tooLong.json().error, /aum/)

  // Valid free-text saves verbatim (trimmed).
  const saved = await app.inject({ method: "PUT", url, headers, payload: { aum: "  $1.2B+  " } })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().aum, "$1.2B+")

  // Catalog carries it; blank clears to null.
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  assert.equal(catalog.json().find((row: any) => row.productId === "acapix").vaultConfig.aum, "$1.2B+")
  const cleared = await app.inject({ method: "PUT", url, headers, payload: { aum: "" } })
  assert.equal(cleared.json().aum, null)
})

test("vault-config PUT validates + persists the More-info docs URLs (same rule as image URLs)", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Junk that is neither an http(s) URL nor a /path → 400, per key.
  for (const key of ["docsUrl", "legalUrl", "risksUrl"]) {
    const bad = await app.inject({ method: "PUT", url, headers, payload: { [key]: "not-a-url" } })
    assert.equal(bad.statusCode, 400, key)
    assert.match(bad.json().error, new RegExp(key))
  }
  const tooLong = await app.inject({ method: "PUT", url, headers, payload: { docsUrl: `https://x.io/${"a".repeat(2048)}` } })
  assert.equal(tooLong.statusCode, 400)

  // https URL, a repo /path, and a trimmed value all persist.
  const saved = await app.inject({
    method: "PUT",
    url,
    headers,
    payload: { docsUrl: "  https://docs.arco.fi/acapix  ", legalUrl: "/legal/acapix.pdf", risksUrl: "https://arco.fi/risks" },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().docsUrl, "https://docs.arco.fi/acapix")
  assert.equal(saved.json().legalUrl, "/legal/acapix.pdf")

  // Catalog carries them; blank clears to null.
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const cfg = catalog.json().find((row: any) => row.productId === "acapix").vaultConfig
  assert.equal(cfg.docsUrl, "https://docs.arco.fi/acapix")
  const cleared = await app.inject({ method: "PUT", url, headers, payload: { docsUrl: "" } })
  assert.equal(cleared.json().docsUrl, null)
})

test("vault-config PUT validates the More-info show toggles as booleans, defaulting true", async () => {
  const { app } = makeApp()
  const headers = { "x-operator-token": "operator-token" }
  const url = "/api/v1/admin/vault-config/91342/acapix"

  // Unset config → shown defaults true, URLs null (so nothing renders yet).
  const catalog = await app.inject({ method: "GET", url: "/api/v1/evm/catalog/91342" })
  const defaults = catalog.json().find((row: any) => row.productId === "acapix").vaultConfig
  for (const key of ["docsShown", "legalShown", "risksShown"]) assert.equal(defaults[key], true, key)
  for (const key of ["docsUrl", "legalUrl", "risksUrl"]) assert.equal(defaults[key], null, key)

  for (const key of ["docsShown", "legalShown", "risksShown"]) {
    const bad = await app.inject({ method: "PUT", url, headers, payload: { [key]: "yes" } })
    assert.equal(bad.statusCode, 400, key)
    assert.match(bad.json().error, new RegExp(key))
  }
  const saved = await app.inject({ method: "PUT", url, headers, payload: { docsShown: false, risksShown: false } })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().docsShown, false)
  assert.equal(saved.json().legalShown, true) // untouched key keeps its default
  assert.equal(saved.json().risksShown, false)
})
