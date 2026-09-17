import { stocksExecutionPlugin, type StocksExecutionPluginOptions } from './stocks-execution/plugin.js'
import { createRequire } from "node:module"
import cors from "@fastify/cors"
import { stocksPlugin, type StocksPluginOptions } from "./stocks/plugin.js"
import { stocksSubmissionsPlugin, type StocksSubmissionsPluginOptions } from "./stocks-submissions/plugin.js"
import { stocksMarketDataPlugin, type StocksMarketDataService } from "./stocks-market-data/index.js"
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify"
import { generateNonce, SiweMessage } from "siwe"
import { formatUnits, getAddress, isAddress, type Address } from "viem"
import {
  buildFulfillRedeemTransaction,
  buildFunctionPauseTransactions,
  buildGreenlistTransactions,
  buildLiquidityTransaction,
  buildPauseTransactions,
  buildPayoutTransaction,
  buildSetDepositLimitsTransaction,
  buildSetHealthyDiffTransaction,
  buildSetPriceTransaction,
  buildSetRedemptionLimitsTransaction,
  buildWithdrawTransaction,
} from "./evm/admin-transactions.js"
import { GIWA_CHAIN_ID } from "./registry/products.js"
import { readRegistryFile } from "./registry/io.js"
import type { GiwaDeploymentRegistry } from "./registry/types.js"
import type { ReadinessCheck } from "./readiness/checker.js"
import type { EvmMarketService } from "./services/evm-market-service.js"
import type { EvmMonitoringService } from "./services/evm-monitoring-service.js"
import { RegisterError, type EvmRegisterService, type ProxySlot } from "./services/evm-register-service.js"
import type { EvmPortfolioService } from "./services/evm-portfolio-service.js"
import type { EvmRegistryService } from "./services/evm-registry-service.js"
import {
  withVaultConfigDefaults,
  type PrismaArcoService,
  type VaultAcceptAsset,
  type VaultConfigValues,
} from "./services/prisma-arco-service.js"

const require = createRequire(import.meta.url)
const { sign: signJwt, verify: verifyJwt } = require("jsonwebtoken") as typeof import("jsonwebtoken")

export type AppEnv = {
  readonly corsAllowedOrigins: readonly string[]
  readonly authNonceTtlSeconds: number
  readonly authJwtSecret: string
  readonly adminOperatorToken: string
  readonly registryPath: string
}

// Per-vault function-pause snapshot for the public catalog. `*Paused` OR-includes the
// whole-contract pause; `*Partial` flags a selector disagreement within one kind (e.g.
// the second pauseFn tx was rejected) so the admin UI can prompt a retry.
export type VaultPauseState = {
  readonly depositPaused: boolean
  readonly withdrawPaused: boolean
  readonly depositPartial: boolean
  readonly withdrawPartial: boolean
}

export type PauseStateVaultRef = {
  readonly productId: string
  readonly depositVault: string | null
  readonly redemptionVault: string | null
}

// Raw (base-unit, as decimal strings) current limits from readVaultLimits; the GET route
// de-scales these to human units per the registry decimals.
export type VaultLimitsRaw = {
  readonly minimumDeposit: string
  readonly maxSupplyCap: string
  readonly vaultMintAllowance: string
  readonly minimumRedeem: string
  readonly vaultRedeemAllowance: string
}

export type ArcoAppServices = {
  readonly stocksExecution?: StocksExecutionPluginOptions
  readonly stocksSubmissions?: StocksSubmissionsPluginOptions
  readonly stocksMarketData?: StocksMarketDataService
  readonly stocks?: StocksPluginOptions
  readonly arco: PrismaArcoService
  readonly registry: EvmRegistryService
  readonly portfolio: EvmPortfolioService
  readonly readiness: { check(): Promise<ReadinessCheck> }
  readonly market?: EvmMarketService
  readonly monitoring?: EvmMonitoringService
  readonly register?: EvmRegisterService
  readonly readPauseState?: (vaults: PauseStateVaultRef[]) => Promise<Record<string, VaultPauseState> | null>
  readonly readVaultLimits?: (refs: { depositVault: string; redemptionVault: string }) => Promise<VaultLimitsRaw | null>
  readonly loadRegistry?: () => GiwaDeploymentRegistry
}

export const DEFAULT_PAUSE_STATE: VaultPauseState = {
  depositPaused: false,
  withdrawPaused: false,
  depositPartial: false,
  withdrawPartial: false,
}

type JwtPayload = {
  readonly sub: string
  readonly domain: string
  readonly chainId: number
}

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value === "string" && isAddress(value)) return getAddress(value)
  throw new Error(`${label} must be a valid EVM address`)
}

type PortfolioSlice = { label: string; percent: number; valueUsd?: number | null }

// Portfolio-slice validator — mirror of the client's validatePortfolioSlices in
// src/demo/giwa/display-profile.ts. Empty array is valid (caller clears to null); a
// non-empty array must sum to ~100% (±0.5).
function validatePortfolioSlices(input: unknown): { ok: boolean; error?: string; slices?: PortfolioSlice[] } {
  if (!Array.isArray(input)) return { ok: false, error: "must be an array of slices" }
  const slices: PortfolioSlice[] = []
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] as Record<string, unknown> | null
    if (!raw || typeof raw !== "object") return { ok: false, error: `slice ${i + 1} must be an object` }
    const label = typeof raw.label === "string" ? raw.label.trim() : ""
    if (label.length < 1 || label.length > 40) return { ok: false, error: `slice ${i + 1} label must be 1–40 characters` }
    const percent = raw.percent
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { ok: false, error: `slice ${i + 1} percent must be a number 0–100` }
    }
    let valueUsd: number | null | undefined
    if (raw.valueUsd === undefined || raw.valueUsd === null) valueUsd = null
    else if (typeof raw.valueUsd === "number" && Number.isFinite(raw.valueUsd) && raw.valueUsd >= 0) valueUsd = raw.valueUsd
    else return { ok: false, error: `slice ${i + 1} valueUsd must be a non-negative number or null` }
    slices.push({ label, percent, valueUsd })
  }
  if (slices.length > 0) {
    const sum = slices.reduce((total, slice) => total + slice.percent, 0)
    if (Math.abs(sum - 100) > 0.5) return { ok: false, error: `slice percents must sum to ~100% (currently ${sum.toFixed(2)}%)` }
  }
  return { ok: true, slices }
}

