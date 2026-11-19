// The gold Savings account on the live ArcoGOLD contracts (arcogold-live.ts, arcogold-live-context.tsx): made from the
// gold API's reads, nothing at all before the gold stack is deployed, the sArcoUSD account's calls through the gold Zap,
// and only the gold coins on its screens.

import assert from "node:assert/strict"
import test from "node:test"
import { useContext } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi } from "viem"
import {
  arcoGoldLive,
  GOLD_SAVINGS_PRODUCT_ID,
  goldOwnLiquidity,
  goldSavingsMarket,
  goldSavingsRoutes,
  goldSavingsVault,
  goldQuoteShares,
  withGoldAccounts,
  withInstantCoins,
  type ArcoGoldLive,
} from "./arcogold-live"
import { ArcoGoldLiveContext, ArcoGoldLivePendingContext, ArcoGoldLiveProvider } from "./arcogold-live-context"
import { withdrawalApproval } from "./arcousd-live"
import { vaultImageFor } from "./catalog"
import { uniquePaymentAssets, withReserveTestAssets } from "./components"
import { GIWA_CHAIN_ID } from "./config"
import { arcoUSDOperationCall } from "./contracts"
import type { SavingsAccount } from "./savings"
import {
  chosenSavingsOption,
  productThroughRoute,
  routeFor,
  SAVINGS_ASSET_OPTIONS,
  SAVINGS_GOLD_ASSET_OPTIONS,
  savingsOptionsFor,
  type SavingsAssetChoice,
  type SavingsRoute,
} from "./savings-assets"
import { SavingsRoutesContext } from "./savings-routes"
import GiwaSavingsPage from "./SavingsPage"
import type { GiwaArcoGoldReserve, GiwaArcoGoldSavings, GiwaArcoUSDAssetState, HexAddress } from "./types"
import { GiwaWalletProvider } from "./wallet"

// Checksummed (viem's getAddress).
const ARCOGOLD = getAddress("0x00000000000000000000000000000000000000ab") as HexAddress
const ZAP = getAddress("0x00000000000000000000000000000000000000ac") as HexAddress
const UNIT = getAddress("0x00000000000000000000000000000000000000ad") as HexAddress
const RESERVE = getAddress("0x00000000000000000000000000000000000000ae") as HexAddress
const TPAXG = getAddress("0x00000000000000000000000000000000000000a1") as HexAddress
const TXAUT = getAddress("0x00000000000000000000000000000000000000a2") as HexAddress
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

function reserveRead(patch: Partial<NonNullable<GiwaArcoGoldReserve["reserve"]>> = {}): GiwaArcoGoldReserve {
  return {
    status: "live",
    chainId: 91342,
    contracts: { unit: UNIT.toLowerCase(), reserve: RESERVE.toLowerCase(), lens: "0x00000000000000000000000000000000000000af" },
    readAt: "2026-11-19T00:00:00.000Z",
    reserve: {
      blockNumber: "1",
      totalBacking: "0",
      totalLiabilities: "0",
      totalBackingOunces: "0",
      totalLiabilitiesOunces: "0",
      reservePaused: false,
      depositPaused: false,
      redeemPaused: false,
      redeemInstantOnlyPaused: false,
      arcoUSDPaused: false,
      arcoUSDMintPaused: false,
      arcoUSDBurnPaused: false,
      assets: [asset("tPAXG", TPAXG, 18, { availableHuman: "3.5" }), asset("tXAUT", TXAUT, 6, { availableHuman: "0" })],
      ...patch,
    },
  }
}

function savingsRead(patch: Partial<NonNullable<GiwaArcoGoldSavings["savings"]>> = {}, top: Partial<GiwaArcoGoldSavings> = {}): GiwaArcoGoldSavings {
  return {
    status: "live",
    chainId: 91342,
    contracts: { arcoGOLD: ARCOGOLD.toLowerCase(), zap: ZAP.toLowerCase(), unit: UNIT.toLowerCase(), reserve: RESERVE.toLowerCase() },
    readAt: "2026-11-19T00:00:00.000Z",
    savings: {
      blockNumber: "1",
      totalAssets: "0",
      totalAssetsOunces: "0",
      totalSupply: "0",
      sharePrice: "1250000000000000000",
      sharePriceHuman: "1.25",
      seeded: true,
      vaultPaused: false,
      depositPaused: false,
      withdrawPaused: false,
      depositsOpen: true,
      withdrawalsOpen: true,
      ...patch,
    },
    apyPercent: 3.1,
    ounceUsd: 2400,
    ounceUsdSource: "coingecko:pax-gold",
    sharePriceUsd: 3000,
    totalAssetsUsd: "0",
    ...top,
  }
}

