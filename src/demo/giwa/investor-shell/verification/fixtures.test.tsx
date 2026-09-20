import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { ASSET_MANAGERS, ISSUERS, productById } from "../../../data/products"
import { hasDeploymentAddresses, normalizeCatalog } from "../../api"
import { REQUIRED_PAYMENT_ASSET_BY_PRODUCT, vaultConfigOf } from "../../catalog"
import { fundsProductsOf, homeSavingsSummary } from "../../home"
import { marketApyText } from "../../price-policy"
import { buildSavingsAccounts } from "../../savings"
import { isVaultCategory } from "../../../../../shared/vault-taxonomy"
import {
  PREVIEW_CATALOG,
  PREVIEW_FEATURED,
  PREVIEW_FUND_IDS,
  PREVIEW_MARKET,
  PREVIEW_SAVINGS_SYMBOLS,
  previewLegacyReply,
  previewPriceHistory,
} from "./fixtures"

// The preview's GIWA fixtures must pass the app's own parsers, so the preview shows what the app would show for the
// same server answer. The page itself runs only in a browser (see README.md); its route tree is checked from source.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const NOW = Date.parse("2026-09-19T12:00:00.000Z")
const WALLET = "0x1111111111111111111111111111111111111111"
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const catalog = () => normalizeCatalog(wire(PREVIEW_CATALOG))

test("catalog fixture passes normalizeCatalog; every product is addressed, fully configured and not a legacy product id", () => {
  const products = catalog()
  assert.equal(products.length, 9)
  assert.equal(new Set(products.map((product) => product.productId)).size, products.length)
  assert.equal(new Set(products.map((product) => product.symbol)).size, products.length)
  const configKeys = Object.keys(vaultConfigOf({ vaultConfig: null })).sort()
  for (const product of products) {
    assert.ok(hasDeploymentAddresses(product), product.productId)
    assert.ok(product.paymentAsset, product.productId)
    assert.deepEqual(Object.keys(product.vaultConfig ?? {}).sort(), configKeys, product.productId)
    assert.ok(isVaultCategory(vaultConfigOf(product).category), product.productId)
    // A legacy id would pull real manager/issuer names and aCAPIX content from src/demo/data into the page.
    assert.equal(productById(product.productId), undefined, product.productId)
    assert.equal(product.productId in REQUIRED_PAYMENT_ASSET_BY_PRODUCT, false, product.productId)
  }
})

test("fund/savings split matches fundsProductsOf and buildSavingsAccounts", () => {
  const products = catalog()
  const funds = fundsProductsOf(products)
  assert.deepEqual(funds.map((product) => product.productId), PREVIEW_FUND_IDS)
  assert.deepEqual(new Set(funds.map((product) => vaultConfigOf(product).category)), new Set(["U.S Treasuries", "Prime Credit", "Equity Exposure"]))
  assert.ok(funds.some((product) => vaultConfigOf(product).pinned))
  assert.ok(products.some((product) => vaultConfigOf(product).hidden && vaultConfigOf(product).kind === "product"), "a hidden fund exercises the Funds filter")

  const fundIds = new Set(funds.map((product) => product.productId))
  assert.ok(PREVIEW_FEATURED.length >= 1 && PREVIEW_FEATURED.length <= 2)
  for (const card of PREVIEW_FEATURED) {
    assert.ok(card.shown, card.id)
    assert.ok(fundIds.has(card.productId), card.id)
  }
  assert.deepEqual(PREVIEW_FEATURED.map((card) => card.position), [...PREVIEW_FEATURED.map((card) => card.position)].sort((a, b) => a - b))

  const accounts = buildSavingsAccounts(products, [...wire(PREVIEW_MARKET)])
  assert.deepEqual(accounts.map((account) => account.symbol), PREVIEW_SAVINGS_SYMBOLS)
  assert.deepEqual(accounts.filter((account) => account.disabled).map((account) => account.symbol), ["pEUR"])
  assert.equal(products.filter((product) => vaultConfigOf(product).kind === "saving").length, 3)
  for (const account of accounts.filter((entry) => !entry.disabled)) {
    assert.equal(vaultConfigOf(account.vault!).kind, "saving", account.symbol)
    assert.notEqual(account.apy, "—", account.symbol)
  }
  const summary = homeSavingsSummary(products, [...wire(PREVIEW_MARKET)])
  assert.equal(summary.accounts.length, 3)
  assert.equal(summary.comingSoon, 1)
})

