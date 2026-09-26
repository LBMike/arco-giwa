import assert from "node:assert/strict"
import test from "node:test"
import { getAddress } from "viem"

import type { StocksCatalog, StocksDirectStatus } from "../stocks-investor/types"
import { PLATFORM_TUSDC } from "../stocks-wallet/types"
import {
  clearDirectTrade, directCall, directContracts, directSendBlock, directTradeOf, DirectTradeError, isDirectOrderKey, newDirectOrderKey, readDirectStatus, readTradingAvailability,
  resetDirectTradesForTests, resumeDirectTrade, settledPhase, startDirectTrade, subscribeDirectTrades,
  type DirectPolling, type DirectTradeInput, type DirectTradePorts, type DirectTradeState, type TxHash,
} from "."

const OWNER = "0x3185f0efb95228c9e476de5c9da1d1aa8ccf76d2" as const
const CONTRACTS = { cashToken: PLATFORM_TUSDC, fundingVault: `0x${"a1".repeat(20)}`, stockToken: `0x${"b2".repeat(20)}`, redemptionEscrow: `0x${"c3".repeat(20)}` } as const
const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" } as const
const KEY = `0x4152434f44524354${"0f".repeat(24)}` as const
const HASH = `0x${"77".repeat(32)}` as TxHash
const FAST: DirectPolling = { receiptMs: 0, receiptPolls: 3, statusMs: 0, statusPolls: 4 }