const live = (): ArcoGoldLive => arcoGoldLive(reserveRead(), savingsRead())!
const NOT_DEPLOYED = { status: "not-deployed", chainId: 91342, contracts: null, readAt: "", reserve: null } as unknown as GiwaArcoGoldReserve
const SAVINGS_NOT_DEPLOYED = { status: "not-deployed", chainId: 91342, contracts: null, readAt: "", savings: null, apyPercent: 3.1, ounceUsd: null } as unknown as GiwaArcoGoldSavings

test("registry absent (not deployed), a failed read or an unseeded vault: no gold account at all", () => {
  assert.equal(arcoGoldLive(undefined, undefined), null)
  assert.equal(arcoGoldLive(NOT_DEPLOYED, SAVINGS_NOT_DEPLOYED), null)
  assert.equal(arcoGoldLive({ ...reserveRead(), status: "unavailable" }, savingsRead()), null)
  assert.equal(arcoGoldLive(reserveRead(), { ...savingsRead(), status: "unavailable" }), null)
  assert.equal(arcoGoldLive(reserveRead(), savingsRead({ seeded: false })), null)
  // The two reads must name the same Reserve.
  assert.equal(arcoGoldLive(reserveRead(), { ...savingsRead(), contracts: { ...savingsRead().contracts!, reserve: TPAXG } }), null)
  // A gold coin in the wrong unit is left out; with no gold coin there is no account.
  assert.equal(arcoGoldLive(reserveRead({ assets: [asset("tPAXG", TPAXG, 6), asset("tUSDC", TXAUT, 6)] }), savingsRead()), null)
})

test("live gold: PAXG and XAUT at their decimals, the share price in ounces, an ounce's dollars and the set rate", () => {
  const gold = live()
  assert.deepEqual(
    gold.coins.map((coin) => [coin.option.key, coin.symbol, coin.decimals, coin.token, coin.available]),
    [["paxg-giwa", "tPAXG", 18, TPAXG, 3.5], ["xaut-giwa", "tXAUT", 6, TXAUT, 0]],
  )
  assert.deepEqual([gold.arcoGOLD, gold.zap, gold.sharePrice, gold.ounceUsd, gold.apyPercent], [ARCOGOLD, ZAP, 1.25, 2400, 3.1])
  assert.deepEqual(goldSavingsMarket(gold), { productId: "arcogold", navBase: 1.25, baseUsd: 2400, navUsd: 3000, apy: 3.1, impliedApy: null })
  // No ounce price: ounces still read, no dollars made up.
  const unpriced = arcoGoldLive(reserveRead(), savingsRead({}, { ounceUsd: null }))!
  assert.deepEqual([goldSavingsMarket(unpriced).baseUsd, goldSavingsMarket(unpriced).navUsd], [null, null])
  assert.equal(goldOwnLiquidity(gold), 3.5)
})

test("the account: ArcoGOLD through the gold Zap, paid in PAXG; XAUT is a route with its own instant liquidity", () => {
  const gold = live()
  const vault = goldSavingsVault(gold)
  assert.equal(vault.productId, GOLD_SAVINGS_PRODUCT_ID)
  assert.deepEqual(
    [vault.symbol, vault.paymentAssetSymbol, vault.paymentAssetAddress, vault.productTokenAddress, vault.depositVaultAddress, vault.redemptionVaultAddress],
    ["ArcoGOLD", "tPAXG", TPAXG, ARCOGOLD, ZAP, ZAP],
  )
  assert.deepEqual(vault.arcoUSD, { kind: "zap", depositPrice: 1.25, redeemPrice: 1.25 })
  assert.equal(vaultImageFor(vault), "/logos/arcogold.png")
  const routes = goldSavingsRoutes(gold)
  assert.equal(routes.length, 1)
  assert.deepEqual(
    [routes[0]!.vault, routes[0]!.option, routes[0]!.token, routes[0]!.depositVault, routes[0]!.redemptionVault, routes[0]!.instantLiquidity],
    ["arcogold", "xaut-giwa", TXAUT, ZAP, ZAP, 0],
  )
  // Pauses: the vault's switches, the Reserve leg's and the coin's own.
  assert.deepEqual(vault.pauseState, { depositPaused: false, withdrawPaused: false })
  const paused = arcoGoldLive(reserveRead({ redeemInstantOnlyPaused: true }), savingsRead({ depositsOpen: false }))!
  assert.deepEqual(goldSavingsVault(paused).pauseState, { depositPaused: true, withdrawPaused: true })
  const xautOff = arcoGoldLive(reserveRead({ assets: [asset("tPAXG", TPAXG, 18), asset("tXAUT", TXAUT, 6, { depositEnabled: false })] }), savingsRead())!
  assert.deepEqual(goldSavingsRoutes(xautOff)[0]!.pauseState, { depositPaused: true, withdrawPaused: false })
})

