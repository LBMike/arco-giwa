// Response validation for the GIWA Stocks API. Every value that reaches the UI passes one of
// these guards; anything else is an INVALID_RESPONSE, never a best-effort render.

import { isBaseUnits, isHumanDecimal, isSignedBaseUnits } from "./decimal"
import {
  BUY_ORDER_STATES,
  GIWA_STOCKS_CHAIN_ID,
  SELL_ORDER_STATES,
  STOCKS_QUANTITY_SCALE,
  type BuyOrderState,
  type HexAddress,
  type SellOrderState,
  type StocksActivityEntry,
  type StocksCatalog,
  type StocksContracts,
  type StocksDirectHold,
  type StocksDirectStatus,
  type StocksEnvelope,
  type StocksHolding,
  type StocksInstrument,
  type StocksOrder,
  type StocksPendingOrder,
  type StocksPortfolio,
  type StocksQuote,
  type StocksSide,
} from "./types"

export class StocksResponseError extends Error {
  constructor(readonly path: string) {
    super(`INVALID_RESPONSE:${path}`)
    this.name = "StocksResponseError"
  }
}

type Json = Record<string, unknown>

function fail(path: string): never {
  throw new StocksResponseError(path)
}

function record(value: unknown, path: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path)
  return value as Json
}

function text(value: unknown, path: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(path)
  return value
}

function units(value: unknown, path: string): string {
  if (!isBaseUnits(value)) fail(path)
  return value
}

function signedUnits(value: unknown, path: string): string {
  if (!isSignedBaseUnits(value)) fail(path)
  return value
}

function positiveUnits(value: unknown, path: string): string {
  const result = units(value, path)
  if (result === "0") fail(path)
  return result
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

function instant(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) fail(path)
  return value
}

function lowerAddress(value: unknown, path: string): HexAddress {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) fail(path)
  return value as HexAddress
}

function member<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(path)
  return value as T
}

function profile(value: Json, path: string): void {
  if (
    value.profile !== "DEMO_TESTNET" ||
    value.valuePolicy !== "TEST_VALUE_ONLY" ||
    value.brokerMode !== "MOCK_BROKER" ||
    value.chainId !== GIWA_STOCKS_CHAIN_ID ||
    value.priceSource !== "FIXED_MOCK_PRICE"
  ) {
    fail(`${path}.profile`)
  }
}

/** GET /catalog — the only top-level (non-envelope) response. */
export function parseCatalog(input: unknown): StocksCatalog {
  const root = record(input, "catalog")
  profile(root, "catalog")
  if (!Array.isArray(root.instruments) || root.instruments.length > 100) fail("catalog.instruments")
  const instruments: StocksInstrument[] = root.instruments.map((raw, index) => {
    const row = record(raw, `catalog.instruments[${index}]`)
    const path = `catalog.instruments[${index}]`
    if (row.symbol !== "NVDA") fail(`${path}.symbol`)
    if (row.quantityScale !== STOCKS_QUANTITY_SCALE) fail(`${path}.quantityScale`)
    if (!isHumanDecimal(row.price, 6)) fail(`${path}.price`)
    if (row.priceSource !== "FIXED_MOCK_PRICE") fail(`${path}.priceSource`)
    return {
      symbol: "NVDA",
      quantityScale: STOCKS_QUANTITY_SCALE,
      price: row.price,
      priceSource: "FIXED_MOCK_PRICE",
      orderCapability: member(row.orderCapability, ["CHECK_PAUSE_AT_ORDER", "NOT_ACTIVATED"], `${path}.orderCapability`),
      ...(row.tokenAddress === undefined ? {} : { tokenAddress: lowerAddress(row.tokenAddress, `${path}.tokenAddress`) }),
    }
  })
  return {
    profile: "DEMO_TESTNET",
    valuePolicy: "TEST_VALUE_ONLY",
    brokerMode: "MOCK_BROKER",
    chainId: GIWA_STOCKS_CHAIN_ID,
    priceSource: "FIXED_MOCK_PRICE",
    instruments,
    cashSymbol: member(root.cashSymbol, ["ARCO_TEST_USDC", "ARCO_TEST_RLUSD", "tUSDC"], "catalog.cashSymbol"),
    deploymentId: text(root.deploymentId, "catalog.deploymentId", 128),
    observedAt: instant(root.observedAt, "catalog.observedAt"),
    ...(root.contracts === undefined ? {} : { contracts: contractsOf(root.contracts, instruments) }),
  }
}

const CONTRACT_KEYS = ["cashToken", "fundingVault", "stockToken", "redemptionEscrow"] as const

