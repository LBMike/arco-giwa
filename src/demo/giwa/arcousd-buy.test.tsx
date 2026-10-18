import assert from "node:assert/strict"
import test from "node:test"
import { decodeFunctionData, getAddress, parseAbi, toFunctionSelector } from "viem"
import {
  amountAfterSwapFee,
  fundBuyRoute,
  payAssetLabel,
  RESERVE_REFILL_NOTICE,
  routerBuyQuote,
  selectedPayAsset,
  swapFeeText,
} from "./arcousd-buy"
import { encodedRouterBuy } from "./contracts"
import type { GiwaArcoUSDReserve, GiwaCatalogItem } from "./types"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const USDC = A(0xc1)
const USDT = A(0xc2)
const RLUSD = A(0xc3)
const ARCO = A(0xa0)
const ROUTER = A(0xde)

const fund = { productId: "umint", vaultConfig: null, paymentAssetAddress: USDC } as unknown as GiwaCatalogItem
const savingsVault = { productId: "umint", vaultConfig: { kind: "saving" }, paymentAssetAddress: USDC } as unknown as GiwaCatalogItem

const asset = (symbol: string, address: string, decimals: number, swapFeeBps: number, depositEnabled = true) => ({
  symbol,
  address: address.toLowerCase(),
  decimals,
  depositEnabled,
  redeemEnabled: true,
  instantFeeBps: 0,
  swapFeeBps,
  balance: "0",
  queued: "0",
  available: "0",
  balanceHuman: "0",
  queuedHuman: "0",
  availableHuman: "0",
  queueLength: 0,
  queueHead: 0,
  queueBacklog: 0,
})

function reserve(overrides: { gate?: "open" | "closed" | "inactive"; router?: string | null; products?: string[]; assets?: unknown[] | null } = {}): GiwaArcoUSDReserve {
  return {
    status: "live",
    chainId: 91342,
    contracts: {
      arcoUSD: ARCO.toLowerCase(),
      reserve: A(0xbb),
      lens: A(0xcc),
      router: overrides.router === undefined ? ROUTER.toLowerCase() : overrides.router,
      routerProducts: overrides.products ?? ["umint", "ibenji"],
    },
    readAt: "2026-10-19T00:00:00.000Z",
    reserve:
      overrides.assets === null
        ? null
        : ({
            assets: overrides.assets ?? [asset("tUSDT", USDT, 6, 10), asset("tUSDC", USDC, 6, 0), asset("tRLUSD", RLUSD, 18, 10), asset("tDAI", A(0xd1), 18, 10, false)],
          } as GiwaArcoUSDReserve["reserve"]),
    gate: { status: overrides.gate ?? "open", reason: null, asset: "tUSDC", available: "5000", threshold: "1000", checkedAt: "" },
  }
}

test("only a Router fund buys through the Router; everything else keeps the direct vault deposit", () => {
  assert.equal(fundBuyRoute(fund, undefined).kind, "direct") // reserve not read (yet)
  assert.equal(fundBuyRoute(savingsVault, reserve()).kind, "direct") // Savings: never gated or routed
  assert.equal(fundBuyRoute(fund, reserve({ router: null })).kind, "direct") // no Router deployed
  assert.equal(fundBuyRoute(fund, reserve({ products: ["ibenji"] })).kind, "direct") // not a Router product
  assert.equal(fundBuyRoute(fund, { ...reserve(), status: "not-deployed", contracts: null }).kind, "direct")

  const route = fundBuyRoute(fund, reserve())
  assert.equal(route.kind, "router")
  if (route.kind !== "router") return
  assert.equal(route.router, getAddress(ROUTER))
  assert.equal(route.gateClosed, false)
  // The fund's own payment asset first, then the Reserve's order; disabled deposits left out; ArcoUSD last.
  assert.deepEqual(route.payAssets.map((option) => option.label), ["USDC", "USDT", "RLUSD", "ArcoUSD"])
  assert.deepEqual(route.payAssets.map((option) => option.swapFeeBps), [0, 10, 10, 0])
  assert.equal(route.payAssets[3].isArcoUSD, true)
  assert.equal(route.payAssets[0].address, getAddress(USDC)) // checksummed
})

test("the gate closes a Router fund on a closed gate, and fails closed when the reserve could not be read", () => {
  const closed = fundBuyRoute(fund, reserve({ gate: "closed" }))
  assert.ok(closed.kind === "router" && closed.gateClosed)
  const unread = fundBuyRoute(fund, { ...reserve({ assets: null, gate: "closed" }), status: "unavailable" })
  assert.ok(unread.kind === "router" && unread.gateClosed && unread.payAssets.length === 0)
  assert.equal(RESERVE_REFILL_NOTICE, "Purchases are temporarily paused while the reserve refills.")
})

test("selection falls back to the fund's own asset; labels and fee text", () => {
  const route = fundBuyRoute(fund, reserve())
  assert.equal(selectedPayAsset(route, null)?.label, "USDC")
  assert.equal(selectedPayAsset(route, RLUSD.toLowerCase())?.label, "RLUSD")
  assert.equal(selectedPayAsset(route, "0xnope")?.label, "USDC")
  assert.equal(selectedPayAsset({ kind: "direct" }, null), null)
  assert.deepEqual(["tUSDC", "tUSDT", "tRLUSD", "ArcoUSD"].map(payAssetLabel), ["USDC", "USDT", "RLUSD", "ArcoUSD"])
  assert.deepEqual([swapFeeText(10), swapFeeText(0), swapFeeText(25)], ["0.1%", "No fee", "0.25%"])
  assert.equal(amountAfterSwapFee(1000, 10), 999)
})

test("the quote mirrors the Router: fee in base18, payment token rounded down", () => {
  // 1,000 USDT (6 dec), 10 bps → 999 ArcoUSD → 999 USDC; fee 1 USDT.
  assert.deepEqual(routerBuyQuote(1_000_000_000n, { decimals: 6, swapFeeBps: 10, isArcoUSD: false }, 6), {
    arcoUSDIn: 999n * 10n ** 18n,
    feeInPayAsset: 1_000_000n,
    paymentAmount: 999_000_000n,
  })
  // 100.0000005 RLUSD (18 dec): 99.9000004995 ArcoUSD → 99.900000 USDC (dust stays with the payer).
  const rl = routerBuyQuote(100n * 10n ** 18n + 500_000_000_000n, { decimals: 18, swapFeeBps: 10, isArcoUSD: false }, 6)
  assert.equal(rl.paymentAmount, 99_900_000n)
  // ArcoUSD pays no fee.
  assert.equal(routerBuyQuote(5n * 10n ** 18n, { decimals: 18, swapFeeBps: 10, isArcoUSD: true }, 6).paymentAmount, 5_000_000n)
  assert.equal(routerBuyQuote(0n, { decimals: 6, swapFeeBps: 10, isArcoUSD: false }, 6).paymentAmount, 0n)
})

test("the Router buy call encodes buy(payAsset, amount, vault, 0, buyer, request)", () => {
  const data = encodedRouterBuy({ payAsset: USDT, amount: 5n, depositVault: A(0x71), recipient: A(0xb0), request: true })
  assert.equal(data.slice(0, 10), toFunctionSelector("buy(address,uint256,address,uint256,address,bool)"))
  const abi = parseAbi(["function buy(address payAsset, uint256 payAmount, address depositVault, uint256 minSharesOut, address recipient, bool request)"])
  const decoded = decodeFunctionData({ abi, data })
  assert.deepEqual(decoded.args, [getAddress(USDT), 5n, getAddress(A(0x71)), 0n, getAddress(A(0xb0)), true])
})
