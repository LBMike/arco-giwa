import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { GiwaSidebarNav } from "./GiwaSidebarNav"
import { savingsAssetCategory, savingsCategoryFromSearch, savingsCategoryPath } from "./savings-category"
import { resolveSavingsSelection, type SavingsAccount } from "./savings"

const accounts = ["USDC", "RLUSD", "ETH", "XRP"].map(symbol => ({ key: `real:${symbol}:${symbol}`, symbol, disabled: false, apy: "4%", icon: null, vault: null, vaultId: symbol, sortOrder: null } satisfies SavingsAccount))
test("Savings categories isolate the listed stablecoins and crypto-native assets", () => {
  assert.deepEqual(accounts.filter(a => savingsAssetCategory(a.symbol) === "stablecoins").map(a => a.symbol), ["USDC", "RLUSD"])
  assert.deepEqual(accounts.filter(a => savingsAssetCategory(a.symbol) === "crypto-native").map(a => a.symbol), ["ETH", "XRP"])
  // Every coin the Savings deposit takes is a stablecoin.
  assert.deepEqual(["USDC", "USDT", "RLUSD", "ArcoUSD"].map(savingsAssetCategory), ["stablecoins", "stablecoins", "stablecoins", "stablecoins"])
})
test("explicit category wins and cross-category selection resets to a matching enabled account", () => {
  const category = savingsCategoryFromSearch(new URLSearchParams("category=stablecoins&asset=ETH&account=real:ETH:ETH"))
  const filtered = accounts.filter(a => savingsAssetCategory(a.symbol) === category)
  assert.equal(resolveSavingsSelection(filtered, "real:ETH:ETH", "ETH")?.symbol, "USDC")
  assert.equal(resolveSavingsSelection([], null, null), null)
  assert.equal(resolveSavingsSelection(filtered.map(a => ({ ...a, disabled: true })), null, null), null)
})
test("existing asset links retain the right category and category links clear old selections", () => {
  assert.equal(savingsCategoryFromSearch(new URLSearchParams()), "stablecoins")
  assert.equal(savingsCategoryFromSearch(new URLSearchParams("asset=ETH&account=real:aeth:ETH")), "crypto-native")
  assert.equal(savingsCategoryFromSearch(new URLSearchParams("asset=RLUSD")), "stablecoins")
  assert.equal(savingsCategoryFromSearch(new URLSearchParams("category=bad&asset=XRP")), "crypto-native")
  assert.equal(savingsCategoryPath("crypto-native"), "/savings?category=crypto-native")
})
test("Savings route expands both category links, reflects a deep link and leaves other navigation collapsed", () => {
  const render = (path: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><GiwaSidebarNav isAdmin={false} /></MemoryRouter>)
  const html = render("/savings?asset=ETH&account=real:aeth:ETH")
  assert.match(html, /aria-label="Savings categories"/)
  assert.match(html, /href="\/savings\?category=stablecoins"/)
  assert.match(html, /aria-current="location"[^>]*href="\/savings\?category=crypto-native"/)
  assert.doesNotMatch(render("/funds"), /aria-label="Savings categories"/)
})