const catalog = (patch: Partial<StocksCatalog> = {}): StocksCatalog => ({
  ...PROFILE, instruments: [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER", tokenAddress: CONTRACTS.stockToken }],
  cashSymbol: "tUSDC", deploymentId: "giwa-stocks-a", observedAt: "2026-09-25T00:00:00.000Z", contracts: { ...CONTRACTS }, ...patch,
})
const status = (patch: Partial<StocksDirectStatus> = {}) => ({ side: "BUY", state: "BROKER_PENDING", quantity: "500000000", cashAmount: "60000000", hold: null, ...patch }) as StocksDirectStatus
const input = (patch: Partial<DirectTradeInput> = {}): DirectTradeInput => ({ side: "BUY", owner: OWNER, contracts: CONTRACTS, amount: "60000000", estimate: "500000000", ...patch })

test("a direct order key is the ARCODRCT prefix and 24 random bytes, in lower-case hex", () => {
  const key = newDirectOrderKey((bytes) => bytes.fill(0xab))
  assert.equal(key, `0x4152434f44524354${"ab".repeat(24)}`)
  assert.equal(isDirectOrderKey(key), true)
  assert.equal(isDirectOrderKey(newDirectOrderKey()), true)
  assert.notEqual(newDirectOrderKey(), newDirectOrderKey())
  assert.throws(() => newDirectOrderKey(() => new Uint8Array(8)), /DIRECT_KEY_RANDOM_UNAVAILABLE/)
  for (const value of [`0x4152434F44524354${"ab".repeat(24)}`, `0x${"ab".repeat(32)}`, `${KEY}00`, KEY.slice(0, -2), null]) assert.equal(isDirectOrderKey(value), false)
})

test("only a tUSDC catalog publishing the platform tUSDC, its own NVDA token and four distinct contracts trades directly", () => {
  assert.deepEqual(directContracts(catalog()), CONTRACTS)
  assert.ok(Object.isFrozen(directContracts(catalog())))
  assert.equal(directContracts(null), null)
  assert.equal(directContracts(catalog({ contracts: undefined })), null, "an older server")
  assert.equal(directContracts(catalog({ cashSymbol: "ARCO_TEST_USDC" })), null)
  assert.equal(directContracts(catalog({ contracts: { ...CONTRACTS, cashToken: `0x${"99".repeat(20)}` } })), null, "not the platform tUSDC")
  assert.equal(directContracts(catalog({ contracts: { ...CONTRACTS, redemptionEscrow: CONTRACTS.fundingVault } })), null)
  const other = catalog()
  other.instruments = [{ ...other.instruments[0]!, tokenAddress: `0x${"dd".repeat(20)}` }]
  assert.equal(directContracts(other), null, "NVDA's published token is not the stock token")
})

test("the one wallet call: a Buy deposits the tUSDC to the funding vault, a Sell escrows the NVDA to the redemption escrow", () => {
  const buy = directCall(input(), KEY)
  assert.equal(buy.account, getAddress(OWNER))
  assert.equal(buy.address, getAddress(CONTRACTS.fundingVault))
  assert.equal(buy.functionName, "depositForOrder")
  assert.deepEqual(buy.args, [KEY, 60000000n])
  const sell = directCall(input({ side: "SELL", amount: "250000000" }), KEY)
  assert.equal(sell.address, getAddress(CONTRACTS.redemptionEscrow))
  assert.equal(sell.functionName, "escrowForOrder")
  assert.deepEqual(sell.args, [KEY, getAddress(CONTRACTS.stockToken), 250000000n])
})

test("the status read is public: no credentials, 404 DIRECT_ORDER_NOT_FOUND is 'not seen yet', anything else is an error", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const answer = (code: number, body: unknown) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status: code }) }
  const row = { side: "BUY", state: "COMPLETED", quantity: "500000000", cashAmount: "60000000", createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:03.000Z" }
  const done = await readDirectStatus({ apiBase: "http://127.0.0.1:4392/", key: KEY, side: "BUY", fetch: answer(200, { ...PROFILE, observedAt: "2026-09-25T00:00:04.000Z", data: row }) })
  assert.deepEqual(done, { side: "BUY", state: "COMPLETED", quantity: "500000000", cashAmount: "60000000", hold: null })
  assert.equal(calls[0]!.url, `http://127.0.0.1:4392/api/v1/stocks/direct/${KEY}`)
  assert.equal(calls[0]!.init.credentials, "omit")
  assert.equal(calls[0]!.init.redirect, "error")
  assert.deepEqual(calls[0]!.init.headers, { accept: "application/json" })
  assert.equal(await readDirectStatus({ apiBase: "http://127.0.0.1:4392", key: KEY, side: "BUY", fetch: answer(404, { ...PROFILE, error: "DIRECT_ORDER_NOT_FOUND" }) }), null)
  await assert.rejects(readDirectStatus({ apiBase: "http://127.0.0.1:4392", key: KEY, side: "BUY", fetch: answer(404, { statusCode: 404, error: "Not Found", message: "Route not found" }) }), /DIRECT_STATUS_HTTP_404/)
  await assert.rejects(readDirectStatus({ apiBase: "http://127.0.0.1:4392", key: KEY, side: "SELL", fetch: answer(200, { ...PROFILE, observedAt: "2026-09-25T00:00:04.000Z", data: row }) }), /INVALID_RESPONSE/, "another side's row")
  await assert.rejects(readDirectStatus({ apiBase: "http://127.0.0.1:4392", key: "0x1234" as `0x${string}`, side: "BUY", fetch: answer(200, {}) }), /DIRECT_STATUS_INVALID_KEY/)
  await assert.rejects(readDirectStatus({ apiBase: "http://127.0.0.1:4392/?x", key: KEY, side: "BUY", fetch: answer(200, {}) }), /DIRECT_STATUS_INVALID_BASE/)
})

test("a server status is done, held or still settling", () => {
  assert.equal(settledPhase(status({ state: "COMPLETED" })), "DONE")
  assert.equal(settledPhase(status({ state: "FUNDING_REVIEW_REQUIRED", hold: "TRADING_PAUSED" })), "HELD")
  assert.equal(settledPhase(status({ state: "REFUNDED" })), "HELD")
  assert.equal(settledPhase(status({ state: "MINT_SUBMITTED" })), "SETTLING")
  assert.equal(settledPhase(status({ side: "SELL", state: "LIQUIDITY_PENDING" })), "SETTLING")
  assert.equal(settledPhase(status({ side: "SELL", state: "ESCROW_REVIEW_REQUIRED" })), "HELD")
  assert.equal(settledPhase(status({ side: "SELL", state: "RETURNED" })), "HELD")
})

// ── the runner ──