test("deposits and withdrawals call the gold Zap like the sArcoUSD flow: approve-then-deposit the coin, an ArcoGOLD allowance to redeem", () => {
  const gold = live()
  const vault = goldSavingsVault(gold)
  const zapAbi = parseAbi([
    "function deposit(address asset, uint256 amount, uint256 minShares, address receiver) returns (uint256 shares)",
    "function redeem(uint256 shares, address asset, uint256 minAssetOut, address receiver) returns (uint256 assetOut)",
  ])
  const decode = (call: ReturnType<typeof arcoUSDOperationCall>) => decodeFunctionData({ abi: zapAbi, data: encode(call) })
  // Encoded with the call's own ABI, decoded with the Zap's: the call matches the contract.
  const encode = (call: ReturnType<typeof arcoUSDOperationCall>) => encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never)
  const deposit = arcoUSDOperationCall({ account: ACCOUNT, product: vault, operation: "deposit", amount: 10n ** 18n })
  assert.equal(deposit.address, ZAP)
  assert.deepEqual(decode(deposit).args, [TPAXG, 10n ** 18n, 0n, ACCOUNT])
  // XAUT through its route: 6 decimals in, the same Zap.
  const option = SAVINGS_GOLD_ASSET_OPTIONS.find((entry) => entry.key === "xaut-giwa")!
  const throughXaut = productThroughRoute(vault, option, routeFor(goldSavingsRoutes(gold), vault, "xaut-giwa")!)
  assert.equal(throughXaut.paymentAsset?.decimals, 6)
  const redeem = arcoUSDOperationCall({ account: ACCOUNT, product: throughXaut, operation: "redeemInstant", amount: 2n * 10n ** 18n })
  assert.deepEqual([redeem.address, decode(redeem).functionName, decode(redeem).args], [ZAP, "redeem", [2n * 10n ** 18n, TXAUT, 0n, ACCOUNT]])
  // A withdrawal hands ArcoGOLD back to the Zap, which pulls it: the approval step covers ArcoGOLD for the Zap.
  assert.deepEqual(withdrawalApproval(throughXaut, "redeemInstant"), { token: ARCOGOLD, spender: ZAP })
  assert.equal(withdrawalApproval(throughXaut, "deposit"), null)
})

test("the coin picker: the gold account lists PAXG and XAUT on GIWA only; the stablecoin account keeps its own list", () => {
  assert.deepEqual(savingsOptionsFor("tPAXG")?.options.map((option) => option.key), ["paxg-giwa", "xaut-giwa"])
  assert.deepEqual(SAVINGS_GOLD_ASSET_OPTIONS.map((option) => [option.symbol, option.decimals, option.chain]), [["PAXG", 18, "giwa"], ["XAUT", 6, "giwa"]])
  assert.equal(savingsOptionsFor("tUSDC")?.options, SAVINGS_ASSET_OPTIONS)
  assert.ok(!SAVINGS_ASSET_OPTIONS.some((option) => option.symbol === "PAXG" || option.symbol === "XAUT"))
  assert.equal(savingsOptionsFor("tBTC"), null)
  const vault = goldSavingsVault(live())
  const routes = goldSavingsRoutes(live())
  assert.equal(chosenSavingsOption(vault, routes, "xaut-giwa")?.key, "xaut-giwa")
  // A stablecoin is never a gold account's coin, and without the route XAUT falls back to PAXG.
  assert.equal(chosenSavingsOption(vault, routes, "usdc-giwa")?.key, "paxg-giwa")
  assert.equal(chosenSavingsOption(vault, [], "xaut-giwa")?.key, "paxg-giwa")
})

function account(symbol: string, patch: Partial<SavingsAccount> = {}): SavingsAccount {
  return { key: `real:arcousd:${symbol}`, symbol, icon: null, apy: "5%", disabled: false, vault: null, vaultId: "arcousd", sortOrder: null, ...patch }
}

