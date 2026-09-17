// Real React DOM + StrictMode + the connected panel + the real wallet controller over scripted fixture
// ports. Uses the already-installed jsdom runtime named by GIWA_HOST_DOM_RUNTIME (no dependency added),
// exactly like the stocks-host DOM gate; without it this gate reports as skipped.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import { act, Profiler, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { sha256, toHex } from "viem"

import { createStocksWalletController } from "../stocks-wallet/controller"
import { countControllerActions, createScriptedWallet } from "./fixtures/scripted-wallet"
import { StocksWalletExecutionPanel } from "./StocksWalletExecutionPanel"
import type { StocksServerOrderStatus } from "./types"

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const ARM_MS = 40
const A_BUY = "fixture-order-a-buy-1"
const A_SELL = "fixture-order-a-sell-1"
const B_BUY = "fixture-order-b-buy-1"
const FIRST_HASH = sha256(toHex("fixture-transaction-1"))

test("wallet panel DOM integration (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example", pretendToBeVisual: true })
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  async function mount(options: { configured?: boolean; tickMs?: number } = {}) {
    const f = createScriptedWallet()
    const controller = createStocksWalletController(f.ports)
    const counted = countControllerActions(controller)
    const element = document.createElement("div")
    document.body.append(element)
    const root = createRoot(element)
    let orderId = A_BUY
    let serverOrder: StocksServerOrderStatus | null = null
    let refreshes = 0
    // Every committed DOM, captured in the commit phase: nothing painted between states escapes.
    const commits: string[] = []
    async function render() {
      const configured = options.configured !== false
      const tree = (
        <Profiler id="wallet-panel" onRender={() => commits.push(element.textContent ?? "")}>
          <StocksWalletExecutionPanel
            controller={configured ? counted.api : null}
            ports={configured ? f.ports : null}
            selection={f.selection(orderId)}
            serverOrder={serverOrder}
            onRefreshServerOrder={() => {
              refreshes++
              serverOrder = f.serverOrder(orderId)
            }}
            armDelayMs={ARM_MS}
            tickMs={options.tickMs ?? 0}
          />
        </Profiler>
      )
      await act(async () => {
        root.render(<StrictMode>{tree}</StrictMode>)
      })
    }
    await render()
    const panel = () => element.querySelector('[data-testid="stocks-wallet-panel"]') as HTMLElement
    const status = () => panel().getAttribute("data-status")
    const button = (action: string) => element.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement | null
    const actionButtons = () => [...element.querySelectorAll("button[data-action]")] as HTMLButtonElement[]
    async function settle(ms = 0) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
        for (let i = 0; i < 100; i++) await Promise.resolve()
      })
    }
    async function until(predicate: () => boolean, label: string) {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return
        await settle(5)
      }
      assert.fail(`timed out waiting for ${label} (status ${status()})`)
    }
    async function click(target: HTMLButtonElement | null) {
      assert.ok(target, "button present")
      await act(async () => {
        target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }))
        target.focus()
        target.click()
      })
    }
    const asyncReads = () => Object.entries(f.reads).reduce((sum, [name, count]) => (name === "context" ? sum : sum + count), 0)
    return {
      f,
      calls: counted.calls,
      element,
      commits,
      render,
      panel,
      status,
      button,
      actionButtons,
      settle,
      until,
      click,
      asyncReads,
      refreshes: () => refreshes,
      setOrder(id: string) {
        orderId = id
      },
      async unmount() {
        await act(async () => root.unmount())
        element.remove()
        controller.dispose()
      },
    }
  }

  async function toApprovalRequired(m: Awaited<ReturnType<typeof mount>>) {
    await m.click(m.button("prepare"))
    await m.until(() => m.status() === "APPROVAL_REQUIRED", "APPROVAL_REQUIRED")
    await m.until(() => m.button("approve")?.disabled === false, "approve armed")
  }

  await t.test("mount, StrictMode replay, re-renders, ticks and host changes make no request and call no action", async () => {
    const m = await mount({ tickMs: 10 })
    assert.equal(m.status(), "IDLE")
    const changes: [string, () => void][] = [
      ["account B", () => (m.f.controls.setAccount("B"), m.setOrder(B_BUY))],
      ["account A", () => (m.f.controls.setAccount("A"), m.setOrder(A_BUY))],
      ["reconnect", () => m.f.controls.reconnect()],
      ["order", () => m.setOrder(A_SELL)],
      ["clock", () => m.f.controls.advance(60_000)],
      ["server state", () => m.f.controls.setServerState(A_SELL, "SELL_BROKER_PENDING")],
      ["sign out", () => m.f.controls.setSignedIn(false)],
      ["sign in", () => m.f.controls.setSignedIn(true)],
      ["expire", () => m.f.controls.advance(600_000)],
    ]
    for (const [label, change] of changes) {
      change()
      await m.render()
      await m.settle(30)
      assert.equal(m.f.requests.length, 0, label)
      assert.equal(m.asyncReads(), 0, `${label}: no port read`)
      assert.deepEqual(m.calls, { prepare: 0, approve: 0, submit: 0 }, label)
    }
    await m.unmount()
  })

  await t.test("explicit clicks: check, approve, NO automatic deposit, then a separate deposit — each exactly once", async () => {
    const m = await mount()
    await m.click(m.button("prepare"))
    assert.equal(m.calls.prepare, 1)
    await m.until(() => m.status() === "APPROVAL_REQUIRED", "APPROVAL_REQUIRED")
    assert.equal(m.f.requests.length, 0, "a check never opens the wallet")
    assert.equal(m.button("approve")?.disabled, true, "not armed on first paint")
    await m.click(m.button("approve"))
    assert.equal(m.calls.approve, 0, "a click before arming does nothing")
    await m.until(() => m.button("approve")?.disabled === false, "approve armed")
    await m.click(m.button("approve"))
    assert.equal(m.calls.approve, 1)
    await m.until(() => m.status() === "READY_TRANSFER", "READY_TRANSFER")
    assert.equal(m.f.requests.length, 1)
    // A press that carries over from the approval step lands on an unarmed button.
    await m.click(m.button("submit"))
    assert.equal(m.calls.submit, 0)
    await m.settle(ARM_MS * 4)
    await m.render()
    await m.settle(ARM_MS)
    assert.equal(m.calls.submit, 0)
    assert.equal(m.f.requests.length, 1, "approval completion never deposits")
    assert.equal(m.button("submit")?.disabled, false)
    await m.click(m.button("submit"))
    assert.equal(m.calls.submit, 1)
    await m.until(() => m.status() === "SUBMITTED", "SUBMITTED")
    assert.equal(m.f.requests.length, 2)
    assert.match(m.element.querySelector('[data-testid="stocks-wallet-tx-hash"]')?.textContent ?? "", /^0x[0-9a-f]{64}$/)
    const server = m.element.querySelector('[data-testid="stocks-wallet-server-status"]')!
    assert.match(server.textContent ?? "", /Not reported/)
    assert.doesNotMatch(m.panel().textContent ?? "", /\bCompleted\b/)
    m.f.controls.setServerState(A_BUY, "COMPLETED")
    await m.click([...server.querySelectorAll("button")].find((node) => node.textContent === "Refresh order status") as HTMLButtonElement)
    await m.render()
    assert.equal(m.refreshes(), 1)
    assert.match(server.textContent ?? "", /Completed/, "completion comes only from the injected server status")
    assert.equal(m.f.requests.length, 2)
    await m.unmount()
  })

  await t.test("repeated activation and SIGNING: one approve call and one wallet request", async () => {
    const m = await mount()
    m.f.controls.setWalletMode("hold")
    await toApprovalRequired(m)
    const approve = m.button("approve")!
    await act(async () => {
      approve.click()
      approve.click()
      approve.click()
    })
    assert.equal(m.calls.approve, 1)
    await m.until(() => m.status() === "SIGNING", "SIGNING")
    assert.ok(m.actionButtons().length > 0)
    for (const node of m.actionButtons()) {
      assert.equal(node.disabled, true, "every action is disabled while the wallet is open")
      await m.click(node)
    }
    assert.equal(m.calls.approve, 1)
    assert.equal(m.calls.submit, 0)
    assert.equal(m.f.requests.length, 1)
    m.f.controls.releaseHeld()
    await m.until(() => m.status() === "READY_TRANSFER", "READY_TRANSFER")
    assert.equal(m.f.requests.length, 1)
    await m.unmount()
  })

  await t.test("account switch during SIGNING: no commit shows A's order or hash; A's late hash is recovered only for A", async () => {
    const m = await mount()
    m.f.controls.setWalletMode("hold")
    m.f.controls.setReconcileMode("pending")
    await toApprovalRequired(m)
    await m.click(m.button("approve"))
    await m.until(() => m.status() === "SIGNING", "SIGNING")
    const from = m.commits.length
    m.f.controls.setAccount("B")
    m.setOrder(B_BUY)
    await m.render()
    assert.equal(m.status(), "IDLE")
    m.f.controls.releaseHeld()
    await m.settle(30)
    await m.render()
    const leaked = new RegExp(`${A_BUY}|300 ARCO_TEST_USDC|${FIRST_HASH}|Confirm in your wallet`)
    assert.ok(m.commits.length > from)
    for (const text of m.commits.slice(from)) assert.doesNotMatch(text, leaked)
    assert.match(m.panel().textContent ?? "", /0\.000001 ARCO_TEST_USDC/)
    m.f.controls.setAccount("A")
    m.setOrder(A_BUY)
    await m.render()
    assert.equal(m.status(), "IDLE", "A→B→A starts unchecked")
    assert.doesNotMatch(m.panel().textContent ?? "", new RegExp(FIRST_HASH))
    await m.click(m.button("prepare"))
    await m.until(() => m.status() === "APPROVAL_SUBMITTED", "APPROVAL_SUBMITTED")
    assert.equal(m.element.querySelector('[data-testid="stocks-wallet-tx-hash"]')?.textContent, FIRST_HASH)
    assert.equal(m.f.requests.length, 1, "nothing was signed again")
    await m.unmount()
  })

  await t.test("order switch during CHECKING shows only the new order", async () => {
    const m = await mount()
    await m.click(m.button("prepare"))
    const from = m.commits.length
    m.setOrder(A_SELL)
    await m.render()
    await m.settle(30)
    for (const text of m.commits.slice(from)) assert.doesNotMatch(text, /Buy NVDA|300 ARCO_TEST_USDC|fixture-order-a-buy-1/)
    assert.match(m.panel().textContent ?? "", /Sell NVDA: approve and escrow/)
    assert.equal(m.status(), "IDLE")
    assert.equal(m.f.requests.length, 0)
    await m.unmount()
  })

  await t.test("UNKNOWN offers no resend; REVERTED offers no retry", async () => {
    const m = await mount()
    m.f.controls.setWalletMode("reject")
    await toApprovalRequired(m)
    await m.click(m.button("approve"))
    await m.until(() => m.status() === "UNKNOWN", "UNKNOWN")
    assert.equal(m.button("approve"), null)
    assert.equal(m.button("submit"), null)
    m.f.controls.setWalletMode("hash")
    await m.click(m.button("prepare"))
    await m.settle(30)
    assert.equal(m.status(), "UNKNOWN")
    assert.equal(m.f.requests.length, 1)
    await m.unmount()

    const r = await mount()
    r.f.controls.setReconcileMode("revert")
    await toApprovalRequired(r)
    await r.click(r.button("approve"))
    await r.until(() => r.status() === "BLOCKED", "BLOCKED")
    assert.match(r.panel().textContent ?? "", /Approval reverted/)
    assert.equal(r.element.querySelector('[data-testid="stocks-wallet-tx-hash"]')?.textContent, FIRST_HASH)
    assert.equal(r.actionButtons().length, 0)
    assert.equal(r.f.requests.length, 1)
    await r.unmount()
  })

  await t.test("expiry disables an armed approval button; activation does nothing", async () => {
    const m = await mount()
    await toApprovalRequired(m)
    m.f.controls.advance(600_000)
    await m.render()
    assert.equal(m.button("approve")?.disabled, true)
    await m.click(m.button("approve"))
    assert.equal(m.calls.approve, 0)
    assert.equal(m.f.requests.length, 0)
    assert.match(m.panel().textContent ?? "", /Deadline passed/)
    await m.unmount()
  })

  await t.test("keyboard focus never lands on a wallet-opening button; status is announced politely", async () => {
    const m = await mount()
    const check = m.button("prepare")!
    await act(async () => {
      check.focus()
      check.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      check.click()
    })
    await m.until(() => m.status() === "APPROVAL_REQUIRED", "APPROVAL_REQUIRED")
    const heading = m.element.querySelector('[data-testid="stocks-wallet-state"] > h3')
    assert.equal(document.activeElement, heading, "focus moved to the state heading")
    assert.notEqual((document.activeElement as HTMLElement | null)?.getAttribute("data-action"), "approve")
    const live = m.element.querySelector('[role="status"][aria-live="polite"]')
    assert.match(live?.textContent ?? "", /^Approval required\. Approve exactly 300 ARCO_TEST_USDC/)
    const labelledBy = m.panel().getAttribute("aria-labelledby")!
    assert.equal(document.getElementById(labelledBy)?.textContent, "Buy NVDA: approve and deposit")
    for (const node of m.element.querySelectorAll("button")) assert.equal(node.getAttribute("type"), "button")
    assert.equal(m.element.querySelector('[aria-current="step"]')?.textContent?.includes("Approve exact amount"), true)
    await m.unmount()
  })

  await t.test("without a controller and ports the panel shows disabled execution", async () => {
    const m = await mount({ configured: false })
    assert.equal(m.status(), "UNAVAILABLE")
    assert.ok(m.actionButtons().every((node) => node.disabled))
    await m.click(m.button("prepare"))
    assert.deepEqual(m.calls, { prepare: 0, approve: 0, submit: 0 })
    await m.unmount()
  })
})
