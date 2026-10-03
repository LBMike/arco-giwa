import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaStrategyCards, GIWA_EMPTY_FILTERS } from "./components"
import { vaultConfigOf } from "./catalog"
import { VAULT_CATEGORIES } from "../../../shared/vault-taxonomy"
import { DIGIFT_REFERENCE_ASSETS } from "./digift-reference-assets"
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

test("Strategies section shows the three risk cards and HIDES Arco Saving", () => {
  const products = [
    vault("acapix", "aCAPIX", "Prime Credit"),
    vault("beqty", "bEQTY", "Equity Exposure"),
    vault("abtc", "aBTC", "Arco Saving", "tBTC"), // an Arco Saving vault is present but its card stays hidden
  ]
  const html = renderToStaticMarkup(<GiwaStrategyCards products={products} active={[]} onToggle={() => undefined} />)

  // Cards are named by risk tier; each sentence says which product types the tier covers.
  for (const text of [
    ">Low Risk<",
    ">Medium Risk<",
    ">High Risk<",
    "U.S. Treasury and cash management funds.",
    "Prime credit and income strategies.",
    "Equity exposure and alternative assets.",
  ]) {
    assert.ok(html.includes(text), text)
  }
  assert.ok(html.includes(">0 Products<"), "no U.S. Treasuries vault here")
  assert.equal((html.match(/>1 Product</g) ?? []).length, 2) // aCAPIX, bEQTY

  // Arco Saving is hidden from the investor Strategies section (no card, title or count).
  assert.doesNotMatch(html, /Arco Saving/)
})

test("risk cards read Low, Medium, High left to right and count DigiFT products of the same tier", () => {
  const products = [
    vault("umint", "auMINT", "U.S Treasuries"),
    vault("ibenji", "aiBENJI", "U.S Treasuries"),
    vault("acapix", "aCAPIX", "Prime Credit"),
    vault("beqty", "bEQTY", "Equity Exposure"),
  ]
  const html = renderToStaticMarkup(
    <GiwaStrategyCards products={products} referenceAssets={DIGIFT_REFERENCE_ASSETS} active={[]} onToggle={() => undefined} />,
  )
  const low = html.indexOf(">Low Risk<")
  const medium = html.indexOf(">Medium Risk<")
  const high = html.indexOf(">High Risk<")
  assert.ok(low >= 0 && medium > low && high > medium, "Low → Medium → High")
  // 2 GIWA + CMBMINT, ULTRA, TKStable | aCAPIX + CMBBOND | bEQTY + JX, kTW50, GOLDX
  const five = html.indexOf(">5 Products<")
  const two = html.indexOf(">2 Products<")
  const four = html.indexOf(">4 Products<")
  assert.ok(five > low && five < medium, "Low Risk counts 5")
  assert.ok(two > medium && two < high, "Medium Risk counts 2")
  assert.ok(four > high, "High Risk counts 4")
  assert.doesNotMatch(html, /Strategies ·|High Yield|Equity Income/)
})

test("GIWA_EMPTY_FILTERS has an empty category selection (no Arco Saving default)", () => {
  assert.deepEqual(GIWA_EMPTY_FILTERS.category, [])
})
