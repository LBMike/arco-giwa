import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem"
import { convertProduct, converterFor, CONVERT_OPTIONS } from "./arcousd-convert"
import {
  arcoUsdLive,
  LIVE_SAVINGS_PRODUCT_ID,
  liveConvert,
  liveSavingsHistory,
  liveSavingsMarket,
  liveSavingsOwnLiquidity,
  liveSavingsRoutes,
  liveSavingsVault,
  reserveTransport,
  withdrawalApproval,
  zapTransport,
  type ArcoUsdLive,
} from "./arcousd-live"
import { tokenSymbolFor, vaultImageFor } from "./catalog"
import { arcoUSDOperationCall } from "./contracts"
import { GetArcoUsdButton } from "./GetArcoUsd"
import { productThroughRoute, SAVINGS_ASSET_OPTIONS } from "./savings-assets"
import { ArcoUsdConvertContext } from "./savings-routes"
import type { GiwaArcoUSDAssetState, GiwaArcoUSDReserve, GiwaArcoUSDSavings, GiwaArcoUSDSavingsHistory, GiwaCatalogItem, HexAddress } from "./types"

// Checksummed addresses (viem returns these from getAddress).
const ARCOUSD = "0x3d6Cb251d6aA62591ce9f6a13781a6dC590411Da" as HexAddress
const RESERVE = "0x4942711396B53df5b02fD8065E77FA2c9D27512F" as HexAddress
const SARCOUSD = "0xcAEF04FeA7f9c2561dbCA95E39a6b06043df30Fd" as HexAddress
const ZAP = "0xf4554ea97218645cF2EB209Cd540BD91321ba1E1" as HexAddress
const TUSDC = "0x869d9c8d9BF0A961FC2FD3bBa300fDBEeE3C2633" as HexAddress
const TUSDT = "0x146c6CEE0b8c98bcA46A563D2845b45a7546f2c8" as HexAddress
const TRLUSD = "0x572D4d62b0dac353480CBbE28AAFDb4f4F437325" as HexAddress
const ACCOUNT = "0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2" as HexAddress

function asset(symbol: string, address: string, decimals: number, patch: Partial<GiwaArcoUSDAssetState> = {}): GiwaArcoUSDAssetState {
  return {
    symbol,
    address: address.toLowerCase(),
    decimals,
    depositEnabled: true,
    redeemEnabled: true,
    instantFeeBps: 0,
    swapFeeBps: 0,
    balance: "0",
    queued: "0",
    available: "0",
    balanceHuman: "0",
    queuedHuman: "0",
    availableHuman: "0",
    queueLength: 0,
    queueHead: 0,
    queueBacklog: 0,
    ...patch,
  }
}

function reserveRead(patch: Partial<NonNullable<GiwaArcoUSDReserve["reserve"]>> = {}): GiwaArcoUSDReserve {
  return {
    status: "live",
    chainId: 91342,
    contracts: { arcoUSD: ARCOUSD.toLowerCase(), reserve: RESERVE.toLowerCase(), lens: "0x70cb2944c2da5f199082a797f045ca2fded08866", router: null, routerProducts: [] },
    readAt: "2026-10-21T00:00:00.000Z",
    reserve: {
      blockNumber: "1",
      totalBacking: "0",
      totalLiabilities: "0",
      totalBackingUsd: "0",
      totalLiabilitiesUsd: "0",
      surplus: "0",
      navOk: true,
      mmfBps: 0,
      mmfTargetBps: 5000,
      bufferFloorBps: 3000,
      queueMinDelay: 600,
      mintCap: "0",
      reservePaused: false,
      settlementPaused: false,
      arcoUSDPaused: false,
      arcoUSDBurnPaused: false,
      depositPaused: false,
      arcoUSDMintPaused: false,
      routerPaused: false,
      redeemPaused: false,
      assets: [
        asset("tUSDC", TUSDC, 6, { availableHuman: "1001" }),
        asset("tUSDT", TUSDT, 6, { swapFeeBps: 10, availableHuman: "0" }),
        asset("tRLUSD", TRLUSD, 18, { swapFeeBps: 10, instantFeeBps: 5, availableHuman: "12.5" }),
      ],
      strategies: [],
      ...patch,
    },
    gate: { status: "open", reason: null } as unknown as GiwaArcoUSDReserve["gate"],
  }
}