test("market and price-history fixtures: one entry per product, resolvable APY, weekly posts in unix seconds", () => {
  const products = catalog()
  assert.deepEqual(PREVIEW_MARKET.map((entry) => entry.productId).sort(), products.map((product) => product.productId).sort())
  for (const entry of PREVIEW_MARKET) {
    assert.notEqual(marketApyText(entry), "—", entry.productId)
    assert.ok(Math.abs((entry.navUsd ?? 0) - (entry.navBase ?? 0) * (entry.baseUsd ?? 0)) < 1e-6, entry.productId)
  }
  assert.ok(PREVIEW_MARKET.some((entry) => entry.apy === null && entry.impliedApy !== null), "one fund shows the implied-APY path")

  for (const entry of PREVIEW_MARKET) {
    const history = previewPriceHistory(entry.productId, NOW)
    assert.ok(history, entry.productId)
    assert.equal(history.productId, entry.productId)
    assert.equal(history.apy, entry.apy)
    assert.equal(history.points.length, 9)
    const times = history.points.map((point) => point.t)
    assert.deepEqual(times, [...times].sort((a, b) => a - b))
    assert.equal(times[times.length - 1], Math.floor(NOW / 1000) - 3600)
    assert.equal(times[0], Math.floor(NOW / 1000) - 3600 - 56 * 86_400)
    assert.equal(history.points[history.points.length - 1]?.navBase, entry.navBase)
  }
  assert.equal(previewPriceHistory("not-a-product", NOW), null)
})

test("reply router answers only the listed GET reads and leaves everything else to the page to block", () => {
  const ok = (path: string) => {
    const reply = previewLegacyReply("GET", path, NOW)
    assert.equal(reply?.status, 200, path)
    return reply!.body
  }
  assert.deepEqual(ok("/api/v1/evm/catalog/91342"), PREVIEW_CATALOG)
  assert.deepEqual(ok("/api/v1/evm/catalog/91342?cache=no"), PREVIEW_CATALOG)
  assert.deepEqual(ok("/api/v1/evm/market/91342"), PREVIEW_MARKET)
  assert.deepEqual(ok("/api/v1/evm/featured/91342"), { cards: PREVIEW_FEATURED })
  assert.deepEqual(ok("/api/v1/evm/market/91342/preview-tsy-a/history"), previewPriceHistory("preview-tsy-a", NOW))
  assert.deepEqual(ok(`/api/v1/activity/${WALLET}`), [])
  assert.deepEqual(ok(`/api/v1/redemptions/${WALLET}`), [])
  assert.equal(previewLegacyReply("GET", "/api/v1/evm/market/91342/unknown/history", NOW)?.status, 404)
  assert.equal(previewLegacyReply("GET", "/api/v1/activity/not-a-wallet", NOW)?.status, 400)
  for (const [method, path] of [
    ["POST", "/api/v1/evm/catalog/91342"],
    ["GET", "/api/v1/evm/catalog/1"],
    ["GET", "/api/v1/evm/registry/91342"],
    ["GET", `/api/v1/portfolio/${WALLET}`],
    ["GET", `/api/v1/faucet/${WALLET}/status`],
    ["GET", "/api/v1/admin/featured/91342"],
    ["POST", "/api/v1/auth/nonce"],
    ["GET", "/"],
  ] as const) {
    assert.equal(previewLegacyReply(method, path, NOW), null, `${method} ${path}`)
  }
})

test("no fixture text names a real issuer, manager or fund house", () => {
  const strings: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === "object") Object.values(value).forEach(walk)
  }
  walk([PREVIEW_CATALOG, PREVIEW_MARKET, PREVIEW_FEATURED, PREVIEW_MARKET.map((entry) => previewPriceHistory(entry.productId, NOW))])
  const legacy = [...Object.values(ASSET_MANAGERS), ...Object.values(ISSUERS)].map((entry) => entry.label).filter((label) => label !== "Arco")
  const guarded = [
    "BlackRock", "Ondo", "Franklin", "Circle", "Tether", "Vanguard", "Fidelity", "JPMorgan", "J.P. Morgan", "Goldman", "Securitize",
    "Paxos", "Ripple", "WisdomTree", "Superstate", "Hashnote", "Apollo", "Hamilton Lane", "KKR", "Invesco", "State Street", "PIMCO",
    "Schwab", "Aksia", "UBS", "DigiFT", ...legacy,
  ]
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  for (const name of guarded) {
    const pattern = new RegExp(`\\b${escape(name)}\\b`, "i")
    for (const text of strings) assert.doesNotMatch(text, pattern, `"${text}" names ${name}`)
  }
  for (const product of PREVIEW_CATALOG) {
    const config = vaultConfigOf(product)
    for (const label of [config.displayName, config.issuerName, config.assetManagerName, product.name]) assert.match(label ?? "", /preview/i, product.productId)
  }
})