/** The catalog's contracts: exactly four distinct lower-case addresses; NVDA's published token is the stock token. */
function contractsOf(value: unknown, instruments: StocksInstrument[]): StocksContracts {
  const row = record(value, "catalog.contracts")
  if (Object.keys(row).length !== CONTRACT_KEYS.length || !CONTRACT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(row, key))) fail("catalog.contracts")
  const contracts: StocksContracts = {
    cashToken: lowerAddress(row.cashToken, "catalog.contracts.cashToken"),
    fundingVault: lowerAddress(row.fundingVault, "catalog.contracts.fundingVault"),
    stockToken: lowerAddress(row.stockToken, "catalog.contracts.stockToken"),
    redemptionEscrow: lowerAddress(row.redemptionEscrow, "catalog.contracts.redemptionEscrow"),
  }
  if (new Set(CONTRACT_KEYS.map((key) => contracts[key])).size !== CONTRACT_KEYS.length) fail("catalog.contracts")
  if (instruments.some((item) => item.tokenAddress !== undefined && item.tokenAddress !== contracts.stockToken)) fail("catalog.contracts.stockToken")
  return contracts
}

const TX_HASH = /^0x[0-9a-f]{64}$/

function txHash(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !TX_HASH.test(value)) fail(path)
  return value as `0x${string}`
}

/** GET /api/v1/stocks/activity/:wallet data: at most 200 trades, each on a known side and state. */
export function parseStocksActivity(input: unknown): StocksActivityEntry[] {
  if (!Array.isArray(input) || input.length > 200) fail("activity")
  return input.map((raw, index) => {
    const path = `activity[${index}]`
    const row = record(raw, path)
    const base = {
      quantity: units(row.quantity, `${path}.quantity`),
      cashAmount: units(row.cashAmount, `${path}.cashAmount`),
      paymentTx: txHash(row.paymentTx, `${path}.paymentTx`),
      settlementTx: row.settlementTx === null ? null : txHash(row.settlementTx, `${path}.settlementTx`),
      createdAt: instant(row.createdAt, `${path}.createdAt`),
    }
    if (row.side === "SELL") return { side: "SELL" as const, state: member(row.state, SELL_ORDER_STATES, `${path}.state`), ...base }
    if (row.side === "BUY") return { side: "BUY" as const, state: member(row.state, BUY_ORDER_STATES, `${path}.state`), ...base }
    return fail(`${path}.side`)
  })
}

const DIRECT_HOLDS: readonly StocksDirectHold[] = ["TRADING_PAUSED", "PRICE_UNAVAILABLE", "BELOW_ONE_UNIT"]

/** GET /api/v1/stocks/direct/:orderKey data, for the side the key was sent with. */
export function parseDirectStatus(input: unknown, side: StocksSide): StocksDirectStatus {
  const row = record(input, "direct")
  if (row.side !== side) fail("direct.side")
  const quantity = units(row.quantity, "direct.quantity")
  const cashAmount = units(row.cashAmount, "direct.cashAmount")
  instant(row.createdAt, "direct.createdAt")
  instant(row.updatedAt, "direct.updatedAt")
  const hold = row.hold === undefined ? null : member(row.hold, DIRECT_HOLDS, "direct.hold")
  return side === "SELL"
    ? { side, state: member(row.state, SELL_ORDER_STATES, "direct.state"), quantity, cashAmount, hold }
    : { side, state: member(row.state, BUY_ORDER_STATES, "direct.state"), quantity, cashAmount, hold }
}

/** Every authenticated route: { ...profile, observedAt, data }. */
export function parseEnvelope<T>(input: unknown, data: (value: unknown) => T): StocksEnvelope<T> {
  const root = record(input, "envelope")
  profile(root, "envelope")
  const observedAt = instant(root.observedAt, "envelope.observedAt")
  if (!Object.prototype.hasOwnProperty.call(root, "data")) fail("envelope.data")
  return { observedAt, data: data(root.data) }
}

/** BUY rows carry no side on the wire (a literal "BUY" is tolerated); SELL rows must say "SELL". */
function sideOf(row: Json, expected: StocksSide, path: string): StocksSide {
  if (expected === "SELL") {
    if (row.side !== "SELL") fail(`${path}.side`)
  } else if (row.side !== undefined && row.side !== "BUY") {
    fail(`${path}.side`)
  }
  return expected
}

function actor(row: Json, path: string): { actorId: string; wallet: HexAddress } {
  const wallet = lowerAddress(row.wallet, `${path}.wallet`)
  const actorId = text(row.actorId, `${path}.actorId`, 128)
  if (actorId !== `evm:${wallet}`) fail(`${path}.actorId`)
  return { actorId, wallet }
}

export function parseQuote(input: unknown, side: StocksSide): StocksQuote {
  const row = record(input, "quote")
  return {
    side: sideOf(row, side, "quote"),
    id: text(row.id, "quote.id", 128),
    ...actor(row, "quote"),
    symbol: member(row.symbol, ["NVDA"], "quote.symbol"),
    quantity: positiveUnits(row.quantity, "quote.quantity"),
    cashAmount: positiveUnits(row.cashAmount, "quote.cashAmount"),
    deploymentDigest: text(row.deploymentDigest, "quote.deploymentDigest", 128),
    expiresAt: instant(row.expiresAt, "quote.expiresAt"),
    createdAt: instant(row.createdAt, "quote.createdAt"),
  }
}

