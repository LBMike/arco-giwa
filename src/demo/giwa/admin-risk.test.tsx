import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { categoryOptionLabel } from "./RiskTag"
import snapshot from "./investor-shell/verification/deployed-giwa.snapshot.json"
import type { GiwaCatalogItem } from "./types"

// Vault Config shows operators the risk tier their category choice puts on the investor funds list.

const catalog = snapshot.catalog as unknown as GiwaCatalogItem[]
const byId = (id: string) => catalog.find((item) => item.productId === id)!

test("category options keep the bare value and name the tier", async () => {
  assert.equal(categoryOptionLabel("U.S Treasuries"), "U.S Treasuries · Low Risk")
  assert.equal(categoryOptionLabel("Prime Credit"), "Prime Credit · Medium Risk")
  assert.equal(categoryOptionLabel("Equity Exposure"), "Equity Exposure · High Risk")
  assert.equal(categoryOptionLabel("Arco Saving"), "Arco Saving · no risk tag")

  const { AddVaultCard } = await import("./AdminConfig")
  const html = renderToStaticMarkup(<AddVaultCard products={catalog} />)
  assert.match(html, /<option value="U\.S Treasuries"[^>]*>U\.S Treasuries · Low Risk<\/option>/)
  assert.match(html, /<option value="Prime Credit"[^>]*>Prime Credit · Medium Risk<\/option>/)
  assert.match(html, /<option value="Equity Exposure"[^>]*>Equity Exposure · High Risk<\/option>/)
  assert.match(html, /<option value="Arco Saving"[^>]*>Arco Saving · no risk tag<\/option>/)
})

test("with no override the hint shows the inherited tier", async () => {
  const { CustomerRiskHint } = await import("./AdminConfig")
  const usdc = renderToStaticMarkup(<CustomerRiskHint product={byId("umint")} category="" kind="product" />)
  assert.match(usdc, /data-risk="low"[^>]*>Low Risk</)
  assert.match(usdc, /inherited from U\.S Treasuries/)

  const credit = renderToStaticMarkup(<CustomerRiskHint product={byId("acapix")} category="" kind="product" />)
  assert.match(credit, /data-risk="medium"[^>]*>Medium Risk</)
  assert.match(credit, /inherited from Prime Credit/)
})

test("a chosen category sets the tier; saving vaults carry no tag", async () => {
  const { CustomerRiskHint } = await import("./AdminConfig")
  const equity = renderToStaticMarkup(<CustomerRiskHint product={byId("umint")} category="Equity Exposure" kind="product" />)
  assert.match(equity, /data-risk="high"[^>]*>High Risk</)
  assert.doesNotMatch(equity, /inherited/)

  const saving = renderToStaticMarkup(<CustomerRiskHint product={byId("arcousd")} category="U.S Treasuries" kind="saving" />)
  assert.doesNotMatch(saving, /data-risk=/)
  assert.match(saving, /no risk tag/)
  assert.match(saving, /Savings page/)
})
