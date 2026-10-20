// The Savings coin options and the rules around them: which coins on which chains, the coin a transfer uses (only one a
// vault can take), a vault reached through a route, the token picker's lists, and the withdrawals shown per route.

import assert from "node:assert/strict"
import test from "node:test"
import {
  chainsWithBalance,
  chosenSavingsOption,
  heldCoins,
  heldUsd,
  nativeSavingsOption,
  pickerSections,
  productThroughRoute,
  routeFor,
  SAVINGS_ASSET_OPTIONS,
  type SavingsAssetChoice,
  type SavingsRoute,
} from "./savings-assets"
import { pendingWithdrawals } from "./savings-transfer"
import type { GiwaCatalogItem, GiwaRedemption, HexAddress } from "./types"

const vault = {
  productId: "arcousd",
  symbol: "arcoUSD",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  paymentAssetAddress: "0x00000000000000000000000000000000000000a1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
  vaultConfig: null,
} as unknown as GiwaCatalogItem

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as HexAddress
const route = (option: string, n: number): SavingsRoute => ({ vault: "arcousd", option, token: address(n), depositVault: address(n + 1), redemptionVault: address(n + 2) })
const option = (key: string) => SAVINGS_ASSET_OPTIONS.find((entry) => entry.key === key)!
const choice = (key: string, available: boolean, balance: number | null): SavingsAssetChoice => ({ ...option(key), available, balance, usd: balance })

test("coin options: each stablecoin on the chains it is issued on; a vault paid in tUSDC takes USDC on GIWA", () => {
  assert.deepEqual(
    SAVINGS_ASSET_OPTIONS.map((entry) => `${entry.symbol} ${entry.chainName}`),
    ["USDC Ethereum", "USDC GIWA", "USDT Ethereum", "USDT GIWA", "RLUSD Ethereum", "RLUSD XRPL", "RLUSD GIWA", "ArcoUSD GIWA"],
  )
  assert.deepEqual(
    SAVINGS_ASSET_OPTIONS.map((entry) => [entry.key, entry.logo]),
    [
      ["usdc-ethereum", "/logos/usdc.svg"],
      ["usdc-giwa", "/logos/usdc.svg"],
      ["usdt-ethereum", "/logos/usdt.png"],
      ["usdt-giwa", "/logos/usdt.png"],
      ["rlusd-ethereum", "/logos/rlusd.png"],
      ["rlusd-xrpl", "/logos/rlusd.png"],
      ["rlusd-giwa", "/logos/rlusd.png"],
      ["arcousd-giwa", "/logos/arcousd.png"],
    ],
  )
  assert.equal(nativeSavingsOption("tUSDC")?.key, "usdc-giwa")
  // The ArcoUSD Reserve's other test coins are GIWA's too.
  assert.equal(nativeSavingsOption("tUSDT")?.key, "usdt-giwa")
  assert.equal(nativeSavingsOption("tRLUSD")?.key, "rlusd-giwa")
  // A crypto-native vault takes no stablecoin: it keeps its single coin and no picker.
  assert.equal(nativeSavingsOption("tWETH"), null)
  assert.equal(nativeSavingsOption("tXRP"), null)
})

test("the coin in use: the one picked while the vault has a route for it, else the vault's own", () => {
  const routes = [route("usdt-ethereum", 0x100)]
  assert.equal(chosenSavingsOption(vault, routes, null)?.key, "usdc-giwa")
  assert.equal(chosenSavingsOption(vault, routes, "usdc-giwa")?.key, "usdc-giwa")
  assert.equal(chosenSavingsOption(vault, routes, "usdt-ethereum")?.key, "usdt-ethereum")
  // No route for it (a real wallet has none): the vault's own coin, never a coin the vault cannot take.
  assert.equal(chosenSavingsOption(vault, routes, "rlusd-xrpl")?.key, "usdc-giwa")
  assert.equal(chosenSavingsOption(vault, [], "usdt-ethereum")?.key, "usdc-giwa")
  assert.equal(chosenSavingsOption(vault, routes, "no-such-coin")?.key, "usdc-giwa")
  // Another vault's route does not count.
  assert.equal(chosenSavingsOption({ ...vault, productId: "other" }, routes, "usdt-ethereum")?.key, "usdc-giwa")
  assert.equal(chosenSavingsOption({ productId: "aeth", paymentAssetSymbol: "tWETH" }, routes, "usdt-ethereum"), null)
  assert.equal(routeFor(routes, vault, "usdt-ethereum"), routes[0])
  assert.equal(routeFor(routes, vault, "rlusd-xrpl"), null)
})