// Accept-asset validator (Savings page) — mirror of the client's validateAcceptAssets in
// src/demo/giwa/display-profile.ts, PLUS the authoritative dangling check the client can't do:
// a real asset's savingVaultId must be in `savingVaultIds` (the known saving vaults, ∪ the vault
// being edited — which may be flipping to saving in this same PUT). A dummy asset maps to nothing
// (savingVaultId must be empty → stored null). `order` is the array index (stored positionally,
// no separate field). Empty array is valid (caller clears to null). Symbols are unique
// (case-insensitive). Returns VaultAcceptAsset rows (savingVaultId derived) for persistence.
function validateAcceptAssets(
  input: unknown,
  savingVaultIds: ReadonlySet<string>,
): { ok: boolean; error?: string; assets?: VaultAcceptAsset[] } {
  if (!Array.isArray(input)) return { ok: false, error: "must be an array of accept-assets" }
  const assets: VaultAcceptAsset[] = []
  const seenSymbols = new Set<string>()
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] as Record<string, unknown> | null
    const at = `accept-asset ${i + 1}`
    if (!raw || typeof raw !== "object") return { ok: false, error: `${at} must be an object` }
    const symbol = typeof raw.symbol === "string" ? raw.symbol.trim() : ""
    if (symbol.length < 1 || symbol.length > 40) return { ok: false, error: `${at} symbol must be 1–40 characters` }
    const symbolKey = symbol.toLowerCase()
    if (seenSymbols.has(symbolKey)) return { ok: false, error: `${at} symbol "${symbol}" is a duplicate` }
    seenSymbols.add(symbolKey)
    // icon: null / blank, else an absolute http(s) URL or a single-leading-slash /path (same rule
    // as the image URL fields; the path branch rejects protocol-relative "//host").
    let icon: string | null
    if (raw.icon === undefined || raw.icon === null) icon = null
    else if (typeof raw.icon !== "string") return { ok: false, error: `${at} icon must be a string or null` }
    else {
      const trimmed = raw.icon.trim()
      if (trimmed === "") icon = null
      else if (!/^https?:\/\/.+/.test(trimmed) && !/^\/[^/\s]\S*$/.test(trimmed)) {
        return { ok: false, error: `${at} icon must be an http(s) URL or a /path` }
      } else if (trimmed.length > 2048) return { ok: false, error: `${at} icon must be at most 2048 characters` }
      else icon = trimmed
    }
    // apy: null or a finite number ≥0 (the dummy display rate; a real asset's APY is read live).
    let apy: number | null
    if (raw.apy === undefined || raw.apy === null) apy = null
    else if (typeof raw.apy === "number" && Number.isFinite(raw.apy) && raw.apy >= 0) apy = raw.apy
    else return { ok: false, error: `${at} apy must be a non-negative number or null` }
    if (typeof raw.isDummy !== "boolean") return { ok: false, error: `${at} isDummy must be a boolean` }
    const isDummy = raw.isDummy
    // savingVaultId: a dummy maps to nothing (must be empty → null); a real asset must reference a
    // known saving vault (rejects dangling maps and non-saving targets).
    let savingVaultId: string | null
    if (isDummy) {
      if (raw.savingVaultId !== undefined && raw.savingVaultId !== null && raw.savingVaultId !== "") {
        return { ok: false, error: `${at} is a dummy — savingVaultId must be empty` }
      }
      savingVaultId = null
    } else if (typeof raw.savingVaultId !== "string" || raw.savingVaultId.trim() === "") {
      return { ok: false, error: `${at} savingVaultId is required for a non-dummy asset` }
    } else {
      const id = raw.savingVaultId.trim()
      if (!savingVaultIds.has(id)) {
        return { ok: false, error: `${at} savingVaultId "${id}" must reference a saving vault` }
      }
      savingVaultId = id
    }
    // sortOrder: null (unset) or a non-negative integer — the global cross-vault Savings display order.
    let sortOrder: number | null
    if (raw.sortOrder === undefined || raw.sortOrder === null) sortOrder = null
    else if (typeof raw.sortOrder === "number" && Number.isInteger(raw.sortOrder) && raw.sortOrder >= 0) sortOrder = raw.sortOrder
    else return { ok: false, error: `${at} sortOrder must be a non-negative integer or null` }
    assets.push({ symbol, icon, apy, savingVaultId, isDummy, sortOrder })
  }
  return { ok: true, assets }
}

function parseChainId(value: string | undefined): number {
  const chainId = Number(value)
  if (!Number.isInteger(chainId)) throw new Error("chainId must be an integer")
  return chainId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function httpJsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value
}

function serializeHttpJson(payload: unknown): string {
  if (typeof payload === "string") return payload
  const serialized = JSON.stringify(payload, httpJsonReplacer)
  return serialized ?? ""
}

function dbRegistryToCatalog(registry: { assets: unknown[]; products: unknown[] }) {
  const assets = registry.assets as Record<string, unknown>[]
  return (registry.products as Record<string, unknown>[]).map((product) => ({
    ...product,
    paymentAsset: assets.find((asset) => asset.symbol === product.paymentAssetSymbol) ?? null,
  }))
}

