import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaCatalogTable } from "./components"
import { DIGIFT_REFERENCE_ASSETS } from "./digift-reference-assets"
import snapshot from "./investor-shell/verification/deployed-giwa.snapshot.json"
import type { GiwaCatalogItem } from "./types"

// Every funds-list row shows a coloured risk tag on the left and the product type on the right.
// The tier follows the product's category, so it matches that category's Strategies card.

const catalog = snapshot.catalog as unknown as GiwaCatalogItem[]
const funds = catalog.filter((item) => item.vaultConfig?.kind === "product")
const arcoSaving = catalog.find((item) => item.productId === "arcousd")!

function render(rows: GiwaCatalogItem[], withReferences = true) {
  return renderToStaticMarkup(
    <GiwaCatalogTable
      rows={rows}
      referenceRows={withReferences ? DIGIFT_REFERENCE_ASSETS : []}
      selectedProductId=""
      sortKey="aum"
      sortDir="desc"
      onSelect={() => undefined}
    />,
  )
}

function pair(level: string, label: string, type: string): RegExp {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`data-risk="${level}"[^>]*>${label}</span><span[^>]*>${escaped}</span>`, "g")
}

test("GIWA fund rows: risk tag first, then the product type", () => {
  assert.deepEqual(funds.map((item) => item.productId).sort(), ["acapix", "beqty", "ibenji", "umint"])
  const html = render(funds, false)
  assert.equal((html.match(pair("low", "Low Risk", "U.S. Treasuries")) ?? []).length, 2) // auMINT, aiBENJI
  assert.equal((html.match(pair("medium", "Medium Risk", "Prime Credit")) ?? []).length, 1) // aCAPIX
  assert.equal((html.match(pair("high", "High Risk", "Equity Exposure")) ?? []).length, 1) // bEQTY
  assert.equal((html.match(/data-risk=/g) ?? []).length, 4)
})

test("DigiFT rows: risk tag mapped from the DigiFT category", () => {
  const html = render([], true)
  assert.equal((html.match(pair("low", "Low Risk", "Cash Management")) ?? []).length, 3) // CMBMINT, ULTRA, TKStable
  assert.equal((html.match(pair("medium", "Medium Risk", "Income Strategies")) ?? []).length, 1) // CMBBOND
  assert.equal((html.match(pair("high", "High Risk", "Equity Exposure")) ?? []).length, 2) // JX, kTW50
  assert.equal((html.match(pair("high", "High Risk", "Alternative Assets")) ?? []).length, 1) // GOLDX
  assert.equal((html.match(/data-risk=/g) ?? []).length, 7)
})

test("risk tags use the theme tokens, one tone per tier", () => {
  const html = render(funds, true)
  for (const level of ["low", "medium", "high"]) {
    assert.match(html, new RegExp(`data-risk="${level}" class="[^"]*bg-\\[var\\(--color-risk-${level}-bg\\)\\] text-\\[var\\(--color-risk-${level}-ink\\)\\]`))
  }
})

test("an Arco Saving row gets no risk tag", () => {
  assert.equal(arcoSaving.vaultConfig?.category, "Arco Saving")
  const html = render([arcoSaving], false)
  assert.doesNotMatch(html, /data-risk=/)
})