type Script = { send?: () => Promise<TxHash>; receipts?: ("success" | "reverted" | null | Error)[]; statuses?: (StocksDirectStatus | null | Error)[] }
function ports(script: Script) {
  const log: string[] = []
  const receipts = [...(script.receipts ?? ["success"])]
  const statuses = [...(script.statuses ?? [status({ state: "COMPLETED" })])]
  const next = <T,>(queue: T[]) => (queue.length > 1 ? queue.shift()! : queue[0]!)
  const value: DirectTradePorts = {
    async send(trade, key) { log.push(`send:${trade.side}:${key}`); return script.send ? script.send() : HASH },
    async receipt() { log.push("receipt"); const r = next(receipts); if (r instanceof Error) throw r; return r },
    async status(_key, side) { log.push(`status:${side}`); const s = next(statuses); if (s instanceof Error) throw s; return s },
    async sleep() {},
    newKey: () => KEY,
  }
  return { value, log }
}
async function settle(owner: string = OWNER): Promise<DirectTradeState> {
  for (let i = 0; i < 200; i++) {
    const phase = directTradeOf(owner)?.state.phase
    if (phase !== undefined && phase !== "WALLET" && phase !== "CONFIRMING" && phase !== "SETTLING") return directTradeOf(owner)!.state
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error("trade did not settle")
}
function phases(): { seen: string[]; stop: () => void } {
  const seen: string[] = []
  const stop = subscribeDirectTrades(() => { const phase = directTradeOf(OWNER)?.state.phase; if (phase && seen[seen.length - 1] !== phase) seen.push(phase) })
  return { seen, stop }
}

test("a Buy: the wallet sends once, GIWA confirms, then the server's status is followed until it completes", async () => {
  resetDirectTradesForTests()
  const { value, log } = ports({ receipts: [null, "success"], statuses: [null, new Error("offline"), status({ state: "MINT_SUBMITTED" }), status({ state: "COMPLETED", quantity: "498000000" })] })
  const watch = phases()
  const trade = startDirectTrade(input(), value, FAST)
  assert.ok(trade)
  assert.equal(trade.key, KEY)
  assert.equal(startDirectTrade(input(), value, FAST), null, "one trade at a time per wallet")
  const end = await settle()
  watch.stop()
  assert.deepEqual(end, { phase: "DONE", hash: HASH, status: status({ state: "COMPLETED", quantity: "498000000" }) })
  assert.deepEqual(watch.seen, ["WALLET", "CONFIRMING", "SETTLING", "DONE"])
  assert.equal(log.filter((entry) => entry.startsWith("send")).length, 1, "sent exactly once")
  assert.deepEqual(log.slice(0, 3), [`send:BUY:${KEY}`, "receipt", "receipt"])
})

test("nothing moved: a declined or already open wallet request, a trade GIWA would not accept, or a reverted transaction", async () => {
  const cases: [Script, string][] = [
    [{ send: async () => { throw Object.assign(new Error("user rejected"), { code: 4001 }) } }, "WALLET_REQUEST_REJECTED"],
    [{ send: async () => { throw { cause: { code: -32002 } } } }, "WALLET_REQUEST_PENDING"],
    [{ send: async () => { throw new DirectTradeError("NOT_ACCEPTED") } }, "NOT_ACCEPTED"],
    [{ send: async () => { throw new Error("locked") } }, "SEND_FAILED"],
    [{ receipts: ["reverted"] }, "REVERTED"],
  ]
  for (const [script, code] of cases) {
    resetDirectTradesForTests()
    const { value, log } = ports(script)
    startDirectTrade(input(), value, FAST)
    assert.deepEqual(await settle(), { phase: "FAILED", code }, code)
    assert.equal(log.some((entry) => entry.startsWith("status")), false, `${code}: the server is not asked`)
    // A failed trade can be cleared, and a new one started.
    clearDirectTrade(OWNER)
    assert.equal(directTradeOf(OWNER), null)
  }
})

test("a held payment is shown as held; a slow receipt or settlement stops asking and 'Check again' follows the same transaction", async () => {
  resetDirectTradesForTests()
  const held = ports({ statuses: [status({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", hold: "TRADING_PAUSED" })] })
  startDirectTrade(input(), held.value, FAST)
  assert.deepEqual(await settle(), { phase: "HELD", hash: HASH, status: status({ state: "FUNDING_REVIEW_REQUIRED", quantity: "0", hold: "TRADING_PAUSED" }) })

  resetDirectTradesForTests()
  const slow = ports({ receipts: [null, null, null, null, "success"], statuses: [status({ side: "SELL", state: "COMPLETED", cashAmount: "30000000" })] })
  startDirectTrade(input({ side: "SELL", amount: "250000000" }), slow.value, FAST)
  assert.deepEqual(await settle(), { phase: "SLOW", hash: HASH, status: null, stage: "RECEIPT" })
  resumeDirectTrade(OWNER, slow.value, FAST)
  assert.deepEqual(await settle(), { phase: "DONE", hash: HASH, status: status({ side: "SELL", state: "COMPLETED", cashAmount: "30000000" }) })
  assert.equal(slow.log.filter((entry) => entry.startsWith("send")).length, 1, "'Check again' sends nothing")

  resetDirectTradesForTests()
  const settling = ports({ statuses: [status({ state: "BROKER_PENDING" }), status({ state: "BROKER_PENDING" }), status({ state: "BROKER_PENDING" }), status({ state: "BROKER_PENDING" }), status({ state: "COMPLETED" })] })
  startDirectTrade(input(), settling.value, FAST)
  assert.deepEqual(await settle(), { phase: "SLOW", hash: HASH, status: status({ state: "BROKER_PENDING" }), stage: "SETTLEMENT" })
  resumeDirectTrade(OWNER, settling.value, FAST)
  assert.equal((await settle()).phase, "DONE")
})

test("trades are kept per wallet: another wallet's trade is not shown or replaced, and an active one is never cleared", async () => {
  resetDirectTradesForTests()
  const other = "0x2222222222222222222222222222222222222222" as const
  let release: (hash: TxHash) => void = () => undefined
  const pending = ports({ send: () => new Promise<TxHash>((resolve) => { release = resolve }) })
  startDirectTrade(input(), pending.value, FAST)
  assert.equal(directTradeOf(other), null)
  assert.equal(directTradeOf(OWNER.toUpperCase().replace("0X", "0x"))?.state.phase, "WALLET", "the wallet address is matched case-insensitively")
  clearDirectTrade(OWNER)
  assert.equal(directTradeOf(OWNER)?.state.phase, "WALLET", "an active trade is not cleared")
  const second = ports({})
  assert.ok(startDirectTrade(input({ owner: other }), second.value, FAST))
  release(HASH)
  assert.equal((await settle()).phase, "DONE")
  assert.equal((await settle(other)).phase, "DONE")
})

// ── asking the server before the wallet (trading limits) ──

test("before the wallet is asked: the availability read is public, and only a server 'no' stops the send", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const reply = (code: number, body: unknown) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code }) }
  const answer = (side: string, block: string | null) => ({ ...PROFILE, observedAt: "2026-09-25T00:00:04.000Z", data: { symbol: "NVDA", side, accepts: block === null, block } })
  const api = "http://127.0.0.1:4392/"
  assert.deepEqual(await readTradingAvailability({ apiBase: api, side: "BUY", cashAmount: "60000000", fetch: reply(200, answer("BUY", null)) }), { side: "BUY", accepts: true, block: null })
  assert.equal(calls[0]!.url, "http://127.0.0.1:4392/api/v1/stocks/availability?side=BUY&cashAmount=60000000")
  assert.equal(calls[0]!.init.credentials, "omit")
  assert.equal(calls[0]!.init.redirect, "error")
  assert.deepEqual(calls[0]!.init.headers, { accept: "application/json" })
  // A Buy is checked for what it pays, a Sell for the payout the page expects; without an estimate the smallest amount.
  for (const block of ["SIDE_DISABLED", "DAILY_LIMIT_REACHED", "TRADING_PAUSED"]) {
    assert.equal(await directSendBlock({ apiBase: api, input: input(), fetch: reply(200, answer("BUY", block)) }), block)
  }
  assert.equal(await directSendBlock({ apiBase: api, input: input({ side: "SELL", amount: "250000000", estimate: "29990000" }), fetch: reply(200, answer("SELL", "SIDE_DISABLED")) }), "SIDE_DISABLED")
  assert.equal(calls[calls.length - 1]!.url, "http://127.0.0.1:4392/api/v1/stocks/availability?side=SELL&cashAmount=29990000")
  await directSendBlock({ apiBase: api, input: input({ side: "SELL", amount: "250000000", estimate: null }), fetch: reply(200, answer("SELL", null)) })
  assert.equal(calls[calls.length - 1]!.url, "http://127.0.0.1:4392/api/v1/stocks/availability?side=SELL")
  // No usable answer never blocks: an older server without the route, a failure, an unreadable or mismatched answer.
  for (const [name, fetch] of [
    ["older server", reply(404, { statusCode: 404, error: "Not Found", message: "Route GET:/api/v1/stocks/availability not found" })],
    ["server error", reply(500, { ...PROFILE, error: "INTERNAL_ERROR" })],
    ["not json", reply(200, "<html>")],
    ["another side", reply(200, answer("SELL", "SIDE_DISABLED"))],
    ["unknown block", reply(200, answer("BUY", "SOMETHING_ELSE"))],
    ["accepts with a block", reply(200, { ...answer("BUY", null), data: { symbol: "NVDA", side: "BUY", accepts: true, block: "SIDE_DISABLED" } })],
    ["extra field", reply(200, { ...answer("BUY", "SIDE_DISABLED"), data: { ...answer("BUY", "SIDE_DISABLED").data, remaining: "5" } })],
    ["wrong profile", reply(200, { ...answer("BUY", "SIDE_DISABLED"), chainId: 1 })],
    ["offline", async () => { throw new TypeError("offline") }],
  ] as const) assert.equal(await directSendBlock({ apiBase: api, input: input(), fetch }), null, name)
  assert.equal(await directSendBlock({ apiBase: "not a url", input: input(), fetch: reply(200, answer("BUY", "SIDE_DISABLED")) }), null)
})

test("parity: the real availability route's answer is what the pre-check reads", async () => {
  const { default: Fastify } = await import("fastify")
  const { stocksPlugin } = await import("../../../../server/src/stocks/plugin")
  const { StocksService } = await import("../../../../server/src/stocks/service")
  const cases: Array<{ paused: boolean; limit: string | null; side: "BUY" | "SELL"; expected: string | null }> = [
    { paused: false, limit: null, side: "BUY", expected: null },
    { paused: false, limit: "SIDE_DISABLED", side: "SELL", expected: "SIDE_DISABLED" },
    { paused: false, limit: "DAILY_LIMIT_REACHED", side: "BUY", expected: "DAILY_LIMIT_REACHED" },
    { paused: true, limit: null, side: "BUY", expected: "TRADING_PAUSED" },
  ]
  for (const item of cases) {
    const seen: unknown[] = []
    const service = Object.assign(Object.create(StocksService.prototype), {
      directHalted: async () => item.paused,
      limits: { check: async (...args: unknown[]) => { seen.push(args); return item.limit }, admit: async () => null },
    })
    const app = Fastify({ logger: false })
    await app.register(stocksPlugin, { service })
    await app.ready()
    const fetch = async (url: string) => {
      const target = new URL(url)
      const response = await app.inject({ method: "GET", url: `${target.pathname}${target.search}` })
      return new Response(response.body, { status: response.statusCode })
    }
    const trade = item.side === "BUY" ? input() : input({ side: "SELL", amount: "250000000", estimate: "29990000" })
    assert.equal(await directSendBlock({ apiBase: "http://127.0.0.1:4392", input: trade, fetch }), item.expected, JSON.stringify(item))
    if (!item.paused) assert.deepEqual(seen, [["NVDA", item.side, item.side === "BUY" ? 60000000n : 29990000n]])
    await app.close()
  }
})

test("a status held by the trading limits is read as held", async () => {
  const row = { side: "BUY", state: "FUNDING_REVIEW_REQUIRED", quantity: "0", cashAmount: "60000000", createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z" }
  for (const hold of ["SIDE_DISABLED", "DAILY_LIMIT_REACHED"] as const) {
    const fetch = async () => new Response(JSON.stringify({ ...PROFILE, observedAt: "2026-09-25T00:00:04.000Z", data: { ...row, hold } }), { status: 200 })
    const read = await readDirectStatus({ apiBase: "http://127.0.0.1:4392", key: KEY, side: "BUY", fetch })
    assert.equal(read?.hold, hold)
    assert.equal(settledPhase(read!), "HELD")
  }
})
