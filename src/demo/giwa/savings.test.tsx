import assert from "node:assert/strict"
import test from "node:test"
import { buildSavingsAccounts, defaultSavingsSelection, resolveSavingsSelection } from "./savings"
import { vaultConfigOf } from "./catalog"
import type { GiwaAcceptAsset, GiwaCatalogItem, GiwaVaultConfig } from "./types"
import type { GiwaMarketEntry } from "./api"

function cfg(overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return { ...vaultConfigOf({ vaultConfig: null }), ...overrides }
}
function vault(productId: string, symbol: string, overrides: Partial<GiwaVaultConfig>): GiwaCatalogItem {
  return {
    productId,
    symbol,
    name: symbol,
    paymentAssetSymbol: "tUSDC",
    paymentAsset: null,
    paymentAssetAddress: null,
    productTokenAddress: null,
    depositVaultAddress: null,
    redemptionVaultAddress: null,
    priceFeedAddress: null,
    vaultConfig: cfg(overrides),
  } as GiwaCatalogItem
}
function accept(
  symbol: string,
  savingVaultId: string | null,
  isDummy: boolean,
  apy: number | null = null,
  sortOrder: number | null = null,
): GiwaAcceptAsset {
  return { symbol, icon: null, apy, savingVaultId, isDummy, sortOrder }
}
function market(productId: string, apy: number | null): GiwaMarketEntry {
  return { productId, navBase: null, baseUsd: null, navUsd: null, apy, impliedApy: null }
}

test("buildSavingsAccounts: keeps dummies disabled, skips dangling reals, live vs static APY, global order", () => {
  const catalog: GiwaCatalogItem[] = [
    // pinned + highest AUM → first; USDC (real→self) + RLUSD (dummy, static 3.8%)
    vault("arcousd", "arcoUSD", {
      kind: "saving",
      pinned: true,
      aum: "$900M",
      acceptAssets: [accept("USDC", "arcousd", false), accept("RLUSD", null, true, 3.8)],
    }),
    // $100M
    vault("arcoeth", "arcoETH", { kind: "saving", aum: "$100M", acceptAssets: [accept("ETH", "arcoeth", false)] }),
    // $50M; XRP real + BADCOIN pointing at a non-saving id → skipped (dangling)
    vault("arcoxrp", "arcoXRP", {
      kind: "saving",
      aum: "$50M",
      acceptAssets: [accept("XRP", "arcoxrp", false), accept("BADCOIN", "ghost", false)],
    }),
    // a PRODUCT vault whose (dormant) accept-assets must never surface on Savings
    vault("aprod", "aPROD", { kind: "product", acceptAssets: [accept("PX", "aprod", false)] }),
  ]
  const marketData: GiwaMarketEntry[] = [market("arcousd", 4.2), market("arcoeth", 3.3), market("arcoxrp", 3.5)]

  const accounts = buildSavingsAccounts(catalog, marketData)
  assert.deepEqual(
    accounts.map((a) => a.symbol),
    ["USDC", "RLUSD", "ETH", "XRP"],
  ) // vault order (pinned→AUM desc) → intra-vault index; BADCOIN + aPROD dropped

  assert.deepEqual(accounts[0], { key: "real:arcousd:USDC", symbol: "USDC", icon: null, apy: "4.2%", disabled: false, vault: catalog[0], vaultId: "arcousd", sortOrder: null })
  assert.equal(accounts[1].disabled, true) // RLUSD dummy
  assert.equal(accounts[1].vault, null)
  assert.equal(accounts[1].apy, "3.8%") // static, from stored apy
  assert.equal(accounts[2].apy, "3.3%") // ETH live
  assert.equal(accounts[3].apy, "3.5%") // XRP live
  assert.ok(!accounts.some((a) => a.symbol === "BADCOIN" || a.symbol === "PX"))
})

test("buildSavingsAccounts: pinned beats AUM, intra-vault index preserved", () => {
  const catalog: GiwaCatalogItem[] = [
    vault("va", "vA", { kind: "saving", pinned: false, aum: "$50M", acceptAssets: [accept("a1", "va", false), accept("a2", "va", false)] }),
    vault("vb", "vB", { kind: "saving", pinned: true, aum: "$10M", acceptAssets: [accept("b1", "vb", false)] }),
  ]
  const accounts = buildSavingsAccounts(catalog, [])
  assert.deepEqual(
    accounts.map((a) => a.symbol),
    ["b1", "a1", "a2"], // vB pinned first (despite lower AUM); a1 before a2 (index)
  )
})

