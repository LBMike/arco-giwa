// The REAL /stocks route (router, StocksPage, host provider, investor feature, execution provider, wallet panel,
// wallet controller, wallet-source ports, execution reads and submission client) in React DOM + StrictMode, against
// the TEST-ONLY in-process Stocks server (real server plugins over memory SQL) and the fake EIP-1193 wallet over the
// shared fake chain. No socket, database, public network, key or signature.
//
// Gated like stocks-wallet-ui/panel.dom.test.tsx: set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json.
// jsdom globals are installed BEFORE react-dom, react-router-dom and the page modules are imported (dynamic imports
// inside the gated body); static imports here are type-only apart from node:test/assert/module.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"

import type { ActiveWalletSource } from "../stocks-wallet-source"
import type { ExecutionClockSeam } from "./StocksExecutionProvider"
import type { FakeEip1193Wallet } from "./testing/fake-wallet"
import type { InProcessStocks } from "./testing/in-process-stocks"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
/**
 * One wallet per scenario. The investor module keeps accepted order attempts in a module-level registry keyed by API base,
 * deployment and wallet (it survives a remount on purpose), and every harness has the same API base and deployment.
 */
const walletFor = (scenario: number, prefix: "a" | "b" = "a") => `0x${"0".repeat(36)}${prefix}${scenario.toString(16).padStart(3, "0")}`
const READ_METHODS = new Set(["eth_chainId", "eth_accounts", "eth_getBlockByNumber", "eth_call"])
const READY_COPY = "입금·매도 예치는 수락된 주문 카드에서 진행합니다"
const SESSION_COPY = "입금·매도 예치는 주문한 지갑으로 Stocks에 로그인한 뒤 진행할 수 있습니다."
const UNSUPPORTED_COPY = "현재 연결된 지갑 방식은 거래 요청을 한 번만 보내도록 보장할 수 없어"
const SESSION_NOTICE = "A wallet request from your last Stocks session may still be open or recorded"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("real /stocks page drives the wallet execution host end to end (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t: TestContext) => {
  // The harness module has no DOM dependency; it only provides the frontend origin before jsdom is created.
  const { createInProcessStocks, HARNESS_FRONTEND_ORIGIN } = (await import("./testing/in-process-stocks")) as typeof import("./testing/in-process-stocks")
  const { createFakeEip1193Wallet } = (await import("./testing/fake-wallet")) as typeof import("./testing/fake-wallet")

  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: HARNESS_FRONTEND_ORIGIN, pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent, InputEvent: w.InputEvent, CustomEvent: w.CustomEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  /** Cleanups of the running scenario, run last-in first-out when it ends (pages unmount before their server closes). */
  let cleanups: (() => unknown)[] = []
  /** Scenario 2's page and server, kept for scenario 4. */
  let shared: (() => unknown)[] = []
  const runCleanups = async (list: (() => unknown)[]) => {
    for (const cleanup of list.reverse()) await cleanup()
  }
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { createMemoryRouter, RouterProvider, Outlet } = (await import("react-router-dom")) as AnyModule
    const { stocksRoutes } = (await import("../stocks-market/routes")) as AnyModule
    const { StocksPageEnvironment } = (await import("../stocks-market/StocksPages")) as AnyModule
    const { StocksHostProvider } = (await import("../stocks-host/StocksHostProvider")) as AnyModule
    const { encodeFunctionData, getAddress, parseAbi } = (await import("viem")) as AnyModule
    const { act, createElement: h, StrictMode } = React
    const CALLS = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function depositForOrder(bytes32 orderKey,uint256 amount)", "function escrowForOrder(bytes32 orderKey,address token,uint256 quantity)"])

    // ---------------------------------------------------------------- helpers

    /** The running scenario's wallet (see walletFor). */
    let WALLET_A = walletFor(0)
    const inputValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!

    type Page = Awaited<ReturnType<typeof mount>>

    async function mount(harness: InProcessStocks, options: { wallet: FakeEip1193Wallet | null; address: string; epoch: string; source?: ActiveWalletSource; clock?: ExecutionClockSeam }) {
      const element = document.createElement("div")
      document.body.append(element)
      const root = createRoot(element)
      const router = createMemoryRouter(stocksRoutes(h(Outlet)), { initialEntries: ["/stocks"] })
      const dependencies = harness.signInDependencies()
      let view = { address: options.address, epoch: options.epoch, source: options.source ?? ({ mode: "injected", provider: options.wallet } as ActiveWalletSource) }
      // Stable identities: a new function or clock object would be another execution identity.
      const environment = { apiBase: harness.apiBase, fetch: harness.fetch, executionClock: options.clock, activeWalletSource: () => view.source }
      const tree = () =>
        h(StrictMode, null,
          h(StocksHostProvider, { context: { walletAddress: view.address, chainId: 91342, frontendOrigin: harness.frontendOrigin, apiBase: harness.apiBase, walletEpoch: view.epoch }, dependencies, walletSource: view.source },
            h(StocksPageEnvironment.Provider, { value: environment }, h(RouterProvider, { router }))))
      await act(async () => {
        root.render(tree())
        await sleep(0)
      })
      let mounted = true
      const page = {
        element,
        text: () => element.textContent ?? "",
        async rerender(next: Partial<typeof view>) {
          view = { ...view, ...next }
          await act(async () => {
            root.render(tree())
            await sleep(0)
          })
        },
        async unmount() {
          if (!mounted) return
          mounted = false
          await act(async () => root.unmount())
          router.dispose()
          element.remove()
        },
        async waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
          const end = Date.now() + timeoutMs
          for (;;) {
            const value = read()
            if (value) return value
            if (Date.now() > end) throw new Error(`timed out waiting for ${label}; panel=${page.panelStatus()} text=${page.text().slice(0, 1500)}`)
            await act(async () => sleep(15))
          }
        },
        async settle(ms: number) {
          await act(async () => sleep(ms))
        },
        buttons: (scope: ParentNode = element) => [...scope.querySelectorAll("button")] as HTMLButtonElement[],
        button(label: string | RegExp, scope: ParentNode = element): HTMLButtonElement | null {
          return page.buttons(scope).find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""))) ?? null
        },
        async click(target: HTMLElement | null, label = "button") {
          assert.ok(target, `missing ${label}`)
          await act(async () => {
            target.click()
            await sleep(0)
          })
        },
        panel: () => element.querySelector<HTMLElement>('[data-testid="stocks-wallet-panel"]'),
        panelStatus: () => page.panel()?.dataset.status ?? null,
        action: (name: "prepare" | "approve" | "submit") => element.querySelector<HTMLButtonElement>(`[data-testid="stocks-wallet-panel"] button[data-action="${name}"]`),
        hash: () => element.querySelector('[data-testid="stocks-wallet-tx-hash"]')?.textContent ?? null,
        capability: () => element.querySelector('[data-testid="stocks-execution-capability"]')?.textContent ?? "",
        async waitStatus(status: string, timeoutMs = 10_000) {
          await page.waitFor(() => page.panelStatus() === status, `panel status ${status}`, timeoutMs)
        },
        async signIn() {
          await page.waitFor(() => page.button("Sign in to Stocks") && !page.button("Sign in to Stocks")!.disabled, "sign-in button")
          await page.click(page.button("Sign in to Stocks"), "Sign in to Stocks")
          await page.waitFor(() => page.text().includes("Signed in to Stocks."), "signed in")
          await page.waitFor(() => element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "investor session")
        },
        async placeOrder(side: "BUY" | "SELL", quantity = "1") {
          await page.waitFor(() => element.querySelector('button[aria-label="View NVDA"]'), "catalog")
          await page.click(element.querySelector('button[aria-label="View NVDA"]'), "View NVDA")
          const input = await page.waitFor(() => element.querySelector<HTMLInputElement>('input[inputmode="decimal"]'), "quantity input")
          if (side === "SELL") await page.click(element.querySelector('[data-side="SELL"]'), "Sell side")
          await act(async () => {
            inputValue.call(input, quantity)
            input.dispatchEvent(new w.Event("input", { bubbles: true }))
          })
          await page.waitFor(() => page.button("Get quote") && !page.button("Get quote")!.disabled, "Get quote enabled")
          await page.click(page.button("Get quote"), "Get quote")
          const place = side === "SELL" ? "Place sell order" : "Place buy order"
          await page.waitFor(() => page.button(place) && !page.button(place)!.disabled, place)
          await page.click(page.button(place), place)
          return page.waitFor(() => element.querySelector<HTMLElement>('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), "accepted order card")
        },
        /** Check → APPROVAL_REQUIRED; the approve button is disabled until armed, then enabled. */
        async checkToApproval() {
          await page.click(page.action("prepare"), "Check order")
          await page.waitStatus("APPROVAL_REQUIRED")
          const shownAt = performance.now()
          assert.equal(page.action("approve")?.disabled, true, "a wallet-opening button is not armed on first paint")
          await page.waitFor(() => page.action("approve") && !page.action("approve")!.disabled, "approve armed", 3_000)
          // Real timers: the default 800 ms arming delay (the first observation may lag the paint by one 15 ms poll).
          assert.ok(performance.now() - shownAt >= 700, `armed after ${Math.round(performance.now() - shownAt)} ms`)
        },
      }
      cleanups.push(() => page.unmount())
      return page
    }

    const methodCounts = (wallet: FakeEip1193Wallet) => wallet.calls.reduce<Record<string, number>>((counts, call) => ({ ...counts, [call.method]: (counts[call.method] ?? 0) + 1 }), {})
    const sends = (wallet: FakeEip1193Wallet) => wallet.callsOf("eth_sendTransaction").length
    const forbiddenSends = (wallet: FakeEip1193Wallet) => wallet.calls.filter((call) => call.method === "wallet_sendTransaction" || call.method === "eth_sendRawTransaction").length
    const requestsTo = (harness: InProcessStocks, method: string, pattern: RegExp) => harness.requests.filter((entry) => entry.method === method && pattern.test(entry.path))
    const bodies = (harness: InProcessStocks, pattern: RegExp) => requestsTo(harness, "POST", pattern).map((entry) => JSON.parse(entry.body ?? "null") as Row)
    const EXECUTION_PATHS = /^\/api\/v1\/stocks\/(execution|wallet-submissions)\//

    async function setup(address = WALLET_A) {
      const harness = await createInProcessStocks()
      cleanups.push(() => harness.close())
      const wallet = createFakeEip1193Wallet(harness.chain, { account: getAddress(address) })
      return { harness, wallet }
    }

    function orderRow(harness: InProcessStocks, side: "BUY" | "SELL", wallet: string): Row {
      const rows = (harness.sql.snapshot() as unknown as Record<string, Row[]>)[side === "BUY" ? "StocksOrder" : "StocksSellOrder"]!.filter((row) => String(row.wallet).toLowerCase() === wallet.toLowerCase())
      assert.ok(rows.length > 0, `no ${side} order row`)
      return rows[rows.length - 1]!
    }

    function expectedTransactions(harness: InProcessStocks, side: "BUY" | "SELL", order: Row, from: string) {
      const m = harness.manifest
      if (side === "BUY") {
        return {
          approval: { from: getAddress(from), to: getAddress(m.cashToken), data: encodeFunctionData({ abi: CALLS, functionName: "approve", args: [getAddress(m.fundingVault), BigInt(order.cashAmount)] }), value: "0x0" },
          transfer: { from: getAddress(from), to: getAddress(m.fundingVault), data: encodeFunctionData({ abi: CALLS, functionName: "depositForOrder", args: [order.orderKey, BigInt(order.cashAmount)] }), value: "0x0" },
        }
      }
      return {
        approval: { from: getAddress(from), to: getAddress(m.stockToken), data: encodeFunctionData({ abi: CALLS, functionName: "approve", args: [getAddress(m.redemptionEscrow), BigInt(order.quantity)] }), value: "0x0" },
        transfer: { from: getAddress(from), to: getAddress(m.redemptionEscrow), data: encodeFunctionData({ abi: CALLS, functionName: "escrowForOrder", args: [order.orderKey, getAddress(m.stockToken), BigInt(order.quantity)] }), value: "0x0" },
      }
    }

    function normalizeTx(params: unknown) {
      const [tx] = params as [Row]
      return { from: getAddress(tx.from), to: getAddress(tx.to), data: String(tx.data).toLowerCase(), value: tx.value }
    }
    const lowerData = <T extends { data: string }>(tx: T) => ({ ...tx, data: tx.data.toLowerCase() })

    /** Approve → server claim/outcome/reconcile → READY_TRANSFER, asserting exactly one wallet transaction request. */
    async function approveToReadyTransfer(page: Page, harness: InProcessStocks, wallet: FakeEip1193Wallet, expected: { approval: Row }) {
      const before = harness.requests.length
      await page.click(page.action("approve"), "Approve")
      await page.waitStatus("READY_TRANSFER", 15_000)
      assert.equal(sends(wallet), 1)
      assert.deepEqual(normalizeTx(wallet.callsOf("eth_sendTransaction")[0]!.params), lowerData(expected.approval as { data: string }))
      const after = harness.requests.slice(before)
      const claims = after.filter((entry) => entry.method === "POST" && entry.path === "/api/v1/stocks/wallet-submissions/claims").map((entry) => JSON.parse(entry.body!))
      const outcomes = after.filter((entry) => entry.method === "POST" && entry.path === "/api/v1/stocks/wallet-submissions/outcomes").map((entry) => JSON.parse(entry.body!))
      const reconciles = after.filter((entry) => entry.method === "POST" && entry.path === "/api/v1/stocks/wallet-submissions/reconcile").map((entry) => JSON.parse(entry.body!))
      assert.deepEqual(claims.map((body) => body.stage), ["APPROVAL"])
      assert.deepEqual(outcomes.map((body) => [body.stage, body.status]), [["APPROVAL", "SUBMITTED"]])
      assert.equal(reconciles.length, 1)
      assert.equal(reconciles[0].stage, "APPROVAL")
      assert.equal(outcomes[0].txHash, reconciles[0].txHash)
      return outcomes[0].txHash as string
    }

    // ---------------------------------------------------------------- scenarios

    /** A numbered scenario with its own wallet and a last-in first-out cleanup stack. */
    const scenario = (name: string, fn: (t2: TestContext) => Promise<void>) =>
      t.test(name, async (t2) => {
        WALLET_A = walletFor(Number.parseInt(name, 10))
        cleanups = []
        try {
          await fn(t2)
        } finally {
          await runCleanups(cleanups)
          cleanups = []
        }
      })

    await scenario("1. mount and sign-in issue no wallet request and no execution request; READY copy only after sign-in", async () => {
      const { harness, wallet } = await setup()
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:1" })
      await page.waitFor(() => page.button("Sign in to Stocks"), "sign-in button")
      await page.waitFor(() => page.element.querySelector('button[aria-label="View NVDA"]'), "catalog")
      assert.ok(page.capability().startsWith(SESSION_COPY), page.capability())
      assert.ok(!page.capability().includes(READY_COPY))
      await page.click(page.element.querySelector('button[aria-label="View NVDA"]'), "View NVDA")
      await page.settle(50)
      assert.equal(page.element.querySelector('[data-testid="stocks-order-execution"]'), null)
      assert.equal(page.panel(), null)
      assert.equal(page.element.querySelector('[data-testid="stocks-order-card"]'), null)

      await page.signIn()
      await page.waitFor(() => page.capability().startsWith(READY_COPY), "READY capability copy")
      await page.settle(300)
      assert.equal(wallet.calls.length, 0, "no wallet request of any kind")
      assert.equal(harness.requests.filter((entry) => EXECUTION_PATHS.test(entry.path)).length, 0, "no execution, deployment, policy or wallet-submission request")
      assert.deepEqual(harness.requests.filter((entry) => entry.method === "POST").map((entry) => entry.path), ["/api/v1/auth/nonce", "/api/v1/auth/verify"])
      assert.equal(page.panel(), null)
      assert.equal(wallet.listenerCount("accountsChanged") > 0, true, "the capture subscribes to provider events (no request)")
    })

    let buyScenario: { harness: InProcessStocks; wallet: FakeEip1193Wallet; page: Page; order: Row } | null = null

    await scenario("2. BUY: accept, check (one evidence read), approve once, server reconcile, separate deposit", async () => {
      const harness = await createInProcessStocks()
      cleanups.push(() => harness.close())
      const wallet = createFakeEip1193Wallet(harness.chain, { account: getAddress(WALLET_A) })
      harness.seedCash(WALLET_A, 1_000_000_000n)
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:2" })
      await page.signIn()
      const card = await page.placeOrder("BUY")
      const order = orderRow(harness, "BUY", WALLET_A)
      assert.equal(order.state, "AWAITING_FUNDING")
      await page.waitFor(() => card.querySelector('[data-testid="stocks-order-execution"] [data-testid="stocks-wallet-panel"]'), "execution panel in accepted card")
      assert.equal(page.panelStatus(), "IDLE")
      assert.ok(page.panel()!.textContent!.includes("Not checked yet"))
      assert.equal(page.action("prepare")?.disabled, false)
      assert.ok(card.textContent!.includes("Funding required") && !card.textContent!.includes("not available in this app yet"))
      assert.equal(wallet.calls.length, 0, JSON.stringify(wallet.calls))
      assert.equal(harness.requests.filter((entry) => EXECUTION_PATHS.test(entry.path)).length, 0)

      await page.checkToApproval()
      assert.equal(requestsTo(harness, "GET", /^\/api\/v1\/stocks\/execution\/deployment$/).length, 1, "exactly one evidence read")
      assert.ok(wallet.calls.every((call) => READ_METHODS.has(call.method)), JSON.stringify(methodCounts(wallet)))
      assert.equal(wallet.callsOf("eth_call").length, 1, "one allowance read")
      assert.equal(sends(wallet), 0)
      assert.equal(bodies(harness, /wallet-submissions\/(claims|outcomes|reconcile)$/).length, 0, "a check claims nothing")

      const expected = expectedTransactions(harness, "BUY", order, WALLET_A)
      const approvalHash = await approveToReadyTransfer(page, harness, wallet, expected)
      assert.equal(harness.chain.allowance(harness.manifest.cashToken, WALLET_A, harness.manifest.fundingVault), BigInt(order.cashAmount))
      // Never deposits on its own.
      const deployments = requestsTo(harness, "GET", /\/execution\/deployment$/).length
      await page.settle(2_500)
      assert.equal(sends(wallet), 1, "READY_TRANSFER never sends automatically")
      assert.equal(page.panelStatus(), "READY_TRANSFER")
      assert.equal(requestsTo(harness, "GET", /\/execution\/deployment$/).length, deployments, "no evidence polling")
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).filter((body) => body.stage === "TRANSFER").length, 0)

      await page.waitFor(() => page.action("submit") && !page.action("submit")!.disabled, "deposit armed", 3_000)
      await page.click(page.action("submit"), "Deposit")
      await page.waitStatus("SUBMITTED", 15_000)
      assert.equal(sends(wallet), 2)
      assert.deepEqual(normalizeTx(wallet.callsOf("eth_sendTransaction")[1]!.params), lowerData(expected.transfer))
      const transferOutcome = bodies(harness, /wallet-submissions\/outcomes$/).filter((body) => body.stage === "TRANSFER")
      assert.deepEqual(transferOutcome.map((body) => body.status), ["SUBMITTED"])
      assert.equal(page.hash(), transferOutcome[0]!.txHash)
      assert.notEqual(page.hash(), approvalHash)
      assert.ok(page.panel()!.textContent!.includes("The transaction hash is not the order result."))
      assert.equal(forbiddenSends(wallet), 0)
      assert.ok(Object.keys(methodCounts(wallet)).every((method) => READ_METHODS.has(method) || method === "eth_sendTransaction"), JSON.stringify(methodCounts(wallet)))
      buyScenario = { harness, wallet, page, order }
      // Kept for scenario 4, which closes them.
      shared = cleanups
      cleanups = []
    })

    await scenario("4. a server status refresh keeps the pinned selection, the SUBMITTED hash and makes no wallet request", async () => {
      assert.ok(buyScenario, "scenario 2 must pass first")
      const { harness, wallet, page, order } = buyScenario
      try {
        const hash = page.hash()
        const calls = wallet.calls.length
        await harness.setOrderState("BUY", order.id, "BROKER_PENDING")
        const card = page.element.querySelector<HTMLElement>('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]')!
        const refresh = page.button("Refresh status", card)
        await page.click(refresh, "card Refresh status")
        await page.waitFor(() => page.panel()?.textContent?.includes("server status: Broker processing"), "server status label in panel")
        assert.equal(page.panelStatus(), "SUBMITTED")
        assert.equal(page.hash(), hash)
        assert.ok(!page.panel()!.textContent!.includes("Not checked yet"))
        assert.equal(page.action("submit"), null)
        await page.settle(500)
        assert.equal(wallet.calls.length, calls, "no new wallet request")
        assert.equal(sends(wallet), 2)
      } finally {
        await runCleanups(shared)
        shared = []
      }
    })

    await scenario("3. SELL via the Orders tab: select, check, approve stock units, escrow", async () => {
      const { harness, wallet } = await setup()
      harness.seedStock(WALLET_A, "3000000000")
      await harness.createOrder("SELL", harness.session(WALLET_A))
      const order = orderRow(harness, "SELL", WALLET_A)
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:3" })
      await page.signIn()
      await page.click(page.element.querySelector('#giwa-stocks-tab-orders'), "Orders tab")
      await page.waitFor(() => page.button("Refresh") && !page.button("Refresh")!.disabled, "orders loaded")
      await page.click(page.button("Refresh"), "Refresh orders")
      const row = await page.waitFor(() => page.buttons().find((b) => b.textContent?.startsWith("Sell") && b.textContent.includes("NVDA")), "sell order row")
      assert.equal(wallet.calls.length, 0, JSON.stringify(wallet.calls))
      await page.click(row, "sell row")
      const card = await page.waitFor(() => page.element.querySelector<HTMLElement>('[data-testid="stocks-order-card"]'), "selected card")
      await page.waitFor(() => card.querySelector('[data-testid="stocks-wallet-panel"]'), "panel in selected card")
      assert.ok(card.textContent!.includes(order.id))
      assert.equal(page.panelStatus(), "IDLE")
      assert.equal(wallet.calls.length, 0, JSON.stringify(wallet.calls))

      await page.checkToApproval()
      assert.equal(requestsTo(harness, "GET", /\/execution\/deployment$/).length, 1)
      assert.equal(sends(wallet), 0)
      const expected = expectedTransactions(harness, "SELL", order, WALLET_A)
      await approveToReadyTransfer(page, harness, wallet, expected)
      assert.equal(harness.chain.allowance(harness.manifest.stockToken, WALLET_A, harness.manifest.redemptionEscrow), BigInt(order.quantity))
      await page.waitFor(() => page.action("submit") && !page.action("submit")!.disabled, "escrow armed", 3_000)
      assert.ok(page.action("submit")!.textContent!.startsWith("Escrow"))
      await page.click(page.action("submit"), "Escrow")
      await page.waitStatus("SUBMITTED", 15_000)
      assert.equal(sends(wallet), 2)
      assert.deepEqual(normalizeTx(wallet.callsOf("eth_sendTransaction")[1]!.params), lowerData(expected.transfer))
      assert.deepEqual(bodies(harness, /wallet-submissions\/outcomes$/).map((body) => [body.stage, body.status]), [["APPROVAL", "SUBMITTED"], ["TRANSFER", "SUBMITTED"]])
      assert.ok(page.hash())
      assert.equal(forbiddenSends(wallet), 0)
    })

    await scenario("5. duplicate activation: a double click and repeated keyboard activation each open one wallet request", async () => {
      const { harness, wallet } = await setup()
      harness.seedCash(WALLET_A, 1_000_000_000n)
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:5" })
      await page.signIn()
      await page.placeOrder("BUY")
      await page.waitFor(() => page.action("prepare"), "panel")
      await page.checkToApproval()
      const approve = page.action("approve")!
      await act(async () => {
        approve.click()
        approve.click()
        await sleep(0)
      })
      await page.waitStatus("READY_TRANSFER", 15_000)
      assert.equal(sends(wallet), 1, "double click opened one approval request")
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).length, 1)

      await page.waitFor(() => page.action("submit") && !page.action("submit")!.disabled, "deposit armed", 3_000)
      const deposit = page.action("submit")!
      await act(async () => {
        deposit.focus()
        for (let i = 0; i < 3; i++) {
          for (const key of ["Enter", " "]) {
            deposit.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
            // A browser turns Enter/Space on a focused button into a click; jsdom does not, so the click is dispatched.
            deposit.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
            deposit.dispatchEvent(new w.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
          }
        }
        await sleep(0)
      })
      await page.waitStatus("SUBMITTED", 15_000)
      await page.settle(1_200)
      assert.equal(sends(wallet), 2, "repeated keyboard activation opened one deposit request")
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).filter((body) => body.stage === "TRANSFER").length, 1)
      assert.equal(forbiddenSends(wallet), 0)
    })

    await scenario("6. an open approval prompt keeps SIGNING when evidence and policy end; the late hash is kept without reconcile", async () => {
      const { harness, wallet } = await setup()
      harness.seedCash(WALLET_A, 1_000_000_000n)
      let offset = 0
      const clock: ExecutionClockSeam = Object.freeze({ now: () => Date.now() + offset, monotonicNow: () => performance.now() + offset })
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:6", clock })
      await page.signIn()
      await page.placeOrder("BUY")
      await page.waitFor(() => page.action("prepare"), "panel")
      await page.checkToApproval()
      const hold = wallet.holdNext("eth_sendTransaction")
      await page.click(page.action("approve"), "Approve")
      await act(async () => {
        await hold.arrived
      })
      await page.waitStatus("SIGNING")
      const reconcilesBefore = requestsTo(harness, "POST", /wallet-submissions\/reconcile$/).length
      offset = 16_000
      await page.settle(1_500) // display ticks re-read the context with the advanced clock
      assert.equal(page.panelStatus(), "SIGNING")
      assert.ok(page.panel()!.textContent!.includes("Confirm in your wallet"))
      assert.equal(sends(wallet), 1)

      await act(async () => {
        hold.release()
        await sleep(0)
      })
      await page.waitStatus("APPROVAL_SUBMITTED")
      await page.waitFor(() => page.hash(), "approval hash")
      await page.settle(1_000)
      const outcomes = bodies(harness, /wallet-submissions\/outcomes$/)
      assert.deepEqual(outcomes.map((body) => [body.stage, body.status]), [["APPROVAL", "SUBMITTED"]])
      assert.equal(page.hash(), outcomes[0]!.txHash)
      const panelText = page.panel()!.textContent!
      assert.ok(panelText.includes("EXECUTION_AUTHORITY_CHANGED"), panelText)
      assert.ok(panelText.includes("The deployment review expired or was renewed during this step"), panelText)
      assert.equal(requestsTo(harness, "POST", /wallet-submissions\/reconcile$/).length, reconcilesBefore, "no reconcile after the late answer")
      assert.equal(page.panelStatus(), "APPROVAL_SUBMITTED")
      assert.equal(page.action("submit"), null, "no deposit button")
      assert.ok(page.buttons(page.panel()!).filter((b) => b.dataset.action === "submit" || b.dataset.action === "approve").every((b) => b.disabled))
      assert.equal(sends(wallet), 1)
      assert.equal(forbiddenSends(wallet), 0)
    })

    await scenario("7. an account switch during an open prompt never shows A's attempt to B; A's late outcome still reaches A's gate", async () => {
      const { harness, wallet } = await setup()
      harness.seedCash(WALLET_A, 1_000_000_000n)
      const walletB = createFakeEip1193Wallet(harness.chain, { account: getAddress(walletFor(7, "b")) })
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:7" })
      await page.signIn()
      await page.placeOrder("BUY")
      const order = orderRow(harness, "BUY", WALLET_A)
      await page.waitFor(() => page.action("prepare"), "panel")
      await page.checkToApproval()
      const hold = wallet.holdNext("eth_sendTransaction")
      await page.click(page.action("approve"), "Approve")
      await act(async () => {
        await hold.arrived
      })
      await page.waitStatus("SIGNING")

      const leaks: string[] = []
      const observer = new w.MutationObserver(() => {
        if (page.text().includes(order.id)) leaks.push("order id")
        if (page.panel()) leaks.push("panel")
        if (page.element.querySelector('[data-testid="stocks-order-card"]')) leaks.push("order card")
      })
      observer.observe(page.element, { subtree: true, childList: true, characterData: true, attributes: true })
      await page.rerender({ address: walletFor(7, "b"), epoch: "injected:b:1", source: { mode: "injected", provider: walletB } })
      await page.settle(300)
      assert.ok(!page.text().includes(order.id))
      assert.equal(page.panel(), null)
      assert.ok(page.text().includes("Not signed in"))

      await act(async () => {
        hold.release()
        await sleep(0)
      })
      await page.waitFor(() => bodies(harness, /wallet-submissions\/outcomes$/).length > 0, "A's outcome recorded")
      await page.settle(500)
      observer.disconnect()
      const outcomes = bodies(harness, /wallet-submissions\/outcomes$/)
      assert.deepEqual(outcomes.map((body) => [body.stage, body.status]), [["APPROVAL", "SUBMITTED"]])
      const submitted = (harness.sql.snapshot() as unknown as Record<string, Row[]>).StocksWalletSubmission!
      assert.deepEqual(submitted.map((row) => [String(row.wallet).toLowerCase(), row.status, row.txHash]), [[WALLET_A.toLowerCase(), "SUBMITTED", outcomes[0]!.txHash]])
      assert.equal(leaks.length, 0, `B's page never painted A's order, card or panel: ${leaks.join()}`)
      assert.ok(!page.text().includes(outcomes[0]!.txHash))
      assert.equal(walletB.calls.length, 0, "B's wallet received nothing")
      assert.equal(sends(wallet), 1)
      assert.equal(requestsTo(harness, "POST", /wallet-submissions\/reconcile$/).length, 0)
      assert.ok(!page.text().includes(SESSION_NOTICE), "the session notice is for the same wallet only")
    })

    await scenario("8. sign-out during an open prompt shows the session notice, no order data, and one send", async () => {
      const { harness, wallet } = await setup()
      harness.seedCash(WALLET_A, 1_000_000_000n)
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:8" })
      await page.signIn()
      await page.placeOrder("BUY")
      const order = orderRow(harness, "BUY", WALLET_A)
      await page.waitFor(() => page.action("prepare"), "panel")
      await page.checkToApproval()
      const hold = wallet.holdNext("eth_sendTransaction")
      await page.click(page.action("approve"), "Approve")
      await act(async () => {
        await hold.arrived
      })
      await page.waitStatus("SIGNING")
      await page.click(page.button("Sign out of Stocks"), "Sign out of Stocks")
      await page.waitFor(() => page.text().includes(SESSION_NOTICE), "session notice")
      assert.equal(page.panel(), null)
      assert.equal(page.element.querySelector('[data-testid="stocks-order-card"]'), null)
      assert.ok(!page.text().includes(order.id))
      assert.ok(!page.text().includes(order.orderKey))

      await act(async () => {
        hold.release()
        await sleep(0)
      })
      await page.settle(1_000)
      assert.equal(sends(wallet), 1)
      assert.equal(forbiddenSends(wallet), 0)
      assert.ok(page.text().includes(SESSION_NOTICE))
      assert.equal(page.panel(), null)
      const hash = harness.chain.transactions[harness.chain.transactions.length - 1]?.hash
      assert.ok(hash && !page.text().includes(hash))
      // The late answer still goes to the signed-out session's own gate (its server token is still valid).
      await page.waitFor(() => bodies(harness, /wallet-submissions\/outcomes$/).length > 0, "late outcome recorded")
      assert.deepEqual(bodies(harness, /wallet-submissions\/outcomes$/).map((body) => [body.stage, body.status, body.txHash]), [["APPROVAL", "SUBMITTED", hash]])
      assert.equal(requestsTo(harness, "POST", /wallet-submissions\/reconcile$/).length, 0)

      // Review HL-3: a later session for the same wallet that ends without a wallet request clears the notice.
      await page.signIn()
      assert.ok(!page.text().includes(SESSION_NOTICE), "hidden while signed in")
      await page.click(page.button("Sign out of Stocks"), "Sign out of Stocks")
      await page.settle(300)
      assert.ok(!page.text().includes(SESSION_NOTICE), "the notice does not come back after a session without a wallet request")
      assert.equal(sends(wallet), 1)
    })

    await scenario("9. a Dynamic source is unsupported: unsupported copy, status-only card, zero client access and zero wallet requests", async () => {
      const { harness, wallet } = await setup()
      const accessed: string[] = []
      const record = (trap: string) => (...args: unknown[]) => {
        accessed.push(`${trap}:${String(args[1] ?? "")}`)
        return (Reflect as AnyModule)[trap](...args)
      }
      const traps = ["get", "set", "has", "ownKeys", "getOwnPropertyDescriptor", "defineProperty", "deleteProperty", "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions", "apply", "construct"]
      const client = new Proxy(wallet, Object.fromEntries(traps.map((trap) => [trap, record(trap)])))
      const page = await mount(harness, { wallet: null, address: WALLET_A, epoch: "dynamic:a:9", source: { mode: "dynamic", client } })
      // Review HL-4: a Dynamic source is unsupported before sign-in too, so nobody is told to sign in for it.
      await page.waitFor(() => page.capability().startsWith(UNSUPPORTED_COPY), "unsupported copy before sign-in")
      await page.signIn()
      await page.waitFor(() => page.capability().startsWith(UNSUPPORTED_COPY), "unsupported capability copy")
      const card = await page.placeOrder("BUY")
      await page.settle(300)
      assert.ok(card.textContent!.includes("Funding required — not available in this app yet"))
      assert.equal(page.element.querySelector('[data-testid="stocks-order-execution"]'), null)
      assert.equal(page.panel(), null)
      assert.equal(accessed.length, 0, `the Dynamic client object was never touched: ${accessed.join()}`)
      assert.equal(wallet.calls.length, 0, JSON.stringify(wallet.calls))
      assert.equal(harness.requests.filter((entry) => EXECUTION_PATHS.test(entry.path)).length, 0)
    })

    await scenario("10. a remount during a held approval shows the reserved claim as recovery, never re-sends, and later shows the recorded approval", async (t2) => {
      const { harness, wallet } = await setup()
      harness.seedCash(WALLET_A, 1_000_000_000n)
      const first = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:10" })
      await first.signIn()
      await first.placeOrder("BUY")
      const order = orderRow(harness, "BUY", WALLET_A)
      await first.waitFor(() => first.action("prepare"), "panel")
      await first.checkToApproval()
      const hold = wallet.holdNext("eth_sendTransaction")
      await first.click(first.action("approve"), "Approve")
      await act(async () => {
        await hold.arrived
      })
      await first.waitStatus("SIGNING")
      await first.unmount()

      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:10" })
      await page.waitFor(() => page.element.querySelector('button[aria-label="View NVDA"]'), "catalog")
      await page.click(page.element.querySelector('button[aria-label="View NVDA"]'), "View NVDA")
      await page.settle(200)
      assert.ok(!page.text().includes(order.id), "no order before sign-in")
      assert.equal(page.element.querySelector('[data-testid="stocks-order-card"]'), null)
      assert.equal(page.panel(), null)
      await page.signIn()
      // The investor module keeps the accepted attempt for the same actor, deployment and API across a remount.
      const card = await page.waitFor(() => page.element.querySelector<HTMLElement>('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), "accepted order card after sign-in")
      assert.ok(card.textContent!.includes(order.id))
      await page.waitFor(() => page.panelStatus() === "IDLE", "IDLE panel for the reopened order")
      const deployments = requestsTo(harness, "GET", /\/execution\/deployment$/).length
      await page.click(page.action("prepare"), "Check order")
      await page.waitStatus("UNKNOWN")
      assert.equal(requestsTo(harness, "GET", /\/execution\/deployment$/).length, deployments + 1)
      const unknownText = page.panel()!.textContent!
      assert.ok(unknownText.includes("Do not repeat it from another app or wallet"), unknownText)
      assert.equal(page.action("approve"), null)
      await page.settle(1_000)
      assert.equal(sends(wallet), 1, "the reopened page never sends")
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).length, 1)

      await act(async () => {
        hold.release()
        await sleep(0)
      })
      await page.waitFor(() => bodies(harness, /wallet-submissions\/outcomes$/).some((body) => body.status === "SUBMITTED"), "old request's outcome recorded")
      const hash = bodies(harness, /wallet-submissions\/outcomes$/).find((body) => body.status === "SUBMITTED")!.txHash
      await page.waitFor(() => page.action("prepare") && !page.action("prepare")!.disabled, "check again enabled")
      await page.click(page.action("prepare"), "Check again")
      await page.waitFor(() => ["APPROVAL_SUBMITTED", "READY_TRANSFER"].includes(page.panelStatus() ?? ""), "recorded approval shown", 15_000)
      t2.diagnostic(`status after recorded approval check: ${page.panelStatus()}`)
      if (page.panelStatus() === "APPROVAL_SUBMITTED") assert.equal(page.hash(), hash)
      else {
        const reconciles = bodies(harness, /wallet-submissions\/reconcile$/)
        assert.equal(reconciles[reconciles.length - 1]?.txHash, hash)
      }
      await page.settle(1_200)
      assert.equal(sends(wallet), 1, "total sends 1")
      assert.equal(forbiddenSends(wallet), 0)
    })
  } finally {
    await runCleanups(shared)
    await runCleanups(cleanups)
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