function savingsRead(patch: Partial<NonNullable<GiwaArcoUSDSavings["savings"]>> = {}, arcoUSD: string = ARCOUSD): GiwaArcoUSDSavings {
  return {
    status: "live",
    chainId: 91342,
    contracts: { sArcoUSD: SARCOUSD.toLowerCase(), distributor: "0xdef6c1338a6219a8a6e2b926cdb7a92b3229df18", zap: ZAP.toLowerCase(), arcoUSD: arcoUSD.toLowerCase(), reserve: RESERVE.toLowerCase() },
    readAt: "2026-10-21T00:00:00.000Z",
    savings: {
      sharePriceHuman: "1.02",
      currentApyBps: 450,
      seeded: true,
      depositsOpen: true,
      withdrawalsOpen: true,
      ...patch,
    } as NonNullable<GiwaArcoUSDSavings["savings"]>,
  }
}

const live = (): ArcoUsdLive => arcoUsdLive(reserveRead(), savingsRead())!

const arcousdVault = {
  productId: "arcousd",
  symbol: "arcoUSD",
  name: "Arco USD",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6, tokenAddress: TUSDC },
  paymentAssetAddress: TUSDC,
  productTokenAddress: "0x28a934C3465331DdEB60908c0C3F3b8dE505Be05",
  depositVaultAddress: "0x4083d23D792cAefefc97b60677c12243AAC459e5",
  redemptionVaultAddress: "0x5719ED2d50a3fD00852e90aFE7d6Aa4fB696ec36",
  priceFeedAddress: "0x2b1C1Af136f8c9d637a44dc5340748e0389D1Ead",
  vaultConfig: { kind: "saving", acceptAssets: [{ symbol: "USDC", savingVaultId: "arcousd", isDummy: false }] },
  pauseState: null,
} as unknown as GiwaCatalogItem

test("live ArcoUSD: nothing until the Reserve read is live with its contracts", () => {
  assert.equal(arcoUsdLive(undefined, undefined), null)
  assert.equal(arcoUsdLive({ ...reserveRead(), status: "unavailable" }, savingsRead()), null)
  assert.equal(arcoUsdLive({ ...reserveRead(), contracts: null }, savingsRead()), null)
  assert.equal(arcoUsdLive({ ...reserveRead(), reserve: null }, savingsRead()), null)
})

test("live ArcoUSD: each Reserve test coin is its GIWA row, with its fees and free buffer", () => {
  const state = live()
  assert.equal(state.arcoUSD, ARCOUSD)
  assert.equal(state.reserve, RESERVE)
  assert.deepEqual(
    state.assets.map((entry) => [entry.option.key, entry.token, entry.decimals, entry.swapFeeBps, entry.instantFeeBps, entry.available]),
    [
      ["usdc-giwa", TUSDC, 6, 0, 0, 1001],
      ["usdt-giwa", TUSDT, 6, 10, 0, 0],
      ["rlusd-giwa", TRLUSD, 18, 10, 5, 12.5],
    ],
  )
  // A coin whose decimals differ from its row's would be read in the wrong unit: left out.
  const odd = arcoUsdLive(reserveRead({ assets: [asset("tUSDT", TUSDT, 18)] }), undefined)!
  assert.deepEqual(odd.assets, [])
  assert.deepEqual([state.depositPaused, state.redeemPaused], [false, false])
  const paused = arcoUsdLive(reserveRead({ arcoUSDMintPaused: true, redeemPaused: true }), undefined)!
  assert.deepEqual([paused.depositPaused, paused.redeemPaused], [true, true])
})

test("live ArcoUSD: Savings once sArcoUSD is live, seeded and on the same ArcoUSD", () => {
  assert.deepEqual(live().savings, { sArcoUSD: SARCOUSD, zap: ZAP, sharePrice: 1.02, apyPercent: 4.5, depositsOpen: true, withdrawalsOpen: true })
  assert.equal(arcoUsdLive(reserveRead(), savingsRead({ seeded: false }))!.savings, null)
  assert.equal(arcoUsdLive(reserveRead(), { ...savingsRead(), status: "not-deployed" })!.savings, null)
  assert.equal(arcoUsdLive(reserveRead(), savingsRead({}, TUSDC))!.savings, null)
})