test("Savings accounts: the live gold account replaces any gold coin the Vault Config lists, once, in its place", () => {
  const gold = live()
  const vault = goldSavingsVault(gold)
  const base = [account("USDC"), account("BTC", { key: "real:abtc:BTC", vaultId: "abtc" })]
  // Not deployed: the list is as built (nothing gold appears).
  assert.deepEqual(withGoldAccounts(base, null, null, "3.1%"), base)
  // Deployed, no gold in the Vault Config: PAXG and XAUT after the others, both opening ArcoGOLD.
  const added = withGoldAccounts(base, vault, gold, "3.1%")
  assert.deepEqual(added.map((entry) => entry.key), ["real:arcousd:USDC", "real:abtc:BTC", "real:arcogold:PAXG", "real:arcogold:XAUT"])
  assert.ok(added.slice(2).every((entry) => entry.vault === vault && entry.apy === "3.1%" && !entry.disabled && entry.vaultId === "arcogold"))
  assert.deepEqual(added.slice(2).map((entry) => entry.icon), ["/logos/paxg.png", "/logos/xaut.png"])
  // Coming-soon gold cards in the Vault Config: replaced where they stood, their order kept; never shown twice.
  const listed = [account("USDC"), account("PAXG", { key: "dummy:arcousd:PAXG", disabled: true, sortOrder: 2 }), account("tXAUT", { key: "dummy:arcousd:tXAUT", disabled: true }), account("BTC")]
  const replaced = withGoldAccounts(listed, vault, gold, "3.1%")
  assert.deepEqual(replaced.map((entry) => entry.key), ["real:arcousd:USDC", "real:arcogold:PAXG", "real:arcogold:XAUT", "real:arcousd:BTC"])
  assert.equal(replaced[1]!.sortOrder, 2)
  assert.equal(replaced.filter((entry) => entry.symbol === "PAXG" || entry.symbol === "tXAUT" || entry.symbol === "XAUT").length, 2)
})

function Probe() {
  const gold = useContext(ArcoGoldLiveContext)
  const pending = useContext(ArcoGoldLivePendingContext)
  return <p>{`pending=${pending} gold=${gold !== null}`}</p>
}

function renderProvider(seed: { reserve?: unknown; savings?: unknown }, options: { enabled?: boolean; routes?: readonly SavingsRoute[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (seed.reserve !== undefined) client.setQueryData(["giwa", "arcogold", "reserve"], seed.reserve)
  if (seed.savings !== undefined) client.setQueryData(["giwa", "arcogold", "savings"], seed.savings)
  const tree = (
    <QueryClientProvider client={client}>
      <ArcoGoldLiveProvider enabled={options.enabled}>
        <Probe />
      </ArcoGoldLiveProvider>
    </QueryClientProvider>
  )
  return renderToStaticMarkup(options.routes ? <SavingsRoutesContext.Provider value={options.routes}>{tree}</SavingsRoutesContext.Provider> : tree).replace(/<[^>]+>/g, "")
}

test("provider: not deployed answers no gold; live answers the account; nothing is read in the admin console or a preview host", () => {
  assert.equal(renderProvider({}), "pending=true gold=false")
  assert.equal(renderProvider({ reserve: NOT_DEPLOYED, savings: SAVINGS_NOT_DEPLOYED }), "pending=false gold=false")
  assert.equal(renderProvider({ reserve: reserveRead(), savings: savingsRead() }), "pending=false gold=true")
  assert.equal(renderProvider({}, { enabled: false }), "pending=false gold=false")
  assert.equal(renderProvider({ reserve: reserveRead(), savings: savingsRead() }, { routes: [{ vault: "arcousd", option: "usdt-giwa" } as unknown as SavingsRoute] }), "pending=false gold=false")
})

const stableVault = {
  productId: "arcousd",
  symbol: "arcoUSD",
  name: "Arco USD",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6, tokenAddress: "0x869d9c8d9BF0A961FC2FD3bBa300fDBEeE3C2633" },
  paymentAssetAddress: "0x869d9c8d9BF0A961FC2FD3bBa300fDBEeE3C2633",
  productTokenAddress: "0x28a934C3465331DdEB60908c0C3F3b8dE505Be05",
  depositVaultAddress: "0x4083d23D792cAefefc97b60677c12243AAC459e5",
  redemptionVaultAddress: "0x5719ED2d50a3fD00852e90aFE7d6Aa4fB696ec36",
  priceFeedAddress: null,
  vaultConfig: {
    kind: "saving",
    acceptAssets: [
      { symbol: "USDC", icon: null, apy: null, savingVaultId: "arcousd", isDummy: false, sortOrder: null },
      { symbol: "PAXG", icon: null, apy: 3, savingVaultId: null, isDummy: true, sortOrder: null },
    ],
  },
}

function renderPage(gold: ArcoGoldLive | null, url: string, options: { goldPending?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["giwa", "catalog"], [stableVault])
  client.setQueryData(["giwa", "market", GIWA_CHAIN_ID], [])
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GiwaWalletProvider>
        <ArcoGoldLivePendingContext.Provider value={options.goldPending ?? false}>
          <ArcoGoldLiveContext.Provider value={gold}>
            <MemoryRouter initialEntries={[url]}>
              <GiwaSavingsPage />
            </MemoryRouter>
          </ArcoGoldLiveContext.Provider>
        </ArcoGoldLivePendingContext.Provider>
      </GiwaWalletProvider>
    </QueryClientProvider>,
  )
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") }
}

