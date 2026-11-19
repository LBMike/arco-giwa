import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { GiwaSidebarNav } from "./GiwaSidebarNav"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { vaultConfigOf } from "./catalog"
import { SAVINGS_CATEGORIES, savingsAssetCategory, savingsCategoryFromSearch, savingsCategoryPath } from "./savings-category"
import type { GiwaCatalogItem } from "./types"
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

// ── Gold (ArcoGOLD) ───────────────────────────────────────────────────────
test("Gold: PAXG and XAUT (and their test coins tPAXG / tXAUT) are the gold category; a gold deep link selects it", () => {
  assert.deepEqual(["PAXG", "XAUT", "tPAXG", "tXAUT", "paxg", "XAUt"].map(savingsAssetCategory), ["gold", "gold", "gold", "gold", "gold", "gold"])
  // Nothing else moves: the stablecoins stay, the other coins stay Crypto Native.
  assert.deepEqual(["USDC", "ETH", "tBTC", "XAU", "GOLD"].map(savingsAssetCategory), ["stablecoins", "crypto-native", "crypto-native", "crypto-native", "crypto-native"])
  assert.deepEqual(SAVINGS_CATEGORIES.map((category) => [category.id, category.label]), [["stablecoins", "Stablecoins"], ["crypto-native", "Crypto Native"], ["gold", "Gold"]])
  assert.equal(savingsCategoryFromSearch(new URLSearchParams("category=gold")), "gold")
  assert.equal(savingsCategoryFromSearch(new URLSearchParams("asset=tXAUT")), "gold")
  assert.equal(savingsCategoryPath("gold"), "/savings?category=gold")
  // ?category=gold picks the gold account (either accept asset opens the one ArcoGOLD vault).
  const withGold = [...accounts, ...["PAXG", "XAUT"].map((symbol) => ({ ...accounts[0]!, key: `real:arcogold:${symbol}`, symbol, vaultId: "arcogold" }))]
  const gold = withGold.filter((a) => savingsAssetCategory(a.symbol) === savingsCategoryFromSearch(new URLSearchParams("category=gold")))
  assert.equal(resolveSavingsSelection(gold, null, null)?.key, "real:arcogold:PAXG")
})

test("Gold: the sidebar lists Gold only once the loaded catalog has a gold account (it fetches nothing itself)", () => {
  const goldVault = {
    productId: "arcogold",
    symbol: "ArcoGOLD",
    vaultConfig: { ...vaultConfigOf({ vaultConfig: null }), kind: "saving", acceptAssets: [{ symbol: "PAXG", icon: null, apy: null, savingVaultId: "arcogold", isDummy: false, sortOrder: null }] },
  } as unknown as GiwaCatalogItem
  const render = (catalog: GiwaCatalogItem[] | null) => {
    const client = new QueryClient()
    if (catalog) client.setQueryData(["giwa", "catalog"], catalog)
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/savings?category=gold"]}><GiwaSidebarNav isAdmin={false} /></MemoryRouter>
      </QueryClientProvider>,
    )
  }
  for (const html of [render(null), render([{ ...goldVault, vaultConfig: { ...goldVault.vaultConfig!, acceptAssets: [] } } as GiwaCatalogItem])]) {
    assert.doesNotMatch(html, /category=gold/)
    assert.match(html, /href="\/savings\?category=crypto-native"/)
  }
  const html = render([goldVault])
  // After Crypto Native, current on a gold deep link.
  assert.match(html, /category=crypto-native"[^]*aria-current="location"[^>]*href="\/savings\?category=gold"[^>]*>Gold</)
  // No query client at all (the static tests above): no Gold, nothing breaks.
  assert.doesNotMatch(renderToStaticMarkup(<MemoryRouter initialEntries={["/savings"]}><GiwaSidebarNav isAdmin={false} /></MemoryRouter>), /category=gold/)
})