test("prices, fees included: the Reserve one for one, the Zap at the share price", () => {
  const usdt = { swapFeeBps: 10, instantFeeBps: 0 }
  assert.deepEqual(reserveTransport(usdt), { kind: "reserve", depositPrice: 1 / 0.999, redeemPrice: 0.999 })
  assert.deepEqual(reserveTransport({ swapFeeBps: 0, instantFeeBps: 0 }), { kind: "reserve", depositPrice: 1, redeemPrice: 1 })
  assert.deepEqual(zapTransport(1.02, usdt), { kind: "zap", depositPrice: 1.02 / 0.999, redeemPrice: 1.02 * 0.999 })
  // ArcoUSD itself: no Reserve fee either way.
  assert.deepEqual(zapTransport(1.02, null), { kind: "zap", depositPrice: 1.02, redeemPrice: 1.02 })
})

test("Get ArcoUSD on the Reserve: a converter per coin, priced, limited by the buffer, paused with the Reserve", () => {
  const state = arcoUsdLive(reserveRead({ assets: [asset("tUSDC", TUSDC, 6, { availableHuman: "1001" }), asset("tUSDT", TUSDT, 6, { depositEnabled: false, swapFeeBps: 10 })] }), undefined)!
  const convert = liveConvert(state)!
  assert.equal(convert.token, ARCOUSD)
  assert.equal(convert.priceFeed, null)
  assert.deepEqual(
    convert.converters.map((entry) => [entry.option, entry.token, entry.converter, entry.instantLiquidity, entry.pauseState]),
    [
      ["usdc-giwa", TUSDC, RESERVE, 1001, { depositPaused: false, withdrawPaused: false }],
      ["usdt-giwa", TUSDT, RESERVE, 0, { depositPaused: true, withdrawPaused: false }],
    ],
  )
  // The conversion as the operation hook runs it: the coin pays, ArcoUSD is the product, the Reserve both ways.
  const usdc = CONVERT_OPTIONS.find((option) => option.key === "usdc-giwa")!
  const product = convertProduct(convert, usdc, converterFor(convert, "usdc-giwa")!)
  assert.deepEqual(
    [product.paymentAssetAddress, product.productTokenAddress, product.depositVaultAddress, product.redemptionVaultAddress, product.priceFeedAddress],
    [TUSDC, ARCOUSD, RESERVE, RESERVE, null],
  )
  assert.deepEqual(product.arcoUSD, { kind: "reserve", depositPrice: 1, redeemPrice: 1 })
  assert.equal(liveConvert({ ...state, assets: [] }), null)

  // The header shows Get ArcoUSD once the app has the Reserve's converters.
  const html = renderToStaticMarkup(createElement(ArcoUsdConvertContext.Provider, { value: convert }, createElement(GetArcoUsdButton)))
  assert.match(html, /Get ArcoUSD/)
})

test("the sArcoUSD account takes the arcoUSD vault's place: its settings, USDC, the Zap and sArcoUSD", () => {
  const vault = liveSavingsVault(arcousdVault, live())!
  assert.equal(vault.productId, LIVE_SAVINGS_PRODUCT_ID)
  assert.deepEqual(
    [vault.paymentAssetSymbol, vault.paymentAssetAddress, vault.productTokenAddress, vault.depositVaultAddress, vault.redemptionVaultAddress, vault.priceFeedAddress],
    ["tUSDC", TUSDC, SARCOUSD, ZAP, ZAP, null],
  )
  assert.equal(vault.vaultConfig, arcousdVault.vaultConfig)
  assert.deepEqual(vault.pauseState, { depositPaused: false, withdrawPaused: false })
  assert.deepEqual(vault.arcoUSD, zapTransport(1.02, { swapFeeBps: 0, instantFeeBps: 0 }))
  // Shown as the savings token, with its mark.
  assert.deepEqual([tokenSymbolFor(vault), vaultImageFor(vault)], ["sArcoUSD", "/logos/sarcousd.png"])
  assert.deepEqual(liveSavingsVault(arcousdVault, { ...live(), savings: null }), null)
  assert.equal(liveSavingsOwnLiquidity(live()), 1001)
})