test("Savings page: before the gold deploy the gold tab is the Vault Config's (a coming-soon card) and nothing gold opens", () => {
  const { html, text } = renderPage(null, "/savings?category=gold")
  // The Vault Config's PAXG dummy: a disabled Gold tab, the stablecoin account open.
  assert.match(html, /data-gold-tab=""[^>]*\sdisabled=""/)
  assert.doesNotMatch(text, /ArcoGOLD/)
})

test("Savings page: with the live gold account the Gold tab opens ArcoGOLD on the gold card, with both marks beside Available Gold", () => {
  const { html, text } = renderPage(live(), "/savings?category=gold")
  assert.doesNotMatch(html, /data-gold-tab=""[^>]*\sdisabled=""/)
  assert.match(html, /data-savings-tone="gold"/)
  assert.match(text, /3\.1%/)
  assert.match(html, /\/logos\/arcogold\.png/)
  assert.match(html, /\/logos\/paxg\.png/)
  assert.match(html, /\/logos\/xaut\.png/)
  // Once: the dummy PAXG card is replaced, not shown beside the live one.
  assert.equal((html.match(/data-gold-tab=""/g) ?? []).length, 1)
  // A link to the Gold tab waits for the first gold reads rather than opening another account.
  assert.doesNotMatch(renderPage(null, "/savings?category=gold", { goldPending: true }).text, /ArcoGOLD|Stablecoins/)
  assert.match(renderPage(null, "/savings?category=stablecoins", { goldPending: true }).text, /Stablecoins/)
})

test("Mint test assets: the gold Reserve's tPAXG and tXAUT join the list, on the same faucet", () => {
  const faucet = "0x00000000000000000000000000000000000000fa" as HexAddress
  const core = uniquePaymentAssets([{ ...stableVault, paymentAsset: { ...stableVault.paymentAsset, faucetAddress: faucet } } as never])
  const assets = withReserveTestAssets(core, reserveRead().reserve!.assets)
  assert.deepEqual(assets.map((entry) => [entry.symbol, entry.decimals, entry.faucet]), [["tUSDC", 6, faucet], ["tPAXG", 18, faucet], ["tXAUT", 6, faucet]])
  // Not deployed: nothing added.
  assert.deepEqual(withReserveTestAssets(core, []), core)
})

test("withdraw screen: a coin quoteRedeem says is not instant is greyed out; unknown quotes and other screens change nothing", () => {
  const choices: SavingsAssetChoice[] = SAVINGS_GOLD_ASSET_OPTIONS.map((option) => ({ ...option, available: true, balance: 1, usd: 2400 }))
  const greyed = withInstantCoins(choices, new Map([["paxg-giwa", true], ["xaut-giwa", false]]))!
  assert.deepEqual(greyed.map((choice) => [choice.key, choice.available, choice.unavailableLabel]), [["paxg-giwa", true, undefined], ["xaut-giwa", false, "Not available now"]])
  assert.deepEqual(withInstantCoins(choices, new Map([["paxg-giwa", true]]))!.map((choice) => choice.available), [true, true])
  assert.deepEqual(withInstantCoins(choices, null), choices)
  assert.equal(withInstantCoins(null, new Map()), null)
  // What is quoted: the amount entered, else the whole balance, else one ArcoGOLD; a half-typed amount is not an amount.
  assert.equal(goldQuoteShares("0.5", "3"), 5n * 10n ** 17n)
  assert.equal(goldQuoteShares("", "3"), 3n * 10n ** 18n)
  assert.equal(goldQuoteShares("abc", "--"), 10n ** 18n)
  assert.equal(goldQuoteShares("0", "0"), 10n ** 18n)
})
