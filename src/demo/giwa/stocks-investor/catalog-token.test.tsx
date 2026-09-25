import assert from "node:assert/strict"
import test from "node:test"
import { parseCatalog, parseDirectStatus, parseStocksActivity, StocksResponseError } from "./validate"

const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }
const NVDA = { symbol: "NVDA", quantityScale: 9, price: "223.710000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER" }
const catalog = (instrument: Record<string, unknown>) => ({ ...PROFILE, instruments: [instrument], cashSymbol: "tUSDC", deploymentId: "giwa-stocks-a", observedAt: "2026-09-25T00:00:00.000Z" })
const TOKEN = `0x${"ab".repeat(20)}`

test("the published NVDA token address is kept; a catalog without it parses exactly as before", () => {
  assert.deepEqual(parseCatalog(catalog({ ...NVDA, tokenAddress: TOKEN })).instruments, [{ ...NVDA, tokenAddress: TOKEN }])
  assert.deepEqual(parseCatalog(catalog(NVDA)).instruments, [NVDA])
  assert.equal("tokenAddress" in parseCatalog(catalog(NVDA)).instruments[0]!, false)
})

test("a token address that is not a lower-case 20-byte hex string is refused", () => {
  for (const tokenAddress of [`0x${"AB".repeat(20)}`, "0x1234", 1234, null, `${TOKEN}00`]) {
    assert.throws(() => parseCatalog(catalog({ ...NVDA, tokenAddress })), (error: unknown) => error instanceof StocksResponseError && error.path === "catalog.instruments[0].tokenAddress")
  }
})

const CONTRACTS = { cashToken: `0x${"11".repeat(20)}`, fundingVault: `0x${"22".repeat(20)}`, stockToken: TOKEN, redemptionEscrow: `0x${"44".repeat(20)}` }

test("the deployment's contracts are kept when published: four distinct lower-case addresses, NVDA's token among them", () => {
  const parsed = parseCatalog({ ...catalog({ ...NVDA, tokenAddress: TOKEN }), contracts: CONTRACTS })
  assert.deepEqual(parsed.contracts, CONTRACTS)
  assert.equal("contracts" in parseCatalog(catalog(NVDA)), false, "older servers publish none")
  const refused: [string, unknown, string][] = [
    ["not an object", "0x11", "catalog.contracts"],
    ["missing key", { cashToken: CONTRACTS.cashToken, fundingVault: CONTRACTS.fundingVault, stockToken: TOKEN }, "catalog.contracts"],
    ["extra key", { ...CONTRACTS, mintController: `0x${"55".repeat(20)}` }, "catalog.contracts"],
    ["upper-case", { ...CONTRACTS, fundingVault: `0x${"AA".repeat(20)}` }, "catalog.contracts.fundingVault"],
    ["overlapping", { ...CONTRACTS, redemptionEscrow: CONTRACTS.fundingVault }, "catalog.contracts"],
    ["another stock token", { ...CONTRACTS, stockToken: `0x${"66".repeat(20)}` }, "catalog.contracts.stockToken"],
  ]
  for (const [label, contracts, path] of refused) {
    assert.throws(() => parseCatalog({ ...catalog({ ...NVDA, tokenAddress: TOKEN }), contracts }), (error: unknown) => error instanceof StocksResponseError && error.path === path, label)
  }
})

test("a direct order's status: the side it was sent with, a known state, integer amounts and an optional hold", () => {
  const row = { side: "BUY", state: "BROKER_PENDING", quantity: "500000000", cashAmount: "60000000", createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:01.000Z" }
  assert.deepEqual(parseDirectStatus(row, "BUY"), { side: "BUY", state: "BROKER_PENDING", quantity: "500000000", cashAmount: "60000000", hold: null })
  assert.deepEqual(parseDirectStatus({ ...row, side: "SELL", state: "ESCROW_REVIEW_REQUIRED", hold: "TRADING_PAUSED" }, "SELL"), { side: "SELL", state: "ESCROW_REVIEW_REQUIRED", quantity: "500000000", cashAmount: "60000000", hold: "TRADING_PAUSED" })
  const refused: [string, Record<string, unknown>, "BUY" | "SELL"][] = [
    ["other side", row, "SELL"],
    ["sell state on a buy", { ...row, state: "ESCROW_HELD" }, "BUY"],
    ["decimal amount", { ...row, quantity: "0.5" }, "BUY"],
    ["unknown hold", { ...row, hold: "LATER" }, "BUY"],
    ["no timestamps", { ...row, createdAt: undefined }, "BUY"],
  ]
  for (const [label, value, side] of refused) assert.throws(() => parseDirectStatus(value, side), StocksResponseError, label)
})

test("a wallet's Stocks activity: known sides and states, integer amounts, transaction hashes and times", () => {
  const row = { side: "SELL", state: "COMPLETED", quantity: "100000000", cashAmount: "12000000", paymentTx: `0x${"ab".repeat(32)}`, settlementTx: `0x${"cd".repeat(32)}`, createdAt: "2026-09-26T00:00:00.000Z" }
  assert.deepEqual(parseStocksActivity([row, { ...row, side: "BUY", state: "FUNDING_REVIEW_REQUIRED", settlementTx: null }]).map((entry) => [entry.side, entry.state, entry.settlementTx]), [["SELL", "COMPLETED", row.settlementTx], ["BUY", "FUNDING_REVIEW_REQUIRED", null]])
  const refused: [string, unknown][] = [
    ["not a list", { data: [] }],
    ["unknown side", [{ ...row, side: "SWAP" }]],
    ["buy state on a sell", [{ ...row, state: "MINT_SUBMITTED" }]],
    ["upper-case hash", [{ ...row, paymentTx: `0x${"AB".repeat(32)}` }]],
    ["decimal amount", [{ ...row, quantity: "0.1" }]],
    ["no time", [{ ...row, createdAt: "yesterday" }]],
    ["too many", Array.from({ length: 201 }, () => row)],
  ]
  for (const [label, value] of refused) assert.throws(() => parseStocksActivity(value), StocksResponseError, label)
})
