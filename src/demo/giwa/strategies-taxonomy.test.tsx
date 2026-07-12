import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaStrategyCards, GIWA_EMPTY_FILTERS } from "./components"
import { vaultConfigOf } from "./catalog"
import { VAULT_CATEGORIES } from "../../../shared/vault-taxonomy"
import type { GiwaCatalogItem, GiwaVaultConfig } from "./types"

// Taxonomy: "Equity Exposure" is a 4th valid category. The investor Strategies section HIDES the
// "Arco Saving" card and shows an "Equity Exposure" card; Arco Saving stays valid in the taxonomy
// (admin) — only its investor Strategies card is hidden.

function cfg(overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return { ...vaultConfigOf({ vaultConfig: null }), ...overrides }
}
function vault(productId: string, symbol: string, category: GiwaVaultConfig["category"], paymentAssetSymbol = "tUSDC"): GiwaCatalogItem {
  return { productId, symbol, name: symbol, paymentAssetSymbol, vaultConfig: cfg({ category }) } as unknown as GiwaCatalogItem
}

test("taxonomy has all four categories, Arco Saving kept and Equity Exposure added", () => {
  assert.deepEqual(VAULT_CATEGORIES, ["U.S Treasuries", "Prime Credit", "Arco Saving", "Equity Exposure"])
})

test("Strategies section shows the Equity Exposure card (with its badge) and HIDES Arco Saving", () => {
  const products = [
    vault("acapix", "aCAPIX", "Prime Credit"),
    vault("beqty", "bEQTY", "Equity Exposure"),
    vault("abtc", "aBTC", "Arco Saving", "tBTC"), // an Arco Saving vault is present but its card stays hidden
  ]
  const html = renderToStaticMarkup(<GiwaStrategyCards products={products} active={[]} onToggle={() => undefined} />)

  // Equity Exposure card: title + Figma badge "Equity Income Strategies · <count>".
  assert.match(html, /Equity Exposure/)
  assert.match(html, /Tokenized equity offering diversified growth and dividend income exposure\./)
  assert.match(html, /Equity Income Strategies · 1/) // one Equity Exposure vault

  // The other two visible strategies still render.
  assert.match(html, /U\.S\. Treasuries/)
  assert.match(html, /Prime Credit/)

  // Arco Saving is hidden from the investor Strategies section (no card, title, blurb, or badge).
  assert.doesNotMatch(html, /Arco Saving/)
  assert.doesNotMatch(html, /Crypto Native Asset/)
})

test("GIWA_EMPTY_FILTERS has an empty category selection (no Arco Saving default)", () => {
  assert.deepEqual(GIWA_EMPTY_FILTERS.category, [])
})
