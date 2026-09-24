import assert from "node:assert/strict"
import { createRequire, registerHooks } from "node:module"
import test from "node:test"

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

test("main Portfolio distinguishes confirmed empty holdings from failed or pending reads", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://fixture.invalid", pretendToBeVisual: true })
  const boundary = { wallet: { address: A, chainId: 91342, connect: async () => {} }, balance: async (_token: string, _wallet: string) => "0" }
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __giwaPortfolioTest: boundary }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/PortfolioPage.tsx")) {
      const code = specifier === "./wallet" ? "export const useGiwaWallet=()=>globalThis.__giwaPortfolioTest.wallet;"
        : specifier === "./contracts" ? "export const readShareSupply=async()=>({decimals:6}); export const readTokenBalance=(...args)=>globalThis.__giwaPortfolioTest.balance(...args);"
          : specifier === "./stocks-portfolio/StocksPortfolioSection" ? "export const StocksPortfolioSection=()=>null;" : null
      if (code) return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true }
    }
    return next(specifier, context)
  } })
  t.after(() => {
    hooks.deregister(); dom.window.close()
    for (const key of Object.keys(globals)) { const before = previous[key]; if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key) }
  })
  const { act } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { MemoryRouter } = await import("react-router-dom")
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
  const { default: Portfolio } = await import("./PortfolioPage")
  const { giwaApi, normalizeCatalog } = await import("./api")
  const { default: snapshot } = await import("./investor-shell/verification/deployed-giwa.snapshot.json")
  const products = normalizeCatalog(snapshot.catalog).slice(0, 1)
  assert.equal(products.length, 1)
  const before = { ...giwaApi }
  t.after(() => Object.assign(giwaApi, before))
  // Catalog completion enables the holdings query, which then enables history.
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  function reset() {
    boundary.wallet.address = A; boundary.balance = async () => "0"
    giwaApi.catalog = async () => products
    giwaApi.market = async () => [{ productId: products[0]!.productId, navBase: 1, navUsd: 1, baseUsd: 1, apy: 5, impliedApy: null }]
    giwaApi.priceHistory = async (_chain, productId) => ({ productId, apy: 5, points: [] })
    giwaApi.activity = async () => []
    giwaApi.redemptions = async () => []
  }
  async function mount() {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const render = async () => { await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Portfolio /></MemoryRouter></QueryClientProvider>)); await settle() }
    const click = async (name: string) => {
      const button = [...element.querySelectorAll("button")].find(button => button.textContent === name)
      assert.ok(button, `Missing ${name}`); await act(async () => button.click()); await settle()
    }
    await render()
    return { element, render, click, text: () => element.textContent ?? "", async close() { await act(async () => root.unmount()); client.clear(); element.remove() } }
  }

  await t.test("catalog loading and failure cannot display a confirmed zero; Refresh recovers", async () => {
    reset(); const pending = deferred<ReturnType<typeof normalizeCatalog>>()
    giwaApi.catalog = () => pending.promise
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/); assert.doesNotMatch(m.text(), /\$0|No Savings or Funds holdings/)
      await act(async () => pending.resolve(products)); await settle()
      assert.match(m.text(), /No Savings or Funds holdings yet/)
      giwaApi.catalog = async () => { throw new Error("private transport detail") }
      await m.render()
      await m.click("Refresh")
      assert.match(m.text(), /Holdings could not be loaded/); assert.doesNotMatch(m.text(), /\$0|No Savings or Funds holdings|private transport/)
      giwaApi.catalog = async () => products
      await m.render()
      await m.click("Refresh")
      assert.match(m.text(), /No Savings or Funds holdings yet/)
    } finally { await m.close() }
  })

  await t.test("RPC failure is not zero holdings; successful retry and full remount re-read the wallet", async () => {
    reset(); let count = 0
    boundary.balance = async () => { count++; throw new Error("RPC unavailable") }
    const m = await mount()
    try {
      assert.match(m.text(), /Holdings could not be loaded/); assert.doesNotMatch(m.text(), /\$0|No Savings or Funds holdings/)
      boundary.balance = async () => { count++; return "0" }
      await m.click("Refresh")
      assert.match(m.text(), /No Savings or Funds holdings yet/)
    } finally { await m.close() }
    const reads = count
    const reloaded = await mount()
    try { assert.ok(count > reads); assert.match(reloaded.text(), /No Savings or Funds holdings yet/) }
    finally { await reloaded.close() }
  })

  await t.test("price failure keeps the confirmed holding and hides unconfirmed valuation", async () => {
    reset(); boundary.balance = async () => "2"
    giwaApi.market = async () => { throw new Error("market unavailable") }
    const m = await mount()
    try {
      assert.match(m.text(), /Current valuations are unavailable/)
      assert.doesNotMatch(m.text(), /No Savings or Funds holdings|\$0/)
      assert.ok(m.text().includes(`2 ${products[0]!.symbol}`), m.text())
    } finally { await m.close() }
  })

  await t.test("Activity needs both streams; a failed stream never appears as no activity", async () => {
    reset(); giwaApi.redemptions = async () => { throw new Error("redemptions unavailable") }
    const m = await mount()
    try {
      await m.click("Activity")
      assert.match(m.text(), /Activity could not be loaded/); assert.doesNotMatch(m.text(), /No indexed activity/)
      giwaApi.redemptions = async () => []
      await m.click("Refresh")
      assert.match(m.text(), /No indexed activity yet/)
    } finally { await m.close() }
  })

  await t.test("wallet B never displays a delayed holdings response for A", async () => {
    reset(); const pending = deferred<string>()
    boundary.balance = async (_token, wallet) => wallet === A ? pending.promise : "0"
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/)
      boundary.wallet.address = B; await m.render()
      assert.match(m.text(), /No Savings or Funds holdings yet/)
      await act(async () => pending.resolve("123")); await settle()
      assert.match(m.text(), /No Savings or Funds holdings yet/); assert.doesNotMatch(m.text(), /123/)
    } finally { await m.close() }
  })
})
