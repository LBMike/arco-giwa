// TEST SUPPORT ONLY. Server-shaped DTOs (server/src/stocks-execution/plugin.ts, server/src/stocks/plugin.ts and
// the `SELECT *` order rows of prisma/schema.prisma) and a fake fetch. Not exported by index.ts.

import { sha256, toHex, type Address, type Hex } from "viem"

import { STOCKS_ABI_DIGEST } from "../stocks-wallet/abi"
import { digest } from "../stocks-wallet/planner"
import type { AuthenticatedRead, ManifestV2, Side } from "../stocks-wallet/types"
import type { FetchLike } from "./transport"

export const START = Date.UTC(2026, 8, 17, 0, 0, 0)
export const API = "https://stocks-api.test"
export const WALLET = "0x1111111111111111111111111111111111111111" as Address
export const TOKEN = "test-header.test-payload.test-signature"
export const PROFILE = Object.freeze({ profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" })

const contract = (digit: string) => `0x${digit.repeat(40)}` as Address
const bytes32 = (digit: string) => `0x${digit.repeat(64)}` as Hex

export function manifest(): ManifestV2 {
  const contracts = [contract("3"), contract("4"), contract("5"), contract("6"), contract("7")]
  return {
    schemaVersion: 2,
    redemptionEscrow: contracts[4]!,
    deploymentId: "test-deployment-1",
    profile: "DEMO_TESTNET",
    chainId: 91342,
    networkInstance: "test-network-1",
    checkpointNumber: "1",
    checkpointHash: bytes32("a"),
    abiDigest: STOCKS_ABI_DIGEST,
    finalityPolicy: "FINALIZED",
    cashToken: contracts[0]!,
    cashSymbol: "ARCO_TEST_USDC",
    cashScale: 6,
    stockToken: contracts[1]!,
    quantityScale: 9,
    fundingVault: contracts[2]!,
    mintController: contracts[3]!,
    signerAddress: contract("8"),
    codeHashes: Object.fromEntries(contracts.map((address) => [address, bytes32("b")])),
    restrictedTransfers: true,
    nonUpgradeable: true,
  }
}
export const DIGEST = digest(manifest())
export const ORDER_ID = "order-1"

/** Order row as JSON-serialized by the Stocks plugin: BUY rows carry no side, SELL GET rows add side "SELL". */
export function orderRow(side: Side, overrides: Record<string, unknown> = {}) {
  const m = manifest()
  return {
    id: ORDER_ID,
    orderKey: sha256(toHex(`${side === "SELL" ? "sell:" : ""}${m.networkInstance}:${ORDER_ID}`)),
    quoteId: "quote-1",
    actorId: `evm:${WALLET}`,
    wallet: WALLET,
    symbol: "NVDA",
    quantity: "1000000000",
    cashAmount: "120000000",
    idempotencyKey: "request-order-1",
    deploymentId: m.deploymentId,
    deploymentDigest: DIGEST,
    quoteExpiresAt: new Date(START + 600_000).toISOString(),
    state: side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW",
    version: 0,
    createdAt: new Date(START - 5_000).toISOString(),
    updatedAt: new Date(START - 5_000).toISOString(),
    ...(side === "SELL" ? { side: "SELL" } : {}),
    ...overrides,
  }
}

export function envelope(data: unknown, observedAt = START) {
  return { ...PROFILE, observedAt: new Date(observedAt).toISOString(), data }
}

export function evidence(overrides: Record<string, unknown> = {}) {
  return { status: "VERIFIED", evidenceId: "evidence-1", manifestDigest: DIGEST, manifest: manifest(), verifiedAt: START - 1_000, validUntil: START + 14_000, ...overrides }
}

export function policy(side: Side, overrides: Record<string, unknown> = {}) {
  return { allowed: true, deploymentDigest: DIGEST, orderId: ORDER_ID, side, observedAt: START - 500, validUntil: START + 14_500, ...overrides }
}

export function catalog(observedAt = START) {
  return {
    ...PROFILE,
    instruments: [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER" }],
    cashSymbol: "ARCO_TEST_USDC",
    deploymentId: manifest().deploymentId,
    observedAt: new Date(observedAt).toISOString(),
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })
}

/** Manual wall and monotonic clocks, moved together unless a test moves one alone. */
export function clocks(start = START) {
  let wall = start
  let monotonic = 50_000
  return {
    now: () => wall,
    monotonicNow: () => monotonic,
    advance(ms: number) {
      wall += ms
      monotonic += ms
    },
    setWall(value: number) {
      wall = value
    },
    advanceMonotonic(ms: number) {
      monotonic += ms
    },
    setMonotonic(value: number) {
      monotonic = value
    },
  }
}

export type Call = { url: string; init: RequestInit }

/** Records every request; `respond` decides the answer per call. */
export function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return respond(call, calls.length - 1)
  }
  return { fetch, calls }
}

export function read(side: Side = "BUY", overrides: Partial<AuthenticatedRead> = {}): AuthenticatedRead {
  return { apiBase: API, token: TOKEN, sessionId: "session-a", side, orderId: ORDER_ID, deploymentDigest: DIGEST, signal: new AbortController().signal, ...overrides }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let j = 0; j < 20; j++) await Promise.resolve()
  }
}