export function buildApp(env: AppEnv, services: ArcoAppServices) {
  const app = Fastify({ logger: false })
  const loadRegistry = services.loadRegistry ?? (() => readRegistryFile(env.registryPath))

  // HTTP boundary convention: bigint values are encoded as decimal strings
  // so Prisma block fields and viem quantities are JSON-serializable on every route.
  app.setReplySerializer(serializeHttpJson)

  app.register(cors, {
    // Admin writes include PUT (vault-config) and DELETE (featured-card remove) — without
    // them the browser preflight fails and fetch surfaces as "Failed to fetch" before any
    // server response.
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-operator-token", "authorization"],
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }
      if (env.corsAllowedOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error("CORS origin is not allowed"), false)
    },
  })

  async function requireSession(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
    if (!token) {
      return reply.code(401).send({ error: "Missing bearer session token" })
    }
    try {
      request.user = verifyJwt(token, env.authJwtSecret) as JwtPayload
    } catch {
      return reply.code(401).send({ error: "Invalid bearer session token" })
    }
  }

  async function requireOperator(request: FastifyRequest, reply: FastifyReply) {
    const token = request.headers["x-operator-token"]
    if (token !== env.adminOperatorToken) {
      return reply.code(401).send({ error: "Invalid operator credential" })
    }
  }

  app.get("/health", async () => ({ ok: true, service: "arco-giwa-api" }))

  app.get("/ready", async (_request, reply) => {
    const readiness = await services.readiness.check()
    return reply.code(readiness.ok ? 200 : 503).send(readiness)
  })

  app.get("/api/v1/evm/networks", async () => services.registry.listNetworks())

  app.get<{ Params: { chainId: string } }>("/api/v1/evm/registry/:chainId", async (request) => {
    const chainId = parseChainId(request.params.chainId)
    const dbRegistry = await services.registry.getRegistry(chainId)
    if (dbRegistry.network) return dbRegistry
    const fileRegistry = loadRegistry()
    if (fileRegistry.chainId !== chainId) throw new Error("Registry not found")
    return fileRegistry
  })

  // The catalog carries each product's off-chain vaultConfig (nested, defaults applied).
  // Hidden vaults are NOT filtered here — `hidden` is investor-UI declutter, not access
  // control; the admin config page needs them and the data is public on-chain anyway.
  async function vaultConfigByProduct(chainId: number) {
    const rows = (await services.arco.vaultConfigs(chainId)) as ({ productId?: string } & Partial<VaultConfigValues>)[]
    return new Map(rows.map((row) => [row.productId ?? "", withVaultConfigDefaults(row)]))
  }

  // Best-effort function-pause snapshot for the catalog (defaults when the reader is
  // absent or the RPC read fails — the catalog must never 500 because of pause reads).
  async function pauseStateByProduct(vaults: PauseStateVaultRef[]): Promise<Record<string, VaultPauseState>> {
    if (!services.readPauseState) return {}
    try {
      return (await services.readPauseState(vaults)) ?? {}
    } catch {
      return {}
    }
  }

  app.get<{ Params: { chainId: string } }>("/api/v1/evm/catalog/:chainId", async (request) => {
    const chainId = parseChainId(request.params.chainId)
    const configs = await vaultConfigByProduct(chainId)
    const dbRegistry = await services.registry.getRegistry(chainId)
    if (dbRegistry.network) {
      const products = dbRegistryToCatalog(dbRegistry) as Record<string, unknown>[]
      const pauseStates = await pauseStateByProduct(
        products.map((product) => ({
          productId: String(product.productId),
          depositVault: (product.depositVaultAddress as string | null) ?? null,
          redemptionVault: (product.redemptionVaultAddress as string | null) ?? null,
        })),
      )
      return products.map((product) => ({
        ...product,
        vaultConfig: configs.get(String(product.productId)) ?? withVaultConfigDefaults(),
        pauseState: pauseStates[String(product.productId)] ?? DEFAULT_PAUSE_STATE,
      }))
    }
    const fileRegistry = loadRegistry()
    if (fileRegistry.chainId !== chainId) throw new Error("Catalog not found")
    const pauseStates = await pauseStateByProduct(
      fileRegistry.products.map((product) => ({
        productId: product.productId,
        depositVault: product.depositVault.proxy,
        redemptionVault: product.redemptionVault.proxy,
      })),
    )
    return fileRegistry.products.map((product) => ({
      ...product,
      paymentAsset: fileRegistry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol) ?? null,
      vaultConfig: configs.get(product.productId) ?? withVaultConfigDefaults(),
      pauseState: pauseStates[product.productId] ?? DEFAULT_PAUSE_STATE,
    }))
  })

  app.get<{ Params: { chainId: string } }>("/api/v1/evm/market/:chainId", async (request, reply) => {
    if (!services.market) return reply.code(503).send({ error: "Market service unavailable" })
    return services.market.market(parseChainId(request.params.chainId))
  })

  app.get<{ Params: { chainId: string; productId: string } }>(
    "/api/v1/evm/market/:chainId/:productId/history",
    async (request, reply) => {
      if (!services.market) return reply.code(503).send({ error: "Market service unavailable" })
      try {
        return await services.market.history(parseChainId(request.params.chainId), request.params.productId)
      } catch (error) {
        return reply.code(404).send({ error: errorMessage(error) })
      }
    },
  )

  app.get<{ Params: { wallet: string } }>("/api/v1/portfolio/:wallet", async (request) =>
    services.portfolio.portfolio(parseAddress(request.params.wallet, "wallet").toLowerCase(), GIWA_CHAIN_ID),
  )

  app.get<{ Params: { wallet: string } }>("/api/v1/activity/:wallet", async (request) =>
    services.portfolio.activity(parseAddress(request.params.wallet, "wallet").toLowerCase(), GIWA_CHAIN_ID),
  )

  app.get<{ Params: { wallet: string } }>("/api/v1/redemptions/:wallet", async (request) =>
    services.portfolio.redemptions(parseAddress(request.params.wallet, "wallet").toLowerCase(), GIWA_CHAIN_ID),
  )

  app.get<{ Params: { wallet: string } }>("/api/v1/faucet/:wallet/status", async (request) =>
    services.portfolio.faucetStatus(parseAddress(request.params.wallet, "wallet").toLowerCase(), GIWA_CHAIN_ID),
  )

  app.post("/api/v1/auth/nonce", async (request, reply) => {
    const body = asObject(request.body)
    const walletAddress = parseAddress(body.walletAddress, "walletAddress").toLowerCase()
    const domain = typeof body.domain === "string" && body.domain ? body.domain : null
    if (!domain) return reply.code(400).send({ error: "domain is required" })
    const nonce = generateNonce()
    const now = new Date()
    await services.arco.issueAuthNonce({
      walletAddress,
      domain,
      nonce,
      ttlSeconds: env.authNonceTtlSeconds,
      now,
    })
    return {
      walletAddress,
      domain,
      nonce,
      expiresAt: new Date(now.getTime() + env.authNonceTtlSeconds * 1000).toISOString(),
    }
  })

  app.post("/api/v1/auth/verify", async (request, reply) => {
    const body = asObject(request.body)
    if (typeof body.message !== "string" || typeof body.signature !== "string") {
      return reply.code(400).send({ error: "message and signature are required" })
    }

    let message: SiweMessage
    try {
      message = new SiweMessage(body.message)
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }

    if (message.chainId !== GIWA_CHAIN_ID) return reply.code(400).send({ error: "SIWE chainId must be 91342" })

    const verification = await message.verify(
      { signature: body.signature, domain: message.domain, nonce: message.nonce },
      { suppressExceptions: true },
    )
    if (!verification.success) return reply.code(401).send({ error: "SIWE signature verification failed" })

    const consumed = await services.arco.consumeAuthNonce({
      walletAddress: message.address,
      domain: message.domain,
      nonce: message.nonce,
    })
    if (!consumed) return reply.code(401).send({ error: "SIWE nonce is expired, unknown, or already used" })

    const walletAddress = message.address.toLowerCase()
    const token = signJwt({ sub: walletAddress, domain: message.domain, chainId: message.chainId }, env.authJwtSecret, {
      expiresIn: "15m",
    })
    return { token, walletAddress, chainId: message.chainId, expiresIn: 900 }
  })

  app.post("/api/v1/attestations", { preHandler: requireSession }, async (request) => {
    const body = asObject(request.body)
    const user = request.user as JwtPayload
    return services.arco.createWalletAttestation({
      walletAddress: user.sub,
      domain: user.domain,
      statement: typeof body.statement === "string" ? body.statement : null,
      signature: typeof body.signature === "string" ? body.signature : "",
      issuedAt: typeof body.issuedAt === "string" ? new Date(body.issuedAt) : new Date(),
      expiresAt: typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null,
    })
  })

  app.post<{ Params: { address: string } }>(
    "/api/v1/admin/wallets/:address/greenlist",
    { preHandler: requireOperator },
    async (request, reply) => {
      try {
        return { transactions: buildGreenlistTransactions(loadRegistry(), parseAddress(request.params.address, "address")) }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/price",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (typeof body.answer !== "string") return reply.code(400).send({ error: "answer string is required" })
      try {
        return { transaction: buildSetPriceTransaction(loadRegistry(), request.params.productId, BigInt(body.answer)) }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  // ── Per-vault limits (ArcoDepositVault / ArcoRedemptionVault setLimits) ──────
  // Inputs are HUMAN units (whole tokens/shares), scaled server-side in the builder. A cap of 0
  // would brick the vault, so the three caps must be > 0 → 400 (minimums may be 0). There is no
  // vaultMintAllowance >= maxSupplyCap constraint (not a contract invariant; deployed vaults ship
  // with mintAllowance < maxSupplyCap).
  const isNonNegativeDecimal = (value: unknown): value is string => typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
  const isPositiveDecimal = (value: unknown): value is string => isNonNegativeDecimal(value) && Number(value) > 0

  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/deposit-limits",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (!isNonNegativeDecimal(body.minimumDeposit)) {
        return reply.code(400).send({ error: "minimumDeposit must be a non-negative number" })
      }
      if (!isPositiveDecimal(body.maxSupplyCap) || !isPositiveDecimal(body.vaultMintAllowance)) {
        return reply.code(400).send({ error: "maxSupplyCap and vaultMintAllowance must be numbers greater than 0" })
      }
      try {
        return {
          transaction: buildSetDepositLimitsTransaction(loadRegistry(), request.params.productId, {
            minimumDeposit: body.minimumDeposit,
            maxSupplyCap: body.maxSupplyCap,
            vaultMintAllowance: body.vaultMintAllowance,
          }),
        }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/redemption-limits",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (!isNonNegativeDecimal(body.minimumRedeem)) {
        return reply.code(400).send({ error: "minimumRedeem must be a non-negative number" })
      }
      if (!isPositiveDecimal(body.vaultRedeemAllowance)) {
        return reply.code(400).send({ error: "vaultRedeemAllowance must be a number greater than 0" })
      }
      try {
        return {
          transaction: buildSetRedemptionLimitsTransaction(loadRegistry(), request.params.productId, {
            minimumRedeem: body.minimumRedeem,
            vaultRedeemAllowance: body.vaultRedeemAllowance,
          }),
        }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  // Current on-chain limits, de-scaled to HUMAN units with the SAME registry decimals the builder
  // scales up with (exact round-trip). Operator-guarded like the other admin reads.
  app.get<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/limits",
    { preHandler: requireOperator },
    async (request, reply) => {
      if (!services.readVaultLimits) return reply.code(503).send({ error: "Limits reader unavailable" })
      const registry = loadRegistry()
      const product = registry.products.find((candidate) => candidate.productId === request.params.productId)
      if (!product) return reply.code(404).send({ error: `Unknown productId ${request.params.productId}` })
      const decimals = registry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)?.decimals ?? 18
      const depositVault = product.depositVault.proxy
      const redemptionVault = product.redemptionVault.proxy
      if (!depositVault || !redemptionVault || !isAddress(depositVault) || !isAddress(redemptionVault)) {
        return reply.code(409).send({ error: "Vault is not deployed" })
      }
      const raw = await services.readVaultLimits({ depositVault, redemptionVault })
      if (!raw) return reply.code(502).send({ error: "Failed to read on-chain limits" })
      return {
        limits: {
          deposit: {
            minimumDeposit: formatUnits(BigInt(raw.minimumDeposit), decimals),
            maxSupplyCap: formatUnits(BigInt(raw.maxSupplyCap), 18),
            vaultMintAllowance: formatUnits(BigInt(raw.vaultMintAllowance), 18),
          },
          redemption: {
            minimumRedeem: formatUnits(BigInt(raw.minimumRedeem), 18),
            vaultRedeemAllowance: formatUnits(BigInt(raw.vaultRedeemAllowance), decimals),
          },
        },
        paymentDecimals: decimals,
        shareDecimals: 18,
      }
    },
  )

  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/healthy-diff",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (typeof body.seconds !== "string") return reply.code(400).send({ error: "seconds string is required" })
      try {
        return { transaction: buildSetHealthyDiffTransaction(loadRegistry(), request.params.productId, BigInt(body.seconds)) }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  for (const action of ["pause", "unpause"] as const) {
    app.post<{ Params: { productId: string } }>(
      `/api/v1/admin/products/:productId/${action}`,
      { preHandler: requireOperator },
      async (request, reply) => {
        const body = asObject(request.body)
        const target = body.target === "depositVault" || body.target === "redemptionVault" ? body.target : "allVaults"
        try {
          return { transactions: buildPauseTransactions(loadRegistry(), request.params.productId, action, target) }
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) })
        }
      },
    )
  }

  // Per-kind function-level pause: builds the two pauseFn/unpauseFn txs for the kind's
  // entry-path selectors (see FUNCTION_PAUSE_SELECTORS). Signing happens client-side
  // with the connected PAUSER_ROLE wallet, same prepare->sign flow as the other utils.
  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/function-pause",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      const kind = body.kind === "deposit" || body.kind === "withdraw" ? body.kind : null
      if (!kind) return reply.code(400).send({ error: "kind must be 'deposit' or 'withdraw'" })
      if (typeof body.paused !== "boolean") return reply.code(400).send({ error: "paused boolean is required" })
      try {
        return {
          transactions: buildFunctionPauseTransactions(loadRegistry(), request.params.productId, kind, body.paused),
        }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/liquidity",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (typeof body.amount !== "string") return reply.code(400).send({ error: "amount string is required" })
      try {
        return { transaction: buildLiquidityTransaction(loadRegistry(), request.params.productId, BigInt(body.amount)) }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  // Admin withdrawal of pooled deposits (deposit vault -> `to`). `to` is client-supplied
  // (console defaults it to the connected operator wallet); the signer is the trust boundary.
  // MAINNET: constrain `to` to a configured treasury/multisig allowlist before building.
  app.post<{ Params: { productId: string } }>(
    "/api/v1/admin/products/:productId/withdraw",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (typeof body.amount !== "string") return reply.code(400).send({ error: "amount string is required" })
      let to: Address
      try {
        to = parseAddress(body.to, "to")
      } catch {
        return reply.code(400).send({ error: "to must be a valid EVM address" })
      }
      try {
        return { transaction: buildWithdrawTransaction(loadRegistry(), request.params.productId, to, BigInt(body.amount)) }
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
    },
  )

  // Unsettled redemptions (REQUESTED + in-flight SETTLING) for the vault-management console.
  app.get("/api/v1/admin/redemptions/pending", { preHandler: requireOperator }, async () => ({
    redemptions: await services.arco.pendingRedemptions(GIWA_CHAIN_ID),
  }))

  // Read-only monitoring dashboard aggregates (see EvmMonitoringService for the v1
  // timestamp caveats). Operator-guarded like the other admin console reads.
  app.get<{ Params: { chainId: string } }>(
    "/api/v1/admin/monitoring/:chainId/overview",
    { preHandler: requireOperator },
    async (request, reply) => {
      if (!services.monitoring) return reply.code(503).send({ error: "Monitoring service unavailable" })
      return services.monitoring.overview(parseChainId(request.params.chainId))
    },
  )

  app.get<{ Params: { chainId: string } }>(
    "/api/v1/admin/monitoring/:chainId/vaults",
    { preHandler: requireOperator },
    async (request, reply) => {
      if (!services.monitoring) return reply.code(503).send({ error: "Monitoring service unavailable" })
      return services.monitoring.vaults(parseChainId(request.params.chainId))
    },
  )

  app.get<{ Params: { chainId: string; productId: string } }>(
    "/api/v1/admin/monitoring/:chainId/products/:productId",
    { preHandler: requireOperator },
    async (request, reply) => {
      if (!services.monitoring) return reply.code(503).send({ error: "Monitoring service unavailable" })
      try {
        return await services.monitoring.detail(parseChainId(request.params.chainId), request.params.productId)
      } catch (error) {
        return reply.code(404).send({ error: errorMessage(error) })
      }
    },
  )

  // 2c-1 "Register deployed vault": validates the pasted addresses against the registry
  // FILE (source of truth, written by the deploy harness) and against the CHAIN, then
  // upserts the DB registry row + a hidden VaultConfig. Custody note: ProxyAdmin
  // ownership & impl-bytecode equivalence MUST be verified before any mainnet use —
  // whatever this route cannot verify is returned in `unverified`.
  app.post("/api/v1/admin/registry/register-product", { preHandler: requireOperator }, async (request, reply) => {
    if (!services.register) return reply.code(503).send({ error: "Register service unavailable" })
    const body = asObject(request.body)
    if (typeof body.productId !== "string" || !body.productId) {
      return reply.code(400).send({ error: "productId is required" })
    }
    const addresses = asObject(body.addresses) as Partial<Record<ProxySlot, string>>
    try {
      return await services.register.register(GIWA_CHAIN_ID, {
        productId: body.productId,
        addresses: {
          productToken: String(addresses.productToken ?? ""),
          depositVault: String(addresses.depositVault ?? ""),
          redemptionVault: String(addresses.redemptionVault ?? ""),
          priceFeed: String(addresses.priceFeed ?? ""),
        },
      })
    } catch (error) {
      if (error instanceof RegisterError) return reply.code(error.status).send({ error: error.message })
      return reply.code(500).send({ error: errorMessage(error) })
    }
  })

  // Off-chain vault config (admin-ia-plan §2). Category must stay within the fixed
  // taxonomy — the investor filter bar and row highlight consult it, so a free-text
  // value would make a vault unfilterable. Values MUST match the frontend GiwaCategory
  // union exactly ("U.S Treasuries" has no period there; the period is display-only).
  const VAULT_CATEGORIES = ["U.S Treasuries", "Prime Credit", "Arco Saving", "Equity Exposure"] as const
  // Literal copy of shared/vault-taxonomy.ts VAULT_KINDS (kept local for the server dist layout;
  // a drift test in app.test.ts guards it against the shared source).
  const VAULT_KINDS = ["product", "saving"] as const

  app.get<{ Params: { chainId: string } }>(
    "/api/v1/admin/vault-config/:chainId",
    { preHandler: requireOperator },
    async (request) => {
      const chainId = parseChainId(request.params.chainId)
      const configs = await vaultConfigByProduct(chainId)
      const registry = loadRegistry()
      return {
        configs: registry.products.map((product) => ({
          productId: product.productId,
          symbol: product.symbol,
          ...(configs.get(product.productId) ?? withVaultConfigDefaults()),
        })),
      }
    },
  )

  app.put<{ Params: { chainId: string; productId: string } }>(
    "/api/v1/admin/vault-config/:chainId/:productId",
    { preHandler: requireOperator },
    async (request, reply) => {
      const chainId = parseChainId(request.params.chainId)
      const { productId } = request.params
      const registry = loadRegistry()
      if (!registry.products.some((product) => product.productId === productId)) {
        return reply.code(404).send({ error: `Unknown productId ${productId}` })
      }

      const body = asObject(request.body)
      const patch: Record<string, unknown> = {}
      // Plain string fields (empty string normalized to null = "clear override").
      for (const key of [
        "displayName",
        "category",
        "description",
        "adminDepositAddress",
        "assetManagerName",
        "issuerName",
        "about",
      ] as const) {
        if (!(key in body)) continue
        const value = body[key]
        if (value !== null && typeof value !== "string") {
          return reply.code(400).send({ error: `${key} must be a string or null` })
        }
        patch[key] = typeof value === "string" && value.trim() === "" ? null : value
      }
      // AUM: free-text display figure (e.g. "$50B"); trim, cap length, blank -> null.
      if ("aum" in body) {
        const value = body.aum
        if (value !== null && typeof value !== "string") {
          return reply.code(400).send({ error: "aum must be a string or null" })
        }
        const trimmed = typeof value === "string" ? value.trim() : ""
        if (trimmed === "") patch.aum = null
        else if (trimmed.length > 24) return reply.code(400).send({ error: "aum must be at most 24 characters" })
        else patch.aum = trimmed
      }
      // URL fields — images plus the three "More info" docs links. Same rule for both:
      // absolute http(s) URL or a repo /public path.
      for (const key of [
        "vaultImageUrl",
        "assetManagerImageUrl",
        "issuerImageUrl",
        "docsUrl",
        "legalUrl",
        "risksUrl",
      ] as const) {
        if (!(key in body)) continue
        const value = body[key]
        if (value !== null && typeof value !== "string") {
          return reply.code(400).send({ error: `${key} must be a string or null` })
        }
        const trimmed = typeof value === "string" ? value.trim() : ""
        // Absolute http(s) URL, or a single-leading-slash repo path. The path branch
        // rejects protocol-relative "//host" (which a browser would fetch cross-origin).
        if (trimmed === "") {
          patch[key] = null
        } else if (!/^https?:\/\/.+/.test(trimmed) && !/^\/[^/\s]\S*$/.test(trimmed)) {
          return reply.code(400).send({ error: `${key} must be an http(s) URL or a /path` })
        } else if (trimmed.length > 2048) {
          return reply.code(400).send({ error: `${key} must be at most 2048 characters` })
        } else {
          patch[key] = trimmed
        }
      }
      // Fee fields: integer basis points 0–10000 (= 0–100%).
      for (const key of ["feeInstantMintingBps", "feeInstantRedemptionBps", "feeManagementBps", "feePerformanceBps"] as const) {
        if (!(key in body)) continue
        const value = body[key]
        if (value === null) {
          patch[key] = null
          continue
        }
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000) {
          return reply.code(400).send({ error: `${key} must be an integer 0–10000 basis points (0–100%) or null` })
        }
        patch[key] = value
      }
      // Redemption timeline: non-negative integer days.
      if ("redemptionTimelineDays" in body) {
        const value = body.redemptionTimelineDays
        if (value === null) {
          patch.redemptionTimelineDays = null
        } else if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          return reply.code(400).send({ error: "redemptionTimelineDays must be a non-negative integer or null" })
        } else {
          patch.redemptionTimelineDays = value
        }
      }
      // Portfolio breakdowns: array of slices, sum ~100%; empty/null = clear override
      // (not an error). Keep in sync with the client validator in src/demo/giwa/display-profile.ts.
      for (const key of ["portfolioSnapshot", "portfolioIndustry", "portfolioExposure"] as const) {
        if (!(key in body)) continue
        const value = body[key]
        if (value === null) {
          patch[key] = null
          continue
        }
        const result = validatePortfolioSlices(value)
        if (!result.ok) return reply.code(400).send({ error: `${key}: ${result.error}` })
        patch[key] = result.slices!.length === 0 ? null : result.slices
      }
      // Accept-assets (Savings page): ordered array; empty/null clears (not an error). Only touched
      // when the caller sends the key — a kind-only PUT (e.g. saving→product) OMITS it, so stored
      // accept-assets stay dormant and are NOT re-validated (reversible). A real asset's
      // savingVaultId must reference a known saving vault (∪ the vault being edited). Keep the shape
      // rules in sync with the client validator in src/demo/giwa/display-profile.ts.
      if ("acceptAssets" in body) {
        const value = body.acceptAssets
        if (value === null) {
          patch.acceptAssets = null
        } else {
          const configs = await vaultConfigByProduct(chainId)
          const savingVaultIds = new Set<string>([productId])
          for (const candidate of registry.products) {
            if (configs.get(candidate.productId)?.kind === "saving") savingVaultIds.add(candidate.productId)
          }
          const result = validateAcceptAssets(value, savingVaultIds)
          if (!result.ok) return reply.code(400).send({ error: `acceptAssets: ${result.error}` })
          patch.acceptAssets = result.assets!.length === 0 ? null : result.assets
        }
      }
      for (const key of [
        "cardSnapshot",
        "cardIndustry",
        "cardExposure",
        "pinned",
        "hidden",
        "docsShown",
        "legalShown",
        "risksShown",
      ] as const) {
        if (!(key in body)) continue
        if (typeof body[key] !== "boolean") {
          return reply.code(400).send({ error: `${key} must be a boolean` })
        }
        patch[key] = body[key]
      }

      // kind is a non-null enum (NOT routed through the string loop, which normalizes "" -> null).
      if ("kind" in body) {
        if (!VAULT_KINDS.includes(body.kind as (typeof VAULT_KINDS)[number])) {
          return reply.code(400).send({ error: `kind must be one of: ${VAULT_KINDS.join(" · ")}` })
        }
        patch.kind = body.kind
      }

      if (patch.category != null && !VAULT_CATEGORIES.includes(patch.category as (typeof VAULT_CATEGORIES)[number])) {
        return reply.code(400).send({ error: `unknown category — must be one of: ${VAULT_CATEGORIES.join(" · ")}` })
      }
      if (typeof patch.adminDepositAddress === "string") {
        try {
          patch.adminDepositAddress = parseAddress(patch.adminDepositAddress, "adminDepositAddress")
        } catch (error) {
          return reply.code(400).send({ error: errorMessage(error) })
        }
      }

      const existing = (await vaultConfigByProduct(chainId)).get(productId) ?? withVaultConfigDefaults()
      const merged: VaultConfigValues = { ...existing, ...(patch as Partial<VaultConfigValues>) }
      if (!merged.cardSnapshot && !merged.cardIndustry && !merged.cardExposure) {
        return reply.code(400).send({ error: "at least one portfolio card view must stay on" })
      }

      await services.arco.upsertVaultConfig({ chainId, productId, ...merged })
      return { productId, ...merged }
    },
  )

  // Global cross-vault Savings selector order. The flat admin panel PUTs the ordered list of
  // { productId, symbol }; the server assigns sortOrder = array index and rewrites ONLY that field
  // on the matched accept-assets, preserving every other field. Same operator guard as vault-config.
  // Atomic: all affected vaults' acceptAssets are written in one transaction (services.arco.setSavingsOrder).
  app.put<{ Params: { chainId: string } }>(
    "/api/v1/admin/savings-order/:chainId",
    { preHandler: requireOperator },
    async (request, reply) => {
      const chainId = parseChainId(request.params.chainId)
      const registry = loadRegistry()
      const body = asObject(request.body)
      const order = body.order
      if (!Array.isArray(order)) {
        return reply.code(400).send({ error: "order must be an array of { productId, symbol }" })
      }
      const items: Array<{ productId: string; symbol: string }> = []
      for (let i = 0; i < order.length; i += 1) {
        const raw = order[i] as Record<string, unknown> | null
        if (!raw || typeof raw !== "object" || typeof raw.productId !== "string" || typeof raw.symbol !== "string") {
          return reply.code(400).send({ error: `order[${i}] must be { productId, symbol }` })
        }
        items.push({ productId: raw.productId, symbol: raw.symbol })
      }

      const configs = await vaultConfigByProduct(chainId)
      const savingVaultIds = new Set<string>()
      for (const product of registry.products) {
        if (configs.get(product.productId)?.kind === "saving") savingVaultIds.add(product.productId)
      }

      // Validate every item up-front (all-or-nothing before any write): the vault must be a current
      // saving vault and the (productId, symbol) must resolve to one of its accept-assets.
      const sortByKey = new Map<string, number>()
      const key = (productId: string, symbol: string) => `${productId}:${symbol}`
      for (const [index, item] of items.entries()) {
        if (!savingVaultIds.has(item.productId)) {
          return reply.code(400).send({ error: `order[${index}] productId "${item.productId}" is not a saving vault` })
        }
        const assets = configs.get(item.productId)?.acceptAssets ?? []
        if (!assets.some((asset) => asset.symbol === item.symbol)) {
          return reply.code(400).send({ error: `order[${index}] "${item.symbol}" is not an accept-asset of ${item.productId}` })
        }
        sortByKey.set(key(item.productId, item.symbol), index)
      }

      // Rebuild each affected vault's acceptAssets: set sortOrder on the listed (productId, symbol),
      // leave every other asset (and field) exactly as stored — an unlisted asset keeps its order.
      const affected = new Set(items.map((item) => item.productId))
      const updates: Array<{ productId: string; acceptAssets: VaultAcceptAsset[] | null }> = []
      for (const productId of affected) {
        const assets = (configs.get(productId)?.acceptAssets ?? []).map((asset) => {
          const at = sortByKey.get(key(productId, asset.symbol))
          return at === undefined ? asset : { ...asset, sortOrder: at }
        })
        updates.push({ productId, acceptAssets: assets.length === 0 ? null : assets })
      }
      await services.arco.setSavingsOrder(chainId, updates)
      return { ok: true, updated: updates.map((update) => update.productId) }
    },
  )

  // ── Featured cards (products-page hero carousel) ────────────────────────────
  // A small ordered collection (MAX 3) of DEPLOYED, non-hidden vaults to feature. Identity
  // (name + logo) is resolved config-first from VaultConfig at render time, so only the
  // card-scoped intro + show/hide + order are stored here. A newly added card starts hidden.
  const FEATURED_ABOUT_MAX = 140
  const FEATURED_MAX = 3

  // A catalog/registry item is "deployed" when all five addresses are present. Handles both
  // shapes: the DB-registry path (flat productTokenAddress…) and the file-registry path
  // (nested productToken.proxy…).
  function serverHasDeployment(item: Record<string, unknown>): boolean {
    const proxy = (value: unknown) => (value as { proxy?: string } | null)?.proxy
    const flat = Boolean(
      item.productTokenAddress &&
        item.paymentAssetAddress &&
        item.depositVaultAddress &&
        item.redemptionVaultAddress &&
        item.priceFeedAddress,
    )
    const nested = Boolean(
      proxy(item.productToken) && proxy(item.depositVault) && proxy(item.redemptionVault) && proxy(item.priceFeed),
    )
    return flat || nested
  }

  // Vaults eligible to be featured: LISTED in the registry, DEPLOYED (5 addresses), and NOT
  // hidden (hidden is investor-UI declutter, but a hidden vault must not be featurable).
  async function featurableProductIds(chainId: number): Promise<Set<string>> {
    const configs = await vaultConfigByProduct(chainId)
    const dbRegistry = await services.registry.getRegistry(chainId)
    const items = (
      dbRegistry.network ? dbRegistryToCatalog(dbRegistry) : loadRegistry().products
    ) as Record<string, unknown>[]
    const ids = new Set<string>()
    for (const item of items) {
      const productId = String(item.productId)
      const config = configs.get(productId) ?? withVaultConfigDefaults()
      if (serverHasDeployment(item) && !config.hidden) ids.add(productId)
    }
    return ids
  }

  function serializeFeatured(row: {
    id: string
    productId: string
    about: string | null
    shown: boolean
    position: number
  }) {
    return { id: row.id, productId: row.productId, about: row.about ?? null, shown: Boolean(row.shown), position: row.position ?? 0 }
  }

  // Validate an optional `about` field: string ≤140 (trimmed; blank → null).
  function readFeaturedAbout(body: Record<string, unknown>): { value: string | null } | { error: string } {
    const value = body.about
    if (value === null || value === undefined) return { value: null }
    if (typeof value !== "string") return { error: "about must be a string or null" }
    const trimmed = value.trim()
    if (trimmed.length > FEATURED_ABOUT_MAX) return { error: `about must be at most ${FEATURED_ABOUT_MAX} characters` }
    return { value: trimmed === "" ? null : trimmed }
  }

  // Public read for the investor carousel: SHOWN-only, ordered. Hidden cards never leave the
  // server, so the carousel needs no client-side state filtering.
  app.get<{ Params: { chainId: string } }>("/api/v1/evm/featured/:chainId", async (request) => {
    const chainId = parseChainId(request.params.chainId)
    const cards = await services.arco.featuredCards(chainId)
    return { cards: cards.filter((card) => card.shown).map(serializeFeatured) }
  })

  // Admin list: every row (hidden + shown), ordered.
  app.get<{ Params: { chainId: string } }>(
    "/api/v1/admin/featured/:chainId",
    { preHandler: requireOperator },
    async (request) => {
      const chainId = parseChainId(request.params.chainId)
      const cards = await services.arco.featuredCards(chainId)
      return { cards: cards.map(serializeFeatured) }
    },
  )

  app.post<{ Params: { chainId: string } }>(
    "/api/v1/admin/featured/:chainId",
    { preHandler: requireOperator },
    async (request, reply) => {
      const chainId = parseChainId(request.params.chainId)
      const body = asObject(request.body)
      const productId = body.productId
      if (typeof productId !== "string" || productId.trim() === "") {
        return reply.code(400).send({ error: "productId is required" })
      }
      const existing = await services.arco.featuredCards(chainId)
      if (existing.length >= FEATURED_MAX) {
        return reply.code(400).send({ error: `A maximum of ${FEATURED_MAX} featured cards is allowed` })
      }
      if (existing.some((card) => card.productId === productId)) {
        return reply.code(409).send({ error: "This vault is already featured" })
      }
      if (!(await featurableProductIds(chainId)).has(productId)) {
        return reply.code(400).send({ error: "productId must be a deployed, listed (non-hidden) vault" })
      }
      const about = readFeaturedAbout(body)
      if ("error" in about) return reply.code(400).send({ error: about.error })
      const shown = body.shown === undefined ? false : body.shown
      if (typeof shown !== "boolean") return reply.code(400).send({ error: "shown must be a boolean" })
      const created = await services.arco.createFeaturedCard({
        chainId,
        productId,
        about: about.value,
        shown,
        position: existing.length,
      })
      return serializeFeatured(created)
    },
  )

  app.put<{ Params: { chainId: string; id: string } }>(
    "/api/v1/admin/featured/:chainId/:id",
    { preHandler: requireOperator },
    async (request, reply) => {
      const chainId = parseChainId(request.params.chainId)
      const { id } = request.params
      if (!(await services.arco.featuredCards(chainId)).some((card) => card.id === id)) {
        return reply.code(404).send({ error: "Featured card not found" })
      }
      const body = asObject(request.body)
      const patch: { about?: string | null; shown?: boolean; position?: number } = {}
      if ("about" in body) {
        const about = readFeaturedAbout(body)
        if ("error" in about) return reply.code(400).send({ error: about.error })
        patch.about = about.value
      }
      if ("shown" in body) {
        if (typeof body.shown !== "boolean") return reply.code(400).send({ error: "shown must be a boolean" })
        patch.shown = body.shown
      }
      if ("position" in body) {
        if (typeof body.position !== "number" || !Number.isInteger(body.position) || body.position < 0) {
          return reply.code(400).send({ error: "position must be a non-negative integer" })
        }
        patch.position = body.position
      }
      const updated = await services.arco.updateFeaturedCard(id, patch)
      return serializeFeatured(updated)
    },
  )

  app.delete<{ Params: { chainId: string; id: string } }>(
    "/api/v1/admin/featured/:chainId/:id",
    { preHandler: requireOperator },
    async (request, reply) => {
      const chainId = parseChainId(request.params.chainId)
      const { id } = request.params
      if (!(await services.arco.featuredCards(chainId)).some((card) => card.id === id)) {
        return reply.code(404).send({ error: "Featured card not found" })
      }
      await services.arco.deleteFeaturedCard(id)
      return { ok: true, id }
    },
  )

  // Direct-transfer payout: unsigned ERC20 transfer (payment token -> requester). Atomically
  // claims REQUESTED -> SETTLING so a second payout for the same request 409s while one is
  // in flight or after settlement (double-pay guard).
  app.post<{ Params: { requestId: string } }>(
    "/api/v1/admin/redemptions/:requestId/payout",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (typeof body.amount !== "string") return reply.code(400).send({ error: "amount string is required" })
      const redemption = (await services.arco.findRedemptionRequest(GIWA_CHAIN_ID, request.params.requestId)) as
        | { productId?: string; walletAddress?: string; status?: string }
        | null
      if (!redemption?.productId || !redemption.walletAddress || !isAddress(redemption.walletAddress)) {
        return reply.code(404).send({ error: "Redemption request not found" })
      }
      let transaction
      try {
        transaction = buildPayoutTransaction(
          loadRegistry(),
          redemption.productId,
          getAddress(redemption.walletAddress),
          BigInt(body.amount),
        )
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) })
      }
      const claimed = await services.arco.markRedemptionSettling({
        chainId: GIWA_CHAIN_ID,
        requestId: request.params.requestId,
      })
      if (claimed.count === 0) {
        return reply.code(409).send({ error: "Redemption is already settling or settled" })
      }
      return { transaction }
    },
  )

  // Persist the confirmed payout: SETTLING/REQUESTED -> SETTLED + payout tx hash. This is the
  // status the investor Pending tab renders as "Completed".
  app.post<{ Params: { requestId: string } }>(
    "/api/v1/admin/redemptions/:requestId/settle",
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = asObject(request.body)
      if (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
        return reply.code(400).send({ error: "txHash (0x + 64 hex chars) is required" })
      }
      const settled = await services.arco.markRedemptionSettled({
        chainId: GIWA_CHAIN_ID,
        requestId: request.params.requestId,
        txHash: body.txHash,
      })
      if (settled.count === 0) {
        return reply.code(409).send({ error: "Redemption request not found or already settled" })
      }
      return { ok: true, requestId: request.params.requestId, status: "SETTLED" }
    },
  )

  // Cancelled/failed payout recovery: SETTLING -> REQUESTED only, so the request can be paid
  // again. SETTLED rows are untouchable here — a landed payout can never be re-opened.
  app.post<{ Params: { requestId: string } }>(
    "/api/v1/admin/redemptions/:requestId/release",
    { preHandler: requireOperator },
    async (request, reply) => {
      const released = await services.arco.markRedemptionReleased({
        chainId: GIWA_CHAIN_ID,
        requestId: request.params.requestId,
      })
      if (released.count === 0) {
        return reply.code(409).send({ error: "Redemption request is not in SETTLING" })
      }
      return { ok: true, requestId: request.params.requestId, status: "REQUESTED" }
    },
  )

  app.post<{ Params: { requestId: string } }>(
    "/api/v1/admin/redemptions/:requestId/fulfill",
    { preHandler: requireOperator },
    async (request, reply) => {
      const redemption = (await services.arco.findRedemptionRequest(GIWA_CHAIN_ID, request.params.requestId)) as
        | { redemptionVaultAddress?: string; status?: string }
        | null
      if (!redemption?.redemptionVaultAddress || !isAddress(redemption.redemptionVaultAddress)) {
        return reply.code(404).send({ error: "Redemption request not found" })
      }
      // Direct-transfer double-pay guard: a settled (or in-flight settling) request must
      // never ALSO be fulfilled on-chain — the vault would pay the requester a second time.
      if (redemption.status === "SETTLED" || redemption.status === "SETTLING") {
        return reply.code(409).send({ error: `Redemption is ${redemption.status}; fulfill would double-pay` })
      }
      return {
        transaction: buildFulfillRedeemTransaction(
          loadRegistry(),
          getAddress(redemption.redemptionVaultAddress),
          BigInt(request.params.requestId),
        ),
      }
    },
  )

  app.setErrorHandler((error, _request, reply) => {
    reply.code(400).send({ error: errorMessage(error) })
  })

  if (services.stocks) app.register(stocksPlugin, services.stocks)
  if (services.stocksExecution) app.register(stocksExecutionPlugin, services.stocksExecution)
  if (services.stocksSubmissions) app.register(stocksSubmissionsPlugin, services.stocksSubmissions)
  if (services.stocksMarketData) app.register(stocksMarketDataPlugin, { service: services.stocksMarketData })
  return app
}

declare module "fastify" {
  interface FastifyRequest {
    user?: JwtPayload
  }
}