export function parseOrder(input: unknown, side: StocksSide): StocksOrder {
  const row = record(input, "order")
  const version = row.version
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) fail("order.version")
  const idempotencyKey = text(row.idempotencyKey, "order.idempotencyKey", 128)
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey)) fail("order.idempotencyKey")
  const base = {
    id: text(row.id, "order.id", 128),
    orderKey: text(row.orderKey, "order.orderKey", 128),
    quoteId: text(row.quoteId, "order.quoteId", 128),
    ...actor(row, "order"),
    symbol: member(row.symbol, ["NVDA"], "order.symbol"),
    quantity: positiveUnits(row.quantity, "order.quantity"),
    cashAmount: positiveUnits(row.cashAmount, "order.cashAmount"),
    idempotencyKey,
    deploymentId: text(row.deploymentId, "order.deploymentId", 128),
    deploymentDigest: text(row.deploymentDigest, "order.deploymentDigest", 128),
    quoteExpiresAt: instant(row.quoteExpiresAt, "order.quoteExpiresAt"),
    version,
    createdAt: instant(row.createdAt, "order.createdAt"),
    updatedAt: instant(row.updatedAt, "order.updatedAt"),
  }
  if (!/^0x[0-9a-f]{64}$/.test(base.orderKey)) fail("order.orderKey")
  if (sideOf(row, side, "order") === "SELL") {
    return { ...base, side: "SELL", state: member<SellOrderState>(row.state, SELL_ORDER_STATES, "order.state") }
  }
  return { ...base, side: "BUY", state: member<BuyOrderState>(row.state, BUY_ORDER_STATES, "order.state") }
}

export function parseOrderList(input: unknown, side: StocksSide): StocksOrder[] {
  if (!Array.isArray(input) || input.length > 100) fail("orders")
  return input.map((row) => parseOrder(row, side))
}

export function parsePortfolio(input: unknown): StocksPortfolio {
  const root = record(input, "portfolio")
  if (root.projectionPolicy !== "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS") fail("portfolio.projectionPolicy")
  if (!Array.isArray(root.holdings) || root.holdings.length > 100) fail("portfolio.holdings")
  // No count cap: the server returns every nonterminal order, and the response size is already bounded by the client.
  if (!Array.isArray(root.pending)) fail("portfolio.pending")
  const holdings: StocksHolding[] = root.holdings.map((raw, index) => {
    const path = `portfolio.holdings[${index}]`
    const row = record(raw, path)
    const holding: StocksHolding = {
      wallet: lowerAddress(row.wallet, `${path}.wallet`),
      symbol: member(row.symbol, ["NVDA"], `${path}.symbol`),
      // The server does not clamp these projections: an escrow that does not match its order can
      // leave the wallet or the available quantity negative until review. They are signed on purpose.
      walletQuantity: signedUnits(row.walletQuantity, `${path}.walletQuantity`),
      escrowedQuantity: units(row.escrowedQuantity, `${path}.escrowedQuantity`),
      reservedQuantity: units(row.reservedQuantity, `${path}.reservedQuantity`),
      availableQuantity: signedUnits(row.availableQuantity, `${path}.availableQuantity`),
      quantity: signedUnits(row.quantity, `${path}.quantity`),
    }
    // The server defines available = wallet − reserved and quantity = wallet + escrow. A row that
    // disagrees would make any rendering double count or hide units, so it is refused.
    if ((BigInt(holding.walletQuantity) - BigInt(holding.reservedQuantity)).toString() !== holding.availableQuantity) fail(`${path}.availableQuantity`)
    if ((BigInt(holding.walletQuantity) + BigInt(holding.escrowedQuantity)).toString() !== holding.quantity) fail(`${path}.quantity`)
    return holding
  })
  const pending: StocksPendingOrder[] = root.pending.map((raw, index) => {
    const path = `portfolio.pending[${index}]`
    const row = record(raw, path)
    const common = {
      id: text(row.id, `${path}.id`, 128),
      quantity: positiveUnits(row.quantity, `${path}.quantity`),
      cashAmount: positiveUnits(row.cashAmount, `${path}.cashAmount`),
    }
    if (row.side === "SELL") return { ...common, side: "SELL", state: member<SellOrderState>(row.state, SELL_ORDER_STATES, `${path}.state`) }
    if (row.side === "BUY") return { ...common, side: "BUY", state: member<BuyOrderState>(row.state, BUY_ORDER_STATES, `${path}.state`) }
    return fail(`${path}.side`)
  })
  return { holdings, pending, projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS" }
}

/** A Stocks plugin error body: { error: CODE, ...profile }. Null when the body is anything else. */
export function parseStocksErrorBody(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  const row = input as Json
  try {
    profile(row, "error")
  } catch {
    return null
  }
  return typeof row.error === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(row.error) ? row.error : null
}

/** Fastify's default not-found body, which means the Stocks routes are not registered in this server. */
export function isRouteNotRegisteredBody(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const row = input as Json
  return row.statusCode === 404 && row.error === "Not Found" && typeof row.message === "string" && row.profile === undefined
}
