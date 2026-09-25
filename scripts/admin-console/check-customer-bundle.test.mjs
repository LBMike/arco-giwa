import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { adminSignals, inspectCustomerBundle, isAdminModule } from "./check-customer-bundle.mjs"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

const HASH = "AbCd12_-"
function bundle(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "customer-bundle-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const all = { "index.html": `<!doctype html><script type="module" src="/assets/index-${HASH}.js"></script>`, [`assets/index-${HASH}.js`]: "console.log('customer')", ...files }
  for (const [name, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return dir
}
const rules = (dist, options = {}) => inspectCustomerBundle({ dist, ...options }).violations.map((violation) => violation.rule)

test("admin signals come from admin modules only and cover every admin area", () => {
  const { markers, names } = adminSignals()
  assert.ok(markers.every((marker) => isAdminModule(marker.module)))
  for (const area of [/^src\/admin\//, /^src\/demo\/giwa\/stocks-admin\//, /^src\/demo\/giwa\/stocks-trading-control\//, /^src\/demo\/giwa\/(?:Admin|VaultAdmin|PriceFeedAdminPanel)/]) {
    assert.ok(markers.some((marker) => area.test(marker.module)), `a marker from ${area}`)
  }
  for (const name of ["AdminOperations", "AdminPrices", "GiwaAdminLayout", "RequireGiwaAdmin", "StocksAdminPage", "AdminConsoleApp"]) assert.ok(names.has(name), name)
  for (const name of ["index", "types", "main"]) assert.equal(names.has(name), false, name)
  assert.equal(isAdminModule("src/demo/giwa/stocks-market/StocksPages.tsx"), false)
  assert.equal(isAdminModule("src/demo/giwa/AdminConsoleRedirect.tsx"), false)
})

test("a customer bundle without admin code passes", (t) => {
  assert.deepEqual(rules(bundle(t, { [`assets/StocksPages-${HASH}.js`]: "export const page = 'Stocks'" })), [])
})

test("a chunk named after an admin module fails", (t) => {
  assert.deepEqual(rules(bundle(t, { [`assets/AdminOperations-${HASH}.js`]: "export {}" })), ["chunk name"])
})

test("admin copy inside any chunk fails", (t) => {
  const marker = adminSignals().markers.find((candidate) => !/["\\]/.test(candidate.text))
  assert.deepEqual(rules(bundle(t, { [`assets/vendor-${HASH}.js`]: `const copy = ${JSON.stringify(marker.text)}` })), ["admin copy"])
})

test("source maps: an admin module among the sources fails; customer sources pass", (t) => {
  // Vite writes each source relative to the map file; these bundles live outside the repository.
  const withMap = (sources) => {
    const dir = bundle(t, {})
    const relative = sources.map((file) => path.relative(path.join(dir, "assets"), path.join(ROOT, file)))
    fs.writeFileSync(path.join(dir, `assets/index-${HASH}.js.map`), JSON.stringify({ version: 3, sources: relative, mappings: "" }))
    return dir
  }
  assert.deepEqual(rules(withMap(["src/main.tsx", "node_modules/react/index.js"])), [])
  assert.deepEqual(rules(withMap(["src/main.tsx", "src/demo/giwa/stocks-admin/held.ts"])), ["source map"])
})

test("with a console address, the bundle has to contain it", (t) => {
  const url = "https://admin.example.test"
  assert.deepEqual(rules(bundle(t, {}), { consoleUrl: url }), ["console address"])
  assert.deepEqual(rules(bundle(t, { [`assets/index-${HASH}.js`]: `location.replace(${JSON.stringify(url)})` }), { consoleUrl: url }), [])
})

test("no build output is an error, not a pass", () => {
  assert.throws(() => inspectCustomerBundle({ dist: path.join(os.tmpdir(), "customer-bundle-missing") }), /npm run build/)
})