test("buildSavingsAccounts + defaultSavingsSelection: default = first enabled; live APY '—' when no market", () => {
  const catalog: GiwaCatalogItem[] = [
    vault("arcousd", "arcoUSD", {
      kind: "saving",
      acceptAssets: [accept("RLUSD", null, true, 5), accept("USDC", "arcousd", false)],
    }),
  ]
  const accounts = buildSavingsAccounts(catalog, []) // no market entry for arcousd
  assert.deepEqual(accounts.map((a) => a.symbol), ["RLUSD", "USDC"])
  assert.equal(accounts[0].disabled, true) // dummy first
  assert.equal(accounts[1].apy, "—") // real, but no market → dash
  assert.equal(defaultSavingsSelection(accounts)?.symbol, "USDC") // skips the leading dummy
})

test("buildSavingsAccounts: graceful empty — no saving vaults, or saving vault with no accept-assets", () => {
  // No saving vaults at all.
  assert.deepEqual(buildSavingsAccounts([vault("aprod", "aPROD", { kind: "product" })], []), [])
  assert.equal(defaultSavingsSelection([]), null)
  // A saving vault configured but with no accept-assets yet.
  assert.deepEqual(buildSavingsAccounts([vault("arcousd", "arcoUSD", { kind: "saving", acceptAssets: null })], []), [])
  // Only-dummies → no enabled default.
  const onlyDummy = buildSavingsAccounts(
    [vault("arcousd", "arcoUSD", { kind: "saving", acceptAssets: [accept("RLUSD", null, true, 3)] })],
    [],
  )
  assert.equal(onlyDummy.length, 1)
  assert.equal(defaultSavingsSelection(onlyDummy), null)
})

test("buildSavingsAccounts: global sortOrder reorders across vaults; dummies orderable; unset trails", () => {
  const catalog: GiwaCatalogItem[] = [
    vault("arcousd", "arcoUSD", {
      kind: "saving",
      aum: "$900M",
      acceptAssets: [accept("USDC", "arcousd", false, null, 2), accept("RLUSD", null, true, 3.8, 1)],
    }),
    vault("arcoeth", "arcoETH", { kind: "saving", aum: "$100M", acceptAssets: [accept("ETH", "arcoeth", false, null, null)] }),
    vault("arcoxrp", "arcoXRP", { kind: "saving", aum: "$50M", acceptAssets: [accept("XRP", "arcoxrp", false, null, 0)] }),
  ]
  const marketData: GiwaMarketEntry[] = [market("arcousd", 4.2), market("arcoeth", 3.3), market("arcoxrp", 3.5)]
  const accounts = buildSavingsAccounts(catalog, marketData)
  // Derivation order is USDC,RLUSD,ETH,XRP; sortOrder 0,1,2 pull XRP/RLUSD/USDC to the front, ETH (unset) trails.
  assert.deepEqual(accounts.map((a) => a.symbol), ["XRP", "RLUSD", "USDC", "ETH"])
  assert.equal(accounts[1].disabled, true) // the dummy is orderable into position 1, still disabled
  assert.equal(accounts[accounts.length - 1].symbol, "ETH") // unset sortOrder trails
  assert.equal(defaultSavingsSelection(accounts)?.symbol, "XRP") // first ENABLED after the sort
  assert.equal(accounts[1].vaultId, "arcousd") // owning vault set on the dummy so the order route can address it
})

test("buildSavingsAccounts: a newly-added asset (no sortOrder) trails the ordered cards", () => {
  const catalog: GiwaCatalogItem[] = [
    vault("arcousd", "arcoUSD", {
      kind: "saving",
      acceptAssets: [accept("USDC", "arcousd", false, null, 0), accept("NEWCOIN", "arcousd", false, null, null)],
    }),
  ]
  const accounts = buildSavingsAccounts(catalog, [])
  assert.deepEqual(accounts.map((a) => a.symbol), ["USDC", "NEWCOIN"]) // ordered card first; the new (unset) one trails
})


test("Savings deep links retain unique account identity for duplicate symbols and support older asset-only links", () => {
  const catalog = [
    vault("usd-one", "arcoUSD1", { kind: "saving", acceptAssets: [accept("USDC", "usd-one", false)] }),
    vault("usd-two", "arcoUSD2", { kind: "saving", acceptAssets: [accept("USDC", "usd-two", false), accept("RLUSD", null, true)] }),
  ]
  const accounts = buildSavingsAccounts(catalog, [])
  assert.equal(resolveSavingsSelection(accounts, "real:usd-two:USDC", "USDC")?.vault?.productId, "usd-two")
  assert.equal(resolveSavingsSelection(accounts, null, "USDC")?.vault?.productId, "usd-one")
  assert.equal(resolveSavingsSelection(accounts, "missing", "USDC")?.vault?.productId, "usd-one")
  assert.equal(resolveSavingsSelection(accounts, "dummy:usd-two:RLUSD", "RLUSD")?.vault?.productId, "usd-one")
})
