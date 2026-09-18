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

import type { KnownHashStore } from "../stocks-known-hash-recovery/store"
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
const SESSION_NOTICE = "A wallet request from your last Stocks session may still be open or its answer unrecorded"
/** The whole notice as rendered (title and paragraphs concatenated by textContent). Any added promise changes it. */
const SESSION_NOTICE_TEXT = [
  SESSION_NOTICE,
  "If your wallet answered after that session ended, the server may not have recorded that answer, even if the transaction was sent.",
  "Sign in to Stocks again with the same wallet, open the order and check it. The check only shows what the server has already recorded. It cannot add a wallet answer the server never received.",
  "Do not send the approval, deposit or escrow again from this or any other app or wallet. If the check shows the result as unknown, or the order can no longer be checked, contact operations to confirm what happened.",
].join("")

/** 003D: the session-end notice when this tab kept a hash the original wallet request returned. */
const KEPT_NOTICE = "This tab kept a transaction hash the server may not have recorded"
const KEPT_NOTICE_TEXT = [
  KEPT_NOTICE,
  "Your wallet returned a transaction hash that an earlier Stocks session could not record, so this tab kept it. The server may not have it yet, even though the transaction was sent.",
  "Sign in to Stocks again with the same wallet in this tab and open the order. You can record the kept hash there; nothing is recorded or sent automatically. The hash is kept only in this tab's memory: reloading or closing the page loses it.",
  "Do not send the approval, deposit or escrow again from this or any other app or wallet. If the kept hash cannot be recorded, or the order still shows the result as unknown after you record it, contact operations to confirm what happened.",
].join("")

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("real /stocks page drives the wallet execution host end to end (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t: TestContext) => {
  // The harness module has no DOM dependency; it only provides the frontend origin before jsdom is created.
  const { createInProcessStocks, HARNESS_FRONTEND_ORIGIN } = (await import("./testing/in-process-stocks")) as typeof import("./testing/in-process-stocks")
  const { createFakeEip1193Wallet, providerError } = (await import("./testing/fake-wallet")) as typeof import("./testing/fake-wallet")
  const { createKnownHashStore } = (await import("../stocks-known-hash-recovery/store")) as typeof import("../stocks-known-hash-recovery/store")

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

    async function mount(harness: InProcessStocks, options: { wallet: FakeEip1193Wallet | null; address: string; epoch: string; source?: ActiveWalletSource; clock?: ExecutionClockSeam; sessionSeconds?: number; knownHashes?: KnownHashStore; fetch?: typeof globalThis.fetch }) {
      const element = document.createElement("div")
      document.body.append(element)
      const root = createRoot(element)
      const router = createMemoryRouter(stocksRoutes(h(Outlet)), { initialEntries: ["/stocks"] })
      const signIn = harness.signInDependencies()
      // A shorter session only rewrites the fixture verify response's expiresIn; the token and every other request are unchanged.
      const dependencies = options.sessionSeconds === undefined
        ? signIn
        : {
            ...signIn,
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const response = await signIn.fetch(input, init)
              if (!String(input).endsWith("/api/v1/auth/verify") || response.status !== 200) return response
              return new Response(JSON.stringify({ ...(await response.json()), expiresIn: options.sessionSeconds }), { status: 200, headers: { "content-type": "application/json" } })
            },
          }
      let view = { address: options.address, epoch: options.epoch, source: options.source ?? ({ mode: "injected", provider: options.wallet } as ActiveWalletSource) }
      // Stable identities: a new function or clock object would be another execution identity.
      // Each page gets its own kept-hash memory unless a scenario shares one on purpose (a real reload starts empty).
      const environment = { apiBase: harness.apiBase, fetch: options.fetch ?? harness.fetch, executionClock: options.clock, activeWalletSource: () => view.source, knownHashes: options.knownHashes ?? createKnownHashStore() }
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

    // Review 003B-1 (Codex P3), kept for the case WITHOUT a hash (003D): a 30 s session expires by time while the approval
    // prompt is open and the wallet then answers with an error, so there is no hash to keep. The original gate refuses the
    // UNKNOWN outcome before any request; a new session's check only reads the journal (reserved claim, no hash) and shows
    // UNKNOWN; nothing offers recovery. One send in total.
    const noticeElement = (page: Page) => [...page.element.querySelectorAll("p")].find((p) => p.textContent?.startsWith("A wallet request from your last Stocks session"))?.parentElement ?? null
    const keptNotice = (page: Page) => [...page.element.querySelectorAll("p")].find((p) => p.textContent === KEPT_NOTICE)?.parentElement ?? null
    const recoveryCard = (page: Page) => page.element.querySelector<HTMLElement>('[data-testid="stocks-known-hash-recovery"]')
    function assertSessionNoticeMeaning(notice: HTMLElement, secrets: string[]) {
      const text = notice.textContent ?? ""
      // No promise that checking or signing in records, attaches or restores the late answer.
      assert.doesNotMatch(text, /until (?:that|the|this|you) check/i, text)
      assert.doesNotMatch(text, /\bcheck(?:ing)?\s+(?:will\s+|can\s+|may\s+|does\s+)?(?:record|attach|restore|recover|add|save|match)/i, text)
      assert.doesNotMatch(text, /sign(?:ing)? in again\s+(?:will\s+|to\s+)?(?:record|attach|restore|recover)/i, text)
      assert.doesNotMatch(text, /will be recorded|is recorded (?:when|after|once)|gets recorded|\b(?:attach|restor|recover|retriev|resend|retry|re-?submit)/i, text)
      // What it must say instead: the request is on the server, its late answer may not be; checking cannot add the answer;
      // never repeat (unconditionally); operations for an unknown or no longer checkable result.
      assert.match(text, /server may not have recorded that answer, even if the transaction was sent/i, text)
      assert.match(text, /check only shows what the server has already recorded/i, text)
      assert.match(text, /cannot add a wallet answer the server never received/i, text)
      assert.match(text, /(?:^|\.)\s*Do not send the approval, deposit or escrow again from this or any other app or wallet\./, text)
      assert.match(text, /if the check shows the result as unknown, or the order can no longer be checked, contact operations/i, text)
      // Nothing to click and nothing about the order: no link, button, number, amount, order or hash.
      assert.equal(notice.querySelectorAll("a, button").length, 0, "no link or button in the notice")
      assert.doesNotMatch(text, /\d/, text)
      for (const secret of secrets) assert.ok(!text.includes(secret), `notice leaks ${secret}`)
      // And exactly this copy: a reworded promise the patterns above miss still fails here.
      assert.equal(text, SESSION_NOTICE_TEXT)
    }

    const expiredSessionNoHash = (side: "BUY" | "SELL") => async () => {
      let offset = 0
      const wall = () => Date.now() + offset
      // One stable seam for the page: the host session, the execution clocks and the server fixture read the same shifted wall.
      const clock: ExecutionClockSeam = { now: wall, monotonicNow: () => performance.now() + offset }
      const harness = await createInProcessStocks({ wall })
      cleanups.push(() => harness.close())
      const wallet = createFakeEip1193Wallet(harness.chain, { account: getAddress(WALLET_A) })
      if (side === "BUY") harness.seedCash(WALLET_A, 1_000_000_000n)
      else harness.seedStock(WALLET_A, "3000000000")
      const sendsAt: Record<string, number> = {}
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: `injected:a:${side}`, clock, sessionSeconds: 30 })
      sendsAt.mount = sends(wallet)
      await page.signIn()
      sendsAt.signIn = sends(wallet)
      await page.placeOrder(side)
      const order = orderRow(harness, side, WALLET_A)
      await page.waitFor(() => page.action("prepare"), "panel")
      sendsAt.accepted = sends(wallet)
      await page.checkToApproval()
      sendsAt.check = sends(wallet)
      const hold = wallet.holdNext("eth_sendTransaction")
      await page.click(page.action("approve"), "Approve")
      await act(async () => {
        await hold.arrived
      })
      await page.waitStatus("SIGNING")
      sendsAt.approve = sends(wallet)
      const approvals = () =>
        ((harness.sql.snapshot() as unknown as Record<string, Row[]>).StocksWalletSubmission ?? [])
          .filter((row) => String(row.wallet).toLowerCase() === WALLET_A.toLowerCase() && row.stage === "APPROVAL")
          .map((row) => [row.status, row.txHash ?? null])
      assert.deepEqual(approvals(), [["REQUEST_MAY_START", null]], "one reserved claim while the prompt is open")

      // The session expires by time with the prompt open; the page re-reads the host snapshot on the next render.
      offset += 31_000
      await page.rerender({})
      await page.waitFor(() => page.text().includes("Your Stocks session expired. Sign in again."), "expired session")
      await page.waitFor(() => noticeElement(page), "session notice")
      assert.ok(page.panel() === null)
      assert.ok(page.element.querySelector('[data-testid="stocks-order-card"]') === null)

      const applied = harness.chain.transactions.length
      await act(async () => {
        hold.reject(providerError(4001, "User rejected the request."))
        await sleep(0)
      })
      await page.settle(1_000)
      assert.equal(harness.chain.transactions.length, applied, "the wallet answered with an error: no transaction, no hash")
      assert.equal(bodies(harness, /wallet-submissions\/outcomes$/).length, 0, "the expired session's gate refuses the late UNKNOWN before any request")
      assert.deepEqual(approvals(), [["REQUEST_MAY_START", null]], "the server journal has no hash")
      assert.ok(keptNotice(page) === null, "no hash was kept, so the kept-hash notice never shows")
      // Re-query after the refused answer: the notice is still mounted, not a detached node from before.
      const notice = noticeElement(page)
      assert.ok(notice && page.element.contains(notice), "the notice is still shown after the late answer was refused")
      assertSessionNoticeMeaning(notice, [order.id, order.orderKey])

      // A new session: sign in again and check. The check reads what the server recorded; it cannot attach the lost hash.
      offset = 0
      await page.waitFor(() => page.button("Retry Stocks sign-in") && !page.button("Retry Stocks sign-in")!.disabled, "sign-in button after expiry")
      await page.click(page.button("Retry Stocks sign-in"), "Retry Stocks sign-in")
      await page.waitFor(() => page.text().includes("Signed in to Stocks."), "signed in again")
      await page.waitFor(() => page.element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "investor session again")
      sendsAt.signInAgain = sends(wallet)
      assert.ok(noticeElement(page) === null, "hidden while signed in")
      await page.waitFor(() => page.panelStatus() === "IDLE", "IDLE panel for the accepted order after signing in again")
      const journalReads = requestsTo(harness, "GET", new RegExp(`/wallet-submissions/${side}/${order.id}$`)).length
      await page.click(page.action("prepare"), "Check order")
      await page.waitStatus("UNKNOWN")
      sendsAt.checkAgain = sends(wallet)
      assert.ok(requestsTo(harness, "GET", new RegExp(`/wallet-submissions/${side}/${order.id}$`)).length > journalReads, "the check read the server journal")
      const panelText = page.panel()!.textContent!
      assert.ok(panelText.includes("Result unknown"), panelText)
      assert.ok(panelText.includes("Do not repeat it from another app or wallet"), panelText)
      assert.equal(page.hash(), null, "no hash: the server never received it")
      assert.ok(recoveryCard(page) === null, "nothing to recover without a hash")
      assert.ok(page.action("approve") === null, "no approval button on the recovery-only screen")
      assert.ok(page.action("submit") === null)
      await page.settle(1_000)
      assert.equal(bodies(harness, /wallet-submissions\/outcomes$/).length, 0, "the check posts no outcome")
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).length, 1, "no new claim")
      assert.equal(requestsTo(harness, "POST", /wallet-submissions\/reconcile$/).length, 0)
      assert.deepEqual(approvals(), [["REQUEST_MAY_START", null]], "still no hash on the server")
      sendsAt.end = sends(wallet)
      assert.deepEqual(sendsAt, { mount: 0, signIn: 0, accepted: 0, check: 0, approve: 1, signInAgain: 1, checkAgain: 1, end: 1 })
      assert.equal(forbiddenSends(wallet), 0)

      // Signing out after that uncertain check keeps the same caution for the same wallet.
      await page.click(page.button("Sign out of Stocks"), "Sign out of Stocks")
      assertSessionNoticeMeaning(await page.waitFor(() => noticeElement(page), "notice after the uncertain check"), [order.id, order.orderKey])
      assert.equal(sends(wallet), 1)
    }

    await scenario("11. BUY: the wallet answers with an error after the session expired: no hash is kept; the notice and a new check promise no recovery", expiredSessionNoHash("BUY"))
    await scenario("12. SELL: the wallet answers with an error after the session expired: no hash is kept; the notice and a new check promise no recovery", expiredSessionNoHash("SELL"))

    // ---------------------------------------------------------------- 003D: known-hash recovery on the real page

    function assertKeptNotice(notice: HTMLElement, secrets: string[]) {
      const text = notice.textContent ?? ""
      assert.equal(text, KEPT_NOTICE_TEXT)
      // Nothing to click and nothing about the order: no link, button, number, amount, order or hash.
      assert.equal(notice.querySelectorAll("a, button").length, 0, "no link or button in the notice")
      assert.doesNotMatch(text, /\d/, text)
      for (const secret of secrets) assert.ok(!text.includes(secret), `notice leaks ${secret}`)
    }

    /** Signs in again after expiry (the host then offers "Retry Stocks sign-in") or after a sign-out. */
    async function signInAgain(page: Page) {
      const label = page.button("Retry Stocks sign-in") ? "Retry Stocks sign-in" : "Sign in to Stocks"
      await page.waitFor(() => page.button(label) && !page.button(label)!.disabled, `${label} button`)
      await page.click(page.button(label), label)
      await page.waitFor(() => page.text().includes("Signed in to Stocks."), "signed in again")
      await page.waitFor(() => page.element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith("Signed in as"), "investor session again")
    }

    type LateHashOptions = { side: "BUY" | "SELL"; stage: "APPROVAL" | "TRANSFER"; fetch?: (harness: InProcessStocks) => typeof globalThis.fetch }

    /**
     * The real page with a 30 s session: the order is accepted, the stage's wallet prompt is held, the session expires
     * by time, then the wallet returns a real hash (the fake chain applies the transaction). The original gate refuses
     * to record it before any request; the page keeps it in this tab's memory.
     */
    async function lateHashOnPage(options: LateHashOptions) {
      const { side, stage } = options
      const clockState = { offset: 0 }
      const wall = () => Date.now() + clockState.offset
      const clock: ExecutionClockSeam = { now: wall, monotonicNow: () => performance.now() + clockState.offset }
      const harness = await createInProcessStocks({ wall })
      cleanups.push(() => harness.close())
      const wallet = createFakeEip1193Wallet(harness.chain, { account: getAddress(WALLET_A) })
      if (side === "BUY") harness.seedCash(WALLET_A, 1_000_000_000n)
      else harness.seedStock(WALLET_A, "3000000000")
      const store = createKnownHashStore()
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: `injected:a:${side}:${stage}`, clock, sessionSeconds: 30, knownHashes: store, fetch: options.fetch?.(harness) })
      await page.signIn()
      await page.placeOrder(side)
      const order = orderRow(harness, side, WALLET_A)
      await page.waitFor(() => page.action("prepare"), "panel")
      await page.checkToApproval()
      if (stage === "TRANSFER") {
        await approveToReadyTransfer(page, harness, wallet, expectedTransactions(harness, side, order, WALLET_A))
        await page.waitFor(() => page.action("submit") && !page.action("submit")!.disabled, "transfer step armed", 3_000)
      }
      const hold = wallet.holdNext("eth_sendTransaction")
      await page.click(page.action(stage === "APPROVAL" ? "approve" : "submit"), stage)
      await act(async () => {
        await hold.arrived
      })
      await page.waitStatus("SIGNING")
      const rows = () =>
        ((harness.sql.snapshot() as unknown as Record<string, Row[]>).StocksWalletSubmission ?? [])
          .filter((row) => String(row.wallet).toLowerCase() === WALLET_A.toLowerCase() && row.stage === stage)
          .map((row) => [row.status, row.txHash ?? null])
      assert.deepEqual(rows(), [["REQUEST_MAY_START", null]], "one reserved claim while the prompt is open")
      const outcomes = bodies(harness, /wallet-submissions\/outcomes$/).length
      const claims = bodies(harness, /wallet-submissions\/claims$/).length

      clockState.offset += 31_000
      await page.rerender({})
      await page.waitFor(() => page.text().includes("Your Stocks session expired. Sign in again."), "expired session")
      await page.waitFor(() => noticeElement(page), "session notice before the wallet answers")
      assert.ok(keptNotice(page) === null, "nothing is kept before the wallet answers")
      await act(async () => {
        hold.release()
        await sleep(0)
      })
      await page.settle(800)
      const hash = harness.chain.transactions[harness.chain.transactions.length - 1]!.hash
      assert.equal(bodies(harness, /wallet-submissions\/outcomes$/).length, outcomes, "the original gate refuses the late hash before any request")
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).length, claims)
      assert.deepEqual(rows(), [["REQUEST_MAY_START", null]], "the server journal has no hash yet")
      const notice = await page.waitFor(() => keptNotice(page), "kept-hash notice")
      assertKeptNotice(notice, [order.id, order.orderKey, hash])
      assert.ok(noticeElement(page) === null, "one notice variant at a time")
      assert.ok(!page.text().includes(hash), "the kept hash is not painted while signed out")
      assert.ok(recoveryCard(page) === null)
      const [entry] = store.entries({ wallet: WALLET_A, chainId: 91342, apiBase: harness.apiBase, origin: harness.frontendOrigin })
      assert.ok(entry && entry.txHash === hash && entry.state.kind === "KEPT", "the page kept exactly this hash")
      return { page, harness, wallet, store, order, hash, rows, clockState }
    }

    /** One explicit recovery click (activated twice in one act), asserting exact requests and no claim or wallet request. */
    async function recoverOnPage(ctx: Awaited<ReturnType<typeof lateHashOnPage>>, stage: "APPROVAL" | "TRANSFER") {
      const { page, harness, wallet, order, hash, rows } = ctx
      const card = await page.waitFor(() => recoveryCard(page), "recovery card")
      assert.equal(card.dataset.state, "KEPT")
      assert.ok(card.textContent!.includes(hash), "the owner sees the kept hash on its own order")
      assert.ok(card.textContent!.includes("kept only in this tab's memory"))
      assert.ok(card.textContent!.includes("Recording it sends nothing from your wallet"))
      const button = card.querySelector<HTMLButtonElement>('button[data-action="record-known-hash"]')
      assert.ok(button && button.textContent === "Record this hash")
      const sendsBefore = sends(wallet)
      const callsBefore = wallet.calls.length
      const requestsBefore = harness.requests.length
      const claims = bodies(harness, /wallet-submissions\/claims$/).length
      const outcomes = bodies(harness, /wallet-submissions\/outcomes$/).length
      const reconciles = bodies(harness, /wallet-submissions\/reconcile$/).length
      const inspectPattern = new RegExp(`/wallet-submissions/(BUY|SELL)/${order.id}$`)
      const inspectsBefore = requestsTo(harness, "GET", inspectPattern).length
      await act(async () => {
        button.click()
        button.click()
        await sleep(0)
      })
      await page.waitFor(() => recoveryCard(page)?.dataset.state === "VERIFIED_CONFIRMED", "server-verified receipt", 10_000)
      await page.settle(300)
      assert.equal(sends(wallet), sendsBefore, "recovery never opens the wallet")
      assert.equal(wallet.calls.length, callsBefore, "no wallet call of any kind")
      // The recovery's inspect, outcome and reconcile all carry one token: the current session's, never the original claim's.
      const recovery = harness.requests.slice(requestsBefore).filter((request) => /\/wallet-submissions\/(BUY|SELL)\/|\/outcomes$|\/reconcile$/.test(request.path))
      const originalClaim = harness.requests.find((request) => request.method === "POST" && request.path.endsWith("/claims") && JSON.parse(request.body ?? "{}").stage === stage)
      assert.ok(recovery.length >= 3 && new Set(recovery.map((request) => request.bearer)).size === 1, "one session for the whole recovery")
      assert.ok(originalClaim && recovery[0]!.bearer !== originalClaim.bearer, "not the original session's token")
      assert.equal(forbiddenSends(wallet), 0)
      assert.equal(bodies(harness, /wallet-submissions\/claims$/).length, claims, "recovery never claims")
      const recorded = bodies(harness, /wallet-submissions\/outcomes$/).slice(outcomes)
      assert.equal(recorded.length, 1, "one outcome despite the double click")
      assert.deepEqual(Object.keys(recorded[0]!).sort(), ["claimId", "intentKey", "stage", "status", "transactionDigest", "txHash"])
      assert.deepEqual([recorded[0]!.stage, recorded[0]!.status, recorded[0]!.txHash], [stage, "SUBMITTED", hash])
      assert.equal(bodies(harness, /wallet-submissions\/reconcile$/).length, reconciles + 1)
      assert.equal(requestsTo(harness, "GET", inspectPattern).length, inspectsBefore + 1, "one inspect before recording")
      assert.deepEqual(rows(), [["CONFIRMED", hash]])
      const text = recoveryCard(page)!.textContent!
      assert.ok(text.includes(stage === "APPROVAL" ? "An approval does not fund or complete the order" : "This is not the order result"), text)
      assert.ok(recoveryCard(page)!.querySelector("button") === null, "nothing more to do for a verified hash")
    }

    const orderState = (harness: InProcessStocks, side: "BUY" | "SELL", id: string) => (harness.sql.snapshot() as unknown as Record<string, Row[]>)[side === "BUY" ? "StocksOrder" : "StocksSellOrder"]!.find((row) => row.id === id)!.state

    await scenario("13. BUY approval: late hash kept; B never sees it (A→B→A); after the quote deadline the same owner records and verifies it; no new deposit", async () => {
      const ctx = await lateHashOnPage({ side: "BUY", stage: "APPROVAL" })
      const { page, harness, order, hash, clockState } = ctx
      // Another wallet on the same page (signed out, then signed in) sees nothing of A.
      const walletB = createFakeEip1193Wallet(harness.chain, { account: getAddress(walletFor(13, "b")) })
      const leaks: string[] = []
      const observer = new w.MutationObserver(() => {
        if (page.text().includes(hash)) leaks.push("hash")
        if (page.text().includes(order.id)) leaks.push("order id")
        if (keptNotice(page)) leaks.push("kept notice")
        if (recoveryCard(page)) leaks.push("recovery card")
      })
      observer.observe(page.element, { subtree: true, childList: true, characterData: true, attributes: true })
      await page.rerender({ address: walletFor(13, "b"), epoch: "injected:b:13", source: { mode: "injected", provider: walletB } })
      await page.settle(200)
      await page.signIn()
      await page.settle(300)
      await page.click(page.button("Sign out of Stocks"), "Sign out of Stocks (B)")
      await page.settle(200)
      observer.disconnect()
      // Final DOM after every mutation; first-commit checks with A's order row are in known-hash.dom.test.tsx.
      assert.deepEqual(leaks, [], "B's page shows none of A's hash, order, notice or card")
      assert.equal(walletB.calls.filter((call) => call.method === "eth_sendTransaction").length, 0)
      await page.rerender({ address: WALLET_A, epoch: "injected:a:13:back", source: { mode: "injected", provider: ctx.wallet } })
      assertKeptNotice(await page.waitFor(() => keptNotice(page), "A's kept-hash notice again"), [order.id, hash])
      // Past the original 60-second quote deadline; recovery does not depend on it.
      clockState.offset += 31_000
      await signInAgain(page)
      await recoverOnPage(ctx, "APPROVAL")
      // The expired order offers no deposit: the panel shows the deadline and no wallet step.
      await page.waitFor(() => page.panel()?.textContent?.includes("Quote deadline passed"), "deadline shown")
      assert.ok(page.action("approve") === null)
      assert.ok(page.action("submit") === null)
      assert.equal(page.action("prepare")?.disabled, true)
      assert.equal(orderState(harness, "BUY", order.id), "AWAITING_FUNDING", "a receipt is not order completion")
    })

    await scenario("14. SELL approval: kept hash recorded and verified after the quote deadline with trading paused", async () => {
      const ctx = await lateHashOnPage({ side: "SELL", stage: "APPROVAL" })
      ctx.clockState.offset += 31_000
      ctx.harness.setPaused(true)
      await signInAgain(ctx.page)
      await recoverOnPage(ctx, "APPROVAL")
      assert.ok(ctx.page.action("submit") === null, "no escrow step for the expired, paused order")
      assert.equal(orderState(ctx.harness, "SELL", ctx.order.id), "AWAITING_ESCROW")
    })

    await scenario("15. BUY deposit: the order moved on while signed out; after a status refresh the recovery card verifies the kept deposit hash and the order result stays the server's", async () => {
      const ctx = await lateHashOnPage({ side: "BUY", stage: "TRANSFER" })
      await ctx.harness.setOrderState("BUY", ctx.order.id, "BROKER_PENDING")
      ctx.clockState.offset = 0
      await signInAgain(ctx.page)
      const card = await ctx.page.waitFor(() => ctx.page.element.querySelector<HTMLElement>('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), "accepted order card")
      await ctx.page.click(ctx.page.button("Refresh status", card), "card Refresh status")
      await ctx.page.waitFor(() => card.textContent?.includes("Broker processing"), "the server's order status on the card")
      await recoverOnPage(ctx, "TRANSFER")
      assert.equal(orderState(ctx.harness, "BUY", ctx.order.id), "BROKER_PENDING", "the order result stays the server's")
      assert.ok(!ctx.page.panel()!.textContent!.includes("Completed"))
    })

    await scenario("16. SELL escrow: kept hash recorded and verified before the deadline; the panel's own check then shows the recorded escrow", async () => {
      const ctx = await lateHashOnPage({ side: "SELL", stage: "TRANSFER" })
      ctx.clockState.offset = 0 // Back before the quote deadline for the panel's own evidence check.
      await signInAgain(ctx.page)
      await recoverOnPage(ctx, "TRANSFER")
      const sendsBefore = sends(ctx.wallet)
      await ctx.page.waitFor(() => ctx.page.action("prepare") && !ctx.page.action("prepare")!.disabled, "check enabled")
      await ctx.page.click(ctx.page.action("prepare"), "Check order")
      await ctx.page.waitStatus("SUBMITTED")
      assert.equal(ctx.page.hash(), ctx.hash)
      assert.ok(ctx.page.action("submit") === null, "never sent again")
      assert.equal(sends(ctx.wallet), sendsBefore)
    })

    await scenario("17. a slow recovery answer across a sign-out paints and stores nothing; the same owner can record it after signing in again", async () => {
      const gate: { hold: Promise<void> | null; release: () => void } = { hold: null, release: () => undefined }
      const ctx = await lateHashOnPage({
        side: "BUY",
        stage: "APPROVAL",
        fetch: (harness) => (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (gate.hold && (init?.method ?? "GET") === "GET" && /\/wallet-submissions\/(BUY|SELL)\//.test(String(input))) await gate.hold
          return harness.fetch(input, init)
        }) as typeof globalThis.fetch,
      })
      const { page, harness, store, hash } = ctx
      ctx.clockState.offset = 0
      await signInAgain(page)
      const card = await page.waitFor(() => recoveryCard(page), "recovery card")
      gate.hold = new Promise<void>((resolve) => { gate.release = resolve })
      await page.click(card.querySelector<HTMLButtonElement>('button[data-action="record-known-hash"]'), "Record this hash")
      await page.waitFor(() => recoveryCard(page)?.querySelector("button")?.disabled, "busy while the server is asked")
      const outcomes = bodies(harness, /wallet-submissions\/outcomes$/).length
      await page.click(page.button("Sign out of Stocks"), "Sign out of Stocks")
      await page.waitFor(() => keptNotice(page), "kept-hash notice after signing out")
      await act(async () => {
        gate.release()
        gate.hold = null
        await sleep(0)
      })
      await page.settle(800)
      assert.equal(bodies(harness, /wallet-submissions\/outcomes$/).length, outcomes, "nothing recorded after the owner left")
      const [entry] = store.entries({ wallet: WALLET_A, chainId: 91342, apiBase: harness.apiBase, origin: harness.frontendOrigin })
      assert.deepEqual([entry?.state.kind, entry?.busy], ["KEPT", false])
      assert.ok(!page.text().includes(hash))
      await signInAgain(page)
      await recoverOnPage(ctx, "APPROVAL")
    })

    await scenario("18. a 401 for the pinned session arriving after the owner signed in again invalidates only that session; the new one stays; the hash is recorded once", async () => {
      const control: { reject: boolean; hold: Promise<void> | null; release: () => void } = { reject: false, hold: null, release: () => undefined }
      const ctx = await lateHashOnPage({
        side: "SELL",
        stage: "APPROVAL",
        fetch: (harness) => (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (control.reject && /\/wallet-submissions\/outcomes$/.test(String(input))) {
            control.reject = false
            if (control.hold) await control.hold
            return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401, headers: { "content-type": "application/json" } })
          }
          return harness.fetch(input, init)
        }) as typeof globalThis.fetch,
      })
      const { page, harness, store } = ctx
      ctx.clockState.offset = 0
      await signInAgain(page) // S1: the session the recovery pins.
      const card = await page.waitFor(() => recoveryCard(page), "recovery card")
      control.reject = true
      control.hold = new Promise<void>((resolve) => { control.release = resolve })
      await page.click(card.querySelector<HTMLButtonElement>('button[data-action="record-known-hash"]'), "Record this hash")
      await page.waitFor(() => recoveryCard(page)?.querySelector("button")?.disabled, "busy while the server is asked")
      // The owner signs out and in again (S2) while S1's request is outstanding; then S1's answer is a 401.
      await page.click(page.button("Sign out of Stocks"), "Sign out of Stocks")
      await signInAgain(page)
      await act(async () => {
        control.release()
        control.hold = null
        await sleep(0)
      })
      await page.settle(800)
      assert.ok(page.text().includes("Signed in to Stocks."), "the 401 of S1 does not sign S2 out")
      assert.ok(!page.text().includes("Your Stocks session is no longer valid"))
      const [entry] = store.entries({ wallet: WALLET_A, chainId: 91342, apiBase: harness.apiBase, origin: harness.frontendOrigin })
      assert.deepEqual([entry?.state.kind, entry?.busy], ["KEPT", false])
      assert.equal(bodies(harness, /wallet-submissions\/outcomes$/).length, 0, "the rejected request never reached the server")
      await recoverOnPage(ctx, "APPROVAL")
    })

    await scenario("20. the original answer arrives after the same owner signed in again: no request with either token; the card appears and records it only on the click", async () => {
      const clockState = { offset: 0 }
      const wall = () => Date.now() + clockState.offset
      const clock: ExecutionClockSeam = { now: wall, monotonicNow: () => performance.now() + clockState.offset }
      const harness = await createInProcessStocks({ wall })
      cleanups.push(() => harness.close())
      const wallet = createFakeEip1193Wallet(harness.chain, { account: getAddress(WALLET_A) })
      harness.seedCash(WALLET_A, 1_000_000_000n)
      const store = createKnownHashStore()
      const page = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:20", clock, sessionSeconds: 30, knownHashes: store })
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
      clockState.offset += 31_000
      await page.rerender({})
      await page.waitFor(() => page.text().includes("Your Stocks session expired. Sign in again."), "expired session")
      await signInAgain(page) // A newer valid session exists before the wallet answers.
      await page.waitFor(() => page.panelStatus() === "IDLE", "the new session's panel")
      assert.ok(recoveryCard(page) === null, "nothing kept yet")
      const requests = harness.requests.length
      await act(async () => {
        hold.release()
        await sleep(0)
      })
      const card = await page.waitFor(() => recoveryCard(page), "the card appears for the signed-in owner")
      await page.settle(300)
      assert.equal(harness.requests.slice(requests).filter((request) => request.method === "POST").length, 0, "the old callback wrote nothing, with either token")
      const hash = harness.chain.transactions[harness.chain.transactions.length - 1]!.hash
      assert.equal(card.dataset.state, "KEPT")
      assert.ok(card.textContent!.includes(hash))
      const rows = () =>
        ((harness.sql.snapshot() as unknown as Record<string, Row[]>).StocksWalletSubmission ?? []).filter((row) => row.stage === "APPROVAL" && String(row.wallet).toLowerCase() === WALLET_A.toLowerCase()).map((row) => [row.status, row.txHash ?? null])
      assert.deepEqual(rows(), [["REQUEST_MAY_START", null]], "nothing recorded until the click")
      await recoverOnPage({ page, harness, wallet, store, order, hash, rows, clockState }, "APPROVAL")
    })

    await scenario("19. a reload loses the kept hash: the new page offers no recovery, and its check stays recovery-only without sending again", async () => {
      const ctx = await lateHashOnPage({ side: "BUY", stage: "APPROVAL" })
      const { harness, wallet, order, hash } = ctx
      await ctx.page.unmount()
      ctx.clockState.offset = 0
      // A reload starts with empty memory: a new page with a new, empty kept-hash store.
      const reloaded = await mount(harness, { wallet, address: WALLET_A, epoch: "injected:a:19:reload", clock: { now: () => Date.now() + ctx.clockState.offset, monotonicNow: () => performance.now() + ctx.clockState.offset }, sessionSeconds: 30, knownHashes: createKnownHashStore() })
      await reloaded.waitFor(() => reloaded.button("Sign in to Stocks"), "sign-in button")
      assert.ok(keptNotice(reloaded) === null, "nothing kept after a reload")
      await reloaded.waitFor(() => reloaded.element.querySelector('button[aria-label="View NVDA"]'), "catalog")
      await reloaded.click(reloaded.element.querySelector('button[aria-label="View NVDA"]'), "View NVDA")
      await reloaded.signIn()
      await reloaded.waitFor(() => reloaded.panelStatus() === "IDLE", "IDLE panel for the reopened order")
      assert.ok(recoveryCard(reloaded) === null)
      const sendsBefore = sends(wallet)
      await reloaded.click(reloaded.action("prepare"), "Check order")
      await reloaded.waitStatus("UNKNOWN")
      assert.ok(reloaded.panel()!.textContent!.includes("Do not repeat it from another app or wallet"))
      assert.ok(!reloaded.text().includes(hash))
      assert.equal(sends(wallet), sendsBefore)
      assert.equal(bodies(harness, /wallet-submissions\/outcomes$/).length, 0)
      assert.deepEqual(ctx.rows(), [["REQUEST_MAY_START", null]])
      void order
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