test("through a route the vault keeps its product, share token and price; the coin and the contracts are the route's", () => {
  const usdt = route("usdt-ethereum", 0x100)
  const through = productThroughRoute(vault, option("usdt-ethereum"), usdt)
  assert.equal(through.productId, "arcousd")
  assert.equal(through.symbol, "arcoUSD")
  assert.equal(through.productTokenAddress, vault.productTokenAddress)
  assert.equal(through.priceFeedAddress, vault.priceFeedAddress)
  assert.equal(through.paymentAssetSymbol, "USDT")
  assert.equal(through.paymentAssetAddress, usdt.token)
  assert.equal(through.depositVaultAddress, usdt.depositVault)
  assert.equal(through.redemptionVaultAddress, usdt.redemptionVault)
  assert.deepEqual(through.paymentAsset, { symbol: "USDT", name: "Tether USD", decimals: 6, tokenAddress: usdt.token })
  // RLUSD keeps its own 18 decimals.
  assert.equal(productThroughRoute(vault, option("rlusd-xrpl"), route("rlusd-xrpl", 0x200)).paymentAsset?.decimals, 18)
})

test("picker lists: coins held first, the largest first; then those the vault can take; then those coming soon", () => {
  const choices = [
    choice("usdc-ethereum", true, 5),
    choice("usdc-giwa", true, 9_000),
    choice("usdt-ethereum", true, 0),
    choice("rlusd-ethereum", true, 20_000),
    choice("rlusd-xrpl", false, null),
    choice("arcousd-giwa", true, null),
  ]
  const keys = (list: readonly SavingsAssetChoice[]) => list.map((entry) => entry.key)
  const all = pickerSections(choices, { chain: "all", query: "" })
  assert.deepEqual(keys(all.held), ["rlusd-ethereum", "usdc-giwa", "usdc-ethereum"])
  assert.deepEqual(keys(all.other), ["usdt-ethereum", "arcousd-giwa", "rlusd-xrpl"])
  // A chain, a search by ticker, name or chain, and both.
  const xrpl = pickerSections(choices, { chain: "xrpl", query: "" })
  assert.deepEqual([keys(xrpl.held), keys(xrpl.other)], [[], ["rlusd-xrpl"]])
  const ripple = pickerSections(choices, { chain: "all", query: "  Ripple " })
  assert.deepEqual([keys(ripple.held), keys(ripple.other)], [["rlusd-ethereum"], ["rlusd-xrpl"]])
  const giwa = pickerSections(choices, { chain: "all", query: "giwa" })
  assert.deepEqual([keys(giwa.held), keys(giwa.other)], [["usdc-giwa"], ["arcousd-giwa"]])
  assert.deepEqual(keys(pickerSections(choices, { chain: "ethereum", query: "usdc" }).held), ["usdc-ethereum"])
  assert.deepEqual(pickerSections(choices, { chain: "xrpl", query: "usdt" }), { held: [], other: [] })

  // The network menu's "With balance", the Savings card's stack (one mark per coin) and its total.
  assert.deepEqual(chainsWithBalance(choices), ["ethereum", "giwa"])
  assert.deepEqual(heldCoins(choices), [
    { symbol: "RLUSD", logo: "/logos/rlusd.png", usd: 20_000 },
    { symbol: "USDC", logo: "/logos/usdc.svg", usd: 9_005 },
  ])
  assert.equal(heldUsd(choices), 29_005)
  assert.equal(heldUsd([choice("usdc-giwa", true, null), choice("usdt-ethereum", false, null)]), null)
})

test("pending withdrawals: with a redemption vault, only the rows requested from it (a row naming none is kept)", () => {
  const rows = [
    { productId: "arcousd", status: "REQUESTED", redemptionVaultAddress: "0x00000000000000000000000000000000000000D1", requestId: "1" },
    { productId: "arcousd", status: "REQUESTED", redemptionVaultAddress: address(0x102), requestId: "2" },
    { productId: "arcousd", status: "SETTLING", requestId: "3" },
    { productId: "arcousd", status: "SETTLED", redemptionVaultAddress: vault.redemptionVaultAddress, requestId: "4" },
    { productId: "aeth", status: "REQUESTED", redemptionVaultAddress: vault.redemptionVaultAddress, requestId: "5" },
  ] as unknown as GiwaRedemption[]
  assert.deepEqual(pendingWithdrawals(rows, "arcousd").map((row) => row.requestId), ["1", "2", "3"])
  assert.deepEqual(pendingWithdrawals(rows, "arcousd", vault.redemptionVaultAddress).map((row) => row.requestId), ["1", "3"])
  assert.deepEqual(pendingWithdrawals(rows, "arcousd", address(0x102)).map((row) => row.requestId), ["2", "3"])
})