test("the sArcoUSD account's other coins: USDT, RLUSD and ArcoUSD on GIWA, all through the Zap", () => {
  const state = live()
  const routes = liveSavingsRoutes(state)
  assert.deepEqual(
    routes.map((route) => [route.vault, route.option, route.token, route.depositVault, route.redemptionVault, route.instantLiquidity]),
    [
      [LIVE_SAVINGS_PRODUCT_ID, "usdt-giwa", TUSDT, ZAP, ZAP, 0],
      // The buffer is checked before fees: 12.5 tRLUSD free pays at most 12.5 less 15 bps.
      [LIVE_SAVINGS_PRODUCT_ID, "rlusd-giwa", TRLUSD, ZAP, ZAP, 12.5 * 0.9985],
      // ArcoUSD needs no Reserve buffer.
      [LIVE_SAVINGS_PRODUCT_ID, "arcousd-giwa", ARCOUSD, ZAP, ZAP, null],
    ],
  )
  assert.deepEqual(routes[1]!.arcoUSD, zapTransport(1.02, { swapFeeBps: 10, instantFeeBps: 5 }))
  // Through a route the product runs on the route's coin and prices.
  const vault = liveSavingsVault(arcousdVault, state)!
  const rlusd = SAVINGS_ASSET_OPTIONS.find((option) => option.key === "rlusd-giwa")!
  const through = productThroughRoute(vault, rlusd, routes[1]!)
  assert.deepEqual([through.paymentAssetAddress, through.paymentAsset?.decimals, through.productTokenAddress, through.arcoUSD], [TRLUSD, 18, SARCOUSD, routes[1]!.arcoUSD])
  assert.deepEqual(liveSavingsRoutes({ ...state, savings: null }), [])
  assert.deepEqual(
    routes.map((route) => route.pauseState),
    [
      { depositPaused: false, withdrawPaused: false },
      { depositPaused: false, withdrawPaused: false },
      { depositPaused: false, withdrawPaused: false },
    ],
  )
})

test("pauses: a stablecoin route follows the Reserve and its coin; ArcoUSD in and out follows Savings alone", () => {
  const state = arcoUsdLive(
    reserveRead({
      redeemPaused: true,
      assets: [asset("tUSDC", TUSDC, 6, { availableHuman: "5" }), asset("tUSDT", TUSDT, 6, { depositEnabled: false }), asset("tRLUSD", TRLUSD, 18)],
    }),
    savingsRead(),
  )!
  const routes = liveSavingsRoutes(state)
  assert.deepEqual(
    routes.map((route) => [route.option, route.pauseState]),
    [
      ["usdt-giwa", { depositPaused: true, withdrawPaused: true }],
      ["rlusd-giwa", { depositPaused: false, withdrawPaused: true }],
      ["arcousd-giwa", { depositPaused: false, withdrawPaused: false }],
    ],
  )
  // Through a route the product carries the route's pause; the account's own coin carries its own.
  const vault = liveSavingsVault(arcousdVault, state)!
  assert.deepEqual(vault.pauseState, { depositPaused: false, withdrawPaused: true })
  const usdt = SAVINGS_ASSET_OPTIONS.find((option) => option.key === "usdt-giwa")!
  assert.deepEqual(productThroughRoute(vault, usdt, routes[0]!).pauseState, { depositPaused: true, withdrawPaused: true })
  // Savings closed: every way in stops, ArcoUSD's too.
  const closed = arcoUsdLive(reserveRead(), savingsRead({ depositsOpen: false }))!
  assert.ok(liveSavingsRoutes(closed).every((route) => route.pauseState?.depositPaused === true))
  assert.equal(liveSavingsVault(arcousdVault, closed)!.pauseState?.depositPaused, true)
})

test("withdrawal approval: ArcoUSD v1 Instant withdrawals hand the product token to the contract that pays", () => {
  const state = live()
  const vault = liveSavingsVault(arcousdVault, state)!
  assert.deepEqual(withdrawalApproval(vault, "redeemInstant"), { token: SARCOUSD, spender: ZAP })
  const convert = liveConvert(state)!
  const usdc = CONVERT_OPTIONS.find((option) => option.key === "usdc-giwa")!
  assert.deepEqual(withdrawalApproval(convertProduct(convert, usdc, converterFor(convert, "usdc-giwa")!), "redeemInstant"), { token: ARCOUSD, spender: RESERVE })
  // A deposit's allowance is the coin's (the hook's usual one); a vault pair burns its own shares.
  assert.equal(withdrawalApproval(vault, "deposit"), null)
  assert.equal(withdrawalApproval(arcousdVault, "redeemInstant"), null)
})

