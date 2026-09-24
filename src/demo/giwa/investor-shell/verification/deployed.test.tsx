import assert from "node:assert/strict"
import test from "node:test"
import { normalizeCatalog } from "../../api"
import { fundsProductsOf } from "../../home"
import snapshot from "./deployed-giwa.snapshot.json"
import { deployedLegacyReply } from "./deployed"

test("preview uses the unmodified deployed catalog, market, cards and each captured history", () => {
  assert.deepEqual(deployedLegacyReply("GET", "/api/v1/evm/catalog/91342")?.body, snapshot.catalog)
  assert.deepEqual(deployedLegacyReply("GET", "/api/v1/evm/market/91342")?.body, snapshot.market)
  assert.deepEqual(deployedLegacyReply("GET", "/api/v1/evm/featured/91342")?.body, snapshot.featured)
  const funds = fundsProductsOf(normalizeCatalog(snapshot.catalog))
  assert.deepEqual(funds.map(p => p.productId).sort(), ["acapix", "beqty", "ibenji", "umint"])
  assert.ok(funds.every(p => !p.productId.startsWith("preview-")))
  for (const [id, body] of Object.entries(snapshot.history)) {
    assert.deepEqual(deployedLegacyReply("GET", `/api/v1/evm/market/91342/${id}/history`)?.body, body)
  }
})

test("missing data cannot become synthetic history or a transaction response", () => {
  for (const id of ["unknown", "preview-tsy-a", "__proto__", "constructor"]) {
    assert.equal(deployedLegacyReply("GET", `/api/v1/evm/market/91342/${id}/history`)?.status, 404)
  }
  assert.equal(deployedLegacyReply("GET", "/api/v1/evm/market/91342/%/history")?.status, 400)
  assert.equal(deployedLegacyReply("POST", "/api/v1/evm/catalog/91342"), null)
  assert.equal(deployedLegacyReply("GET", "/api/v1/evm/catalog/1"), null)
  assert.equal(deployedLegacyReply("GET", "/api/v1/auth/nonce"), null)
})