test("preview route tree mirrors the investor routes of src/main.tsx with the same page modules", () => {
  const app = read("../../../../main.tsx")
  const preview = read("./main.tsx")
  const investorBranch = (source: string) => {
    const start = source.indexOf("path: GIWA_PREPROD_ROUTE,")
    assert.ok(start > 0)
    return source.slice(start, source.indexOf("],", start))
  }
  const lazyModules = (source: string) =>
    new Map([...source.matchAll(/const (\w+) = lazy\(\(\) => import\((['"])([^'"]+)\2\)/g)].map((match) => [match[1]!, match[3]!.split("/").pop()!]))
  // Children of the GIWA_PREPROD_ROUTE branch only (the admin console branch is not part of the preview).
  const children = (source: string) =>
    new Map([...investorBranch(source).matchAll(/\{ (?:index: true|path: (['"])([^'"]+)\1), element: giwaRoute\(<(\w+) \/>\) \}/g)].map((match) => [match[2] ?? "(index)", match[3]!]))
  const appChildren = children(app)
  const previewChildren = children(preview)
  assert.deepEqual([...previewChildren.keys()], ["(index)", "funds", "savings", "portfolio", "product/:id"])
  assert.deepEqual([...previewChildren], [...appChildren].filter(([path]) => previewChildren.has(path)))
  assert.deepEqual([...appChildren.keys()].filter((path) => !previewChildren.has(path)), [], "every investor child route of src/main.tsx is in the preview")
  const appModules = lazyModules(app)
  const previewModules = lazyModules(preview)
  for (const name of ["GiwaPreprodApp", "GiwaPreprodProviders", ...previewChildren.values()]) {
    assert.ok(appModules.has(name), name)
    assert.equal(previewModules.get(name), appModules.get(name), name)
  }
  for (const source of [app, preview]) {
    assert.match(source, /\.\.\.stocksRoutes\(giwaRoute\(<GiwaPreprodApp \/>\)\)/)
    assert.match(source, /path: GIWA_PREPROD_ROUTE,\s*element: giwaRoute\(<GiwaPreprodApp \/>\)/)
    assert.match(source, /\{ path: (['"])\*\1, element: <Navigate to=\{GIWA_PREPROD_ROUTE\} replace \/> \}/)
  }
  assert.match(preview, /createHashRouter\(/)
  assert.doesNotMatch(preview, /createBrowserRouter|createMemoryRouter/)
  assert.match(preview, /<GiwaPreprodProviders>\s*<StocksPageEnvironment\.Provider value=\{environment\}>\s*<RouterProvider router=\{router\} \/>/)
})

test("preview installs the fetch guard before rendering and loads product pages only lazily", () => {
  const preview = read("./main.tsx")
  const guard = preview.indexOf("window.fetch = guardedFetch")
  assert.ok(guard > 0)
  assert.ok(guard < preview.indexOf("createRoot("))
  assert.ok(guard < preview.indexOf("lazy(() => import("))
  const staticImports = [...preview.matchAll(/^import (?!type )[^\n]*?(?:from )?"([^"]+)"$/gm)].map((match) => match[1]!)
  assert.deepEqual(staticImports.sort(), [
    "../../../../index.css",
    "../../../theme.css",
    "../../config",
    "../../routes",
    "../../stocks-market/environment",
    "../../stocks-market/fixtures",
    "../../stocks-market/routes",
    "./deployed",
    "./fixtures",
    "react",
    "react-dom/client",
    "react-router-dom",
  ])
  const fixtures = read("./fixtures.ts")
  assert.deepEqual([...fixtures.matchAll(/^import (?!type )/gm)], [], "fixtures.ts has type-only imports")
})

test("nothing in the app entry, router or build config references the preview; product code never imports it", () => {
  for (const path of ["../../../../../index.html", "../../../../../vite.config.ts", "../../../../main.tsx", "../../routes.ts", "../../stocks-market/routes.tsx"]) {
    assert.doesNotMatch(read(path), /investor-shell/, path)
  }
  const src = fileURLToPath(new URL("../../../../", import.meta.url))
  const here = fileURLToPath(new URL("./", import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}${name}`
      if (statSync(path).isDirectory()) {
        if (`${path}/` !== here) walk(`${path}/`)
      } else if (/\.(tsx?|mjs|css|html)$/.test(name) && /investor-shell\/verification/.test(readFileSync(path, "utf8"))) offenders.push(path)
    }
  }
  walk(src)
  assert.deepEqual(offenders, [])
})
