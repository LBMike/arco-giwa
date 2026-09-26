import assert from "node:assert/strict"
import { createRequire, registerHooks } from "node:module"
import test from "node:test"

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
type Holding = { status: "loading" } | { status: "error" } | { status: "ready"; units: number; price: { value: number; changePct: number | null; at: number } | null; priceSettled: boolean; closes: { t: number; close: number }[] | null; closesSettled: boolean }
const NO_STOCKS: Holding = { status: "ready", units: 0, price: null, priceSettled: true, closes: null, closesSettled: true }
type StocksActivity = { status: "loading" } | { status: "error" } | { status: "ready"; entries: unknown[] }
const NO_TRADES: StocksActivity = { status: "ready", entries: [] }
const BUY = { side: "BUY", state: "COMPLETED", quantity: "498000000", cashAmount: "60000000", paymentTx: `0x${"ab".repeat(32)}`, settlementTx: null, createdAt: "2026-09-26T01:02:03.000Z" }

test("main Portfolio distinguishes confirmed empty holdings from failed or pending reads", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://fixture.invalid", pretendToBeVisual: true })
  const boundary = {
    wallet: { address: A, chainId: 91342, connect: async () => {} },
    balance: async (_token: string, _wallet: string) => "0",
    stocks: (_account: string | null): Holding => NO_STOCKS,
    stocksActivity: (_account: string | null): StocksActivity => NO_TRADES,
  }
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true, __giwaPortfolioTest: boundary }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/PortfolioPage.tsx")) {
      const code = specifier === "./wallet" ? "export const useGiwaWallet=()=>globalThis.__giwaPortfolioTest.wallet;"
        : specifier === "./contracts" ? "export const readShareSupply=async()=>({decimals:6}); export const readTokenBalance=(...args)=>globalThis.__giwaPortfolioTest.balance(...args);"
          : specifier === "./portfolio-stocks" ? "export const STOCK_DISPLAY={symbol:'NVDA',name:'NVIDIA Corporation',imageUrl:null}; export const useStocksHolding=account=>({holding:globalThis.__giwaPortfolioTest.stocks(account),fetching:false,refresh:async()=>{}}); export const useStocksActivity=account=>({activity:globalThis.__giwaPortfolioTest.stocksActivity(account),fetching:false,refresh:async()=>{}});" : null
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
  const catalog = normalizeCatalog(snapshot.catalog).filter(product => product.productTokenAddress)
  const products = catalog.slice(0, 1)
  assert.equal(products.length, 1)
  // One Savings vault and one Fund, by their configured kind.
  const saving = { ...catalog[0]!, vaultConfig: { ...catalog[0]!.vaultConfig, kind: "saving" } } as typeof catalog[number]
  const fund = { ...catalog[1]!, vaultConfig: { ...catalog[1]!.vaultConfig, kind: "product" } } as typeof catalog[number]
  assert.notEqual(saving.symbol, fund.symbol)
  const before = { ...giwaApi }
  t.after(() => Object.assign(giwaApi, before))
  // Catalog completion enables the holdings query, which then enables history.
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  function reset() {
    boundary.wallet.address = A; boundary.balance = async () => "0"; boundary.stocks = () => NO_STOCKS; boundary.stocksActivity = () => NO_TRADES
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
    const part = (id: string) => element.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
    return { element, render, click, part, text: () => element.textContent ?? "", async close() { await act(async () => root.unmount()); client.clear(); element.remove() } }
  }

  await t.test("catalog loading and failure cannot display a confirmed zero; Refresh recovers", async () => {
    reset(); const pending = deferred<ReturnType<typeof normalizeCatalog>>()
    giwaApi.catalog = () => pending.promise
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/); assert.doesNotMatch(m.text(), /\$0|No holdings yet/)
      await act(async () => pending.resolve(products)); await settle()
      assert.match(m.text(), /No holdings yet/)
      giwaApi.catalog = async () => { throw new Error("private transport detail") }
      await m.render()
      await m.click("Refresh")
      assert.match(m.text(), /Holdings could not be loaded/); assert.doesNotMatch(m.text(), /\$0|No holdings yet|private transport/)
      giwaApi.catalog = async () => products
      await m.render()
      await m.click("Refresh")
      assert.match(m.text(), /No holdings yet/)
    } finally { await m.close() }
  })

  await t.test("RPC failure is not zero holdings; successful retry and full remount re-read the wallet", async () => {
    reset(); let count = 0
    boundary.balance = async () => { count++; throw new Error("RPC unavailable") }
    const m = await mount()
    try {
      assert.match(m.text(), /Holdings could not be loaded/); assert.doesNotMatch(m.text(), /\$0|No holdings yet/)
      boundary.balance = async () => { count++; return "0" }
      await m.click("Refresh")
      assert.match(m.text(), /No holdings yet/)
    } finally { await m.close() }
    const reads = count
    const reloaded = await mount()
    try { assert.ok(count > reads); assert.match(reloaded.text(), /No holdings yet/) }
    finally { await reloaded.close() }
  })

  await t.test("price failure keeps the confirmed holding and hides unconfirmed valuation", async () => {
    reset(); boundary.balance = async () => "2"
    giwaApi.market = async () => { throw new Error("market unavailable") }
    const m = await mount()
    try {
      assert.match(m.text(), /Current valuations are unavailable/)
      assert.doesNotMatch(m.text(), /No holdings yet|\$0/)
      assert.ok(m.text().includes(`2 ${products[0]!.symbol}`), m.text())
      assert.equal(m.part("portfolio-allocation"), null, "no value tiles without current valuations")
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

  await t.test("Stocks trades are part of Activity; unread Stocks trades are said, and alone they are not 'no activity'", async () => {
    reset(); boundary.stocksActivity = () => ({ status: "ready", entries: [BUY] })
    const m = await mount()
    try {
      await m.click("Activity")
      assert.match(m.text(), /NVIDIA Corporation/); assert.match(m.text(), /Buy/); assert.match(m.text(), /0\.498 NVDA · 60 USDC/)
      assert.doesNotMatch(m.text(), /No indexed activity yet/)
      boundary.stocksActivity = () => ({ status: "error" })
      await m.render()
      assert.match(m.text(), /Activity could not be loaded/); assert.doesNotMatch(m.text(), /No indexed activity/)
      boundary.stocksActivity = () => ({ status: "loading" })
      await m.render()
      assert.match(m.text(), /Loading your activity/)
    } finally { await m.close() }
    reset(); boundary.stocksActivity = () => ({ status: "error" })
    giwaApi.activity = async () => [{ eventName: "ProductDeposit", txHash: "0xdeposit", blockNumber: 1, contractAddress: products[0]!.depositVaultAddress, blockTimestamp: "2026-09-25T00:00:00.000Z", args: { sharesOut: "1000000000000000000" } }] as never
    const partial = await mount()
    try {
      await partial.click("Activity")
      assert.match(partial.text(), /Stocks trades could not be loaded/)
      assert.match(partial.text(), /Deposit/)
    } finally { await partial.close() }
  })

  await t.test("wallet B never displays a delayed holdings response for A", async () => {
    reset(); const pending = deferred<string>()
    boundary.balance = async (_token, wallet) => wallet === A ? pending.promise : "0"
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/)
      boundary.wallet.address = B; await m.render()
      assert.match(m.text(), /No holdings yet/)
      await act(async () => pending.resolve("123")); await settle()
      assert.match(m.text(), /No holdings yet/); assert.doesNotMatch(m.text(), /123/)
    } finally { await m.close() }
  })

  await t.test("product views: Savings shows saving vaults, Funds the rest, All Portfolio both with each line's share", async () => {
    reset()
    giwaApi.catalog = async () => [saving, fund]
    giwaApi.market = async () => [
      { productId: saving.productId, navBase: 1, navUsd: 1, baseUsd: 1, apy: 5, impliedApy: null },
      { productId: fund.productId, navBase: 2, navUsd: 2, baseUsd: 1, apy: 8, impliedApy: null },
    ]
    boundary.balance = async (token) => token === saving.productTokenAddress ? "3" : "4"
    const m = await mount()
    try {
      assert.ok(m.text().includes(`3 ${saving.symbol}`) && m.text().includes(`4 ${fund.symbol}`), m.text())
      const tiles = m.part("portfolio-allocation") ?? ""
      assert.match(tiles, /Savings\$3\.0027\.27% · 1 holding/); assert.match(tiles, /Funds\$8\.0072\.73% · 1 holding/); assert.match(tiles, /Stocks\$0\.000% · No holdings/)
      await m.click("Savings")
      assert.ok(m.text().includes(`3 ${saving.symbol}`)); assert.ok(!m.text().includes(`4 ${fund.symbol}`))
      assert.equal(m.part("portfolio-allocation"), null)
      await m.click("Funds")
      assert.ok(!m.text().includes(`3 ${saving.symbol}`)); assert.ok(m.text().includes(`4 ${fund.symbol}`))
      await m.click("Stocks")
      assert.match(m.text(), /No Stocks holdings yet/); assert.match(m.text(), /Open Stocks/)
      await m.click("All Portfolio")
      assert.ok(m.text().includes(`3 ${saving.symbol}`) && m.text().includes(`4 ${fund.symbol}`))
    } finally { await m.close() }
  })

  await t.test("a pending or failed Stocks read is never a confirmed zero; a held NVDA is valued at the live price", async () => {
    reset(); boundary.stocks = () => ({ status: "loading" })
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/); assert.doesNotMatch(m.text(), /\$0|No holdings yet/)
      boundary.stocks = () => ({ status: "error" }); await m.render()
      assert.match(m.text(), /No Savings or Funds holdings yet/); assert.match(m.text(), /Stocks holdings could not be confirmed/); assert.doesNotMatch(m.text(), /\$0/)
      await m.click("Stocks")
      assert.match(m.text(), /Stocks holdings could not be loaded/)
      boundary.stocks = () => ({ status: "ready", units: 0.5, price: { value: 200, changePct: 1.5, at: Math.floor(Date.now() / 1000) }, priceSettled: true, closes: [], closesSettled: true })
      await m.render()
      assert.match(m.text(), /NVIDIA Corporation/); assert.ok(m.text().includes("0.5 NVDA"), m.text())
      assert.match(m.text(), /200\.00 \(\+1\.5%\)/); assert.match(m.text(), /\$100\.00/)
      assert.match(m.text(), /Net Worth\$100/)
      await m.click("All Portfolio")
      assert.match(m.part("portfolio-allocation") ?? "", /Stocks\$100\.00100% · 0\.5 NVDA/)
      // A held NVDA without a price keeps its units and never shows a value; while its first price read is in
      // flight the total is loading, not partial.
      boundary.stocks = () => ({ status: "ready", units: 0.5, price: null, priceSettled: true, closes: null, closesSettled: true })
      await m.render()
      assert.ok(m.text().includes("0.5 NVDA")); assert.doesNotMatch(m.text(), /\$100/); assert.match(m.text(), /Net Worth—/)
      boundary.balance = async () => "2"
      boundary.stocks = () => ({ status: "ready", units: 0.5, price: null, priceSettled: false, closes: null, closesSettled: false })
      await m.click("Refresh")
      assert.ok(m.text().includes(`2 ${products[0]!.symbol}`)); assert.match(m.text(), /Net Worth—/); assert.doesNotMatch(m.text(), /Partial/)
      boundary.stocks = () => ({ status: "ready", units: 0.5, price: null, priceSettled: true, closes: null, closesSettled: true })
      await m.render()
      assert.match(m.text(), /Net Worth\$2/); assert.match(m.text(), /Partial — some asset prices are unavailable/)
    } finally { await m.close() }
  })

  await t.test("Net Worth shows its change in dollars and percent over the chart's range", async () => {
    reset(); boundary.balance = async () => "10"
    const day = 86_400, now = Math.floor(Date.now() / 1000)
    giwaApi.priceHistory = async (_chain, productId) => ({ productId, apy: 5, points: [{ t: now - 10 * day, navBase: 1, navUsd: 1 }, { t: now - day, navBase: 1.1, navUsd: 1.1 }] })
    giwaApi.market = async () => [{ productId: products[0]!.productId, navBase: 1.1, navUsd: 1.1, baseUsd: 1, apy: 5, impliedApy: null }]
    const m = await mount()
    try {
      assert.equal(m.part("net-worth-change"), "+$1.00 (+10.00%) · All")
      assert.equal(m.text().split("+$1.00 (+10.00%) · All").length, 3, "the header and the chart headline agree")
      await m.click("7D")
      assert.equal(m.part("net-worth-change"), "$0.00 (0.00%) · 7D")
    } finally { await m.close() }
  })
})