test("the sArcoUSD account's figures: the share price as its NAV, the paid rate, the indexer's history", () => {
  assert.deepEqual(liveSavingsMarket(live().savings!), { productId: LIVE_SAVINGS_PRODUCT_ID, navBase: 1.02, baseUsd: 1, navUsd: 1.02, apy: 4.5, impliedApy: null })
  const history = {
    status: "live",
    points: [
      { takenAt: "2026-10-20T00:00:00.000Z", blockNumber: "1", sharePrice: "1", totalAssetsUsd: "1", aprBps: 0 },
      { takenAt: "2026-10-21T00:00:00.000Z", blockNumber: "2", sharePrice: "1.0002", totalAssetsUsd: "1", aprBps: 0 },
      { takenAt: "not a date", blockNumber: "3", sharePrice: "1.1", totalAssetsUsd: "1", aprBps: 0 },
    ],
    realizedApyBps: 730,
  } as unknown as GiwaArcoUSDSavingsHistory
  assert.deepEqual(liveSavingsHistory(history), {
    productId: LIVE_SAVINGS_PRODUCT_ID,
    apy: 7.3,
    points: [
      { t: 1792454400, navBase: 1, navUsd: 1 },
      { t: 1792540800, navBase: 1.0002, navUsd: 1.0002 },
    ],
  })
  assert.equal(liveSavingsHistory({ ...history, status: "unavailable" }), undefined)
})

const reserveAbi = parseAbi([
  "function deposit(address asset, uint256 amount, address recipient) returns (uint256)",
  "function redeemInstantOnly(address asset, uint256 arcoUSDAmount, address recipient, uint256 minAssetOut) returns (uint256)",
])
const zapAbi = parseAbi([
  "function deposit(address asset, uint256 amount, uint256 minShares, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address asset, uint256 minAssetOut, address receiver) returns (uint256)",
])

test("ArcoUSD v1 calls: Reserve deposit / redeemInstantOnly, Zap deposit / redeem, paid to the account", () => {
  const state = live()
  const convert = liveConvert(state)!
  const usdc = CONVERT_OPTIONS.find((option) => option.key === "usdc-giwa")!
  const reserveProduct = convertProduct(convert, usdc, converterFor(convert, "usdc-giwa")!)
  const call = (product: GiwaCatalogItem, operation: "deposit" | "redeemInstant", amount: bigint) =>
    arcoUSDOperationCall({ account: ACCOUNT, product, operation, amount })

  const deposit = call(reserveProduct, "deposit", 5_000_000n)
  assert.equal(deposit.address, RESERVE)
  assert.deepEqual([deposit.functionName, deposit.args], ["deposit", [TUSDC, 5_000_000n, ACCOUNT]])
  assert.equal(decodeFunctionData({ abi: reserveAbi, data: encodeCall(deposit) }).functionName, "deposit")
  const back = call(reserveProduct, "redeemInstant", 10n ** 18n)
  assert.deepEqual([back.address, back.functionName, back.args], [RESERVE, "redeemInstantOnly", [TUSDC, 10n ** 18n, ACCOUNT, 0n]])
  assert.equal(decodeFunctionData({ abi: reserveAbi, data: encodeCall(back) }).functionName, "redeemInstantOnly")

  const vault = liveSavingsVault(arcousdVault, state)!
  const save = call(vault, "deposit", 7_000_000n)
  assert.deepEqual([save.address, save.functionName, save.args], [ZAP, "deposit", [TUSDC, 7_000_000n, 0n, ACCOUNT]])
  assert.equal(decodeFunctionData({ abi: zapAbi, data: encodeCall(save) }).functionName, "deposit")
  const arcoUsdRoute = liveSavingsRoutes(state).find((route) => route.option === "arcousd-giwa")!
  const arcoUsdOption = SAVINGS_ASSET_OPTIONS.find((option) => option.key === "arcousd-giwa")!
  const withdraw = call(productThroughRoute(vault, arcoUsdOption, arcoUsdRoute), "redeemInstant", 3n * 10n ** 18n)
  assert.deepEqual([withdraw.address, withdraw.functionName, withdraw.args], [ZAP, "redeem", [3n * 10n ** 18n, ARCOUSD, 0n, ACCOUNT]])
  assert.equal(decodeFunctionData({ abi: zapAbi, data: encodeCall(withdraw) }).functionName, "redeem")

  // Instant only, and only for a product on ArcoUSD v1.
  assert.throws(() => arcoUSDOperationCall({ account: ACCOUNT, product: vault, operation: "requestRedeem", amount: 1n }), /Only instant/)
  assert.throws(() => arcoUSDOperationCall({ account: ACCOUNT, product: arcousdVault, operation: "deposit", amount: 1n }), /not on ArcoUSD/)
})

/** The call's calldata, encoded with its own ABI as simulateContract encodes it. */
function encodeCall(call: ReturnType<typeof arcoUSDOperationCall>) {
  return encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: [...call.args] } as Parameters<typeof encodeFunctionData>[0])
}
