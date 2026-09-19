// Real React DOM + StrictMode + the connected panel + the real wallet controller over scripted fixture
// ports. Uses the already-installed jsdom runtime named by GIWA_HOST_DOM_RUNTIME (no dependency added),
// exactly like the stocks-host DOM gate; without it this gate reports as skipped. The DOM-less rules
// (activation gate, arming keys, model, adapter) are covered by the other suites in every run.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"
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

  const flushMicrotasks = async () => {
    for (let i = 0; i < 300; i++) await Promise.resolve()
  }

  /** Mounts a panel whose cleanup is registered on the subtest, so a failing assertion never leaves an interval running. */
  async function mount(context: TestContext, options: { configured?: boolean; tickMs?: number; orderId?: string } = {}) {
    const f = createScriptedWallet()
    const controller = createStocksWalletController(f.ports)
    const counted = countControllerActions(controller)
    const element = document.createElement("div")
    document.body.append(element)
    const root = createRoot(element)
    let orderId = options.orderId ?? A_BUY
    let serverOrder: StocksServerOrderStatus | null = null
    let refreshing = false
    let refreshes = 0
    let mounted = true
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
            serverOrderRefreshing={refreshing}
            armDelayMs={ARM_MS}
            tickMs={options.tickMs ?? 0}
          />
        </Profiler>
      )
      await act(async () => {
        root.render(<StrictMode>{tree}</StrictMode>)
      })
    }
    async function unmount() {
      if (!mounted) return
      mounted = false
      // Real timers again before cleanup, so intervals are cleared even when a mock-timer subtest failed.
      context.mock.timers.reset()
      await act(async () => root.unmount())
      element.remove()
      controller.dispose()
    }
    context.after(unmount)
    await render()
    const panel = () => element.querySelector('[data-testid="stocks-wallet-panel"]') as HTMLElement
    const status = () => panel().getAttribute("data-status")
    const button = (action: string) => element.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement | null
    const actionButtons = () => [...element.querySelectorAll("button[data-action]")] as HTMLButtonElement[]
    async function settle(ms = 0) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
        await flushMicrotasks()
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
      unmount,
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
      setServerOrder(value: StocksServerOrderStatus | null) {
        serverOrder = value
      },
      setRefreshing(value: boolean) {
        refreshing = value
      },
      region: () => element.querySelector('[data-testid="stocks-wallet-announcement"]') as HTMLElement,
    }
  }
  type Mounted = Awaited<ReturnType<typeof mount>>

  async function toApprovalRequired(m: Mounted) {
    await m.click(m.button("prepare"))
    await m.until(() => m.status() === "APPROVAL_REQUIRED", "APPROVAL_REQUIRED")
    await m.until(() => m.button("approve")?.disabled === false, "approve armed")
  }

  await t.test("mount, StrictMode replay, re-renders, ticks and host changes make no request and call no action", async (st) => {
    const m = await mount(st, { tickMs: 10 })
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
      if (label === "sign out") {
        assert.doesNotMatch(m.panel().textContent ?? "", /fixture-order-a-sell-1|0\.123456789 NVDA|Sell NVDA/, "signed out: no order details")
        assert.match(m.panel().textContent ?? "", /SESSION_REQUIRED/)
      }
    }
  })

  for (const orderId of [A_BUY, A_SELL]) {
    await t.test(`${orderId === A_SELL ? "SELL" : "BUY"}: no approval, deposit or escrow without a click, even after minutes of timers, ticks and wall-clock time (mock timers from mount)`, async (st) => {
      // Enabled before mount: mount-time intervals and Date-based thresholds are mocked as well.
      st.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() })
      try {
        const m = await mount(st, { tickMs: 1_000, orderId })
        const advance = async (ms: number) => {
          for (let passed = 0; passed < ms; passed += 5_000) {
            await act(async () => {
              st.mock.timers.tick(5_000)
              await flushMicrotasks()
            })
          }
        }
        const clickNow = async (action: string) => {
          const target = m.button(action)
          assert.ok(target && !target.disabled, `${action} enabled`)
          await act(async () => {
            target.click()
            await flushMicrotasks()
          })
          await act(flushMicrotasks)
        }
        await clickNow("prepare")
        assert.equal(m.status(), "APPROVAL_REQUIRED")
        await advance(180_000)
        assert.deepEqual(m.calls, { prepare: 1, approve: 0, submit: 0 }, "three minutes on the approval step: no approval")
        assert.equal(m.f.requests.length, 0)
        assert.equal(m.status(), "APPROVAL_REQUIRED")
        await clickNow("approve")
        for (let i = 0; i < 5 && m.status() !== "READY_TRANSFER"; i++) await act(flushMicrotasks)
        assert.equal(m.status(), "READY_TRANSFER")
        assert.equal(m.f.requests.length, 1)
        await advance(180_000)
        assert.equal(m.calls.submit, 0, "three minutes after the approval: no deposit or escrow")
        assert.equal(m.f.requests.length, 1)
        assert.equal(m.status(), "READY_TRANSFER")
      } finally {
        st.mock.timers.reset()
      }
    })
  }

  await t.test("explicit clicks: check, approve, NO automatic deposit, then a separate deposit — each exactly once", async (st) => {
    const m = await mount(st)
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
    await m.click(m.element.querySelector('[data-testid="stocks-wallet-refresh-order"]'))
    await m.render()
    assert.equal(m.refreshes(), 1)
    assert.match(server.textContent ?? "", /Completed/, "completion comes only from the injected server status")
    assert.equal(m.f.requests.length, 2)
  })

  await t.test("repeated activation and SIGNING: one approve call and one wallet request", async (st) => {
    const m = await mount(st)
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
  })

  await t.test("account switch during SIGNING: no commit shows A's order or hash; A's late hash is recovered only for A", async (st) => {
    const m = await mount(st)
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
    assert.equal(m.button("prepare")?.disabled, false, "B's panel is not locked by A's open wallet prompt")
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
  })

  await t.test("order and account switches while a read-only check is still in flight show only the new scope", async (st) => {
    const m = await mount(st)
    m.f.controls.setHoldReads(true)
    await m.click(m.button("prepare"))
    await m.until(() => m.f.state().heldReads > 0, "check in flight")
    assert.equal(m.status(), "CHECKING", "the switch happens during CHECKING")
    let from = m.commits.length
    m.setOrder(A_SELL)
    await m.render()
    assert.equal(m.status(), "IDLE")
    m.f.controls.releaseReads()
    await m.settle(30)
    await m.render()
    for (const text of m.commits.slice(from)) assert.doesNotMatch(text, /Buy NVDA|300 ARCO_TEST_USDC|fixture-order-a-buy-1|Checking execution conditions/)
    assert.match(m.panel().textContent ?? "", /Sell NVDA: approve and escrow/)
    assert.doesNotMatch(m.region().textContent ?? "", /^Check finished/, "the previous order's check is not announced for the new one")
    assert.equal(m.status(), "IDLE", "the late check result is not painted into the new order")

    m.f.controls.setHoldReads(true)
    await m.click(m.button("prepare"))
    await m.until(() => m.f.state().heldReads > 0, "second check in flight")
    assert.equal(m.status(), "CHECKING")
    from = m.commits.length
    m.f.controls.setAccount("B")
    m.setOrder(B_BUY)
    await m.render()
    m.f.controls.releaseReads()
    await m.settle(30)
    await m.render()
    for (const text of m.commits.slice(from)) assert.doesNotMatch(text, /Sell NVDA|0\.123456789 NVDA|fixture-order-a-sell-1|Checking execution conditions/)
    assert.equal(m.status(), "IDLE")
    assert.equal(m.f.requests.length, 0)
  })

  await t.test("UNKNOWN offers no resend; REVERTED offers no retry", async (st) => {
    const m = await mount(st)
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

    const r = await mount(st)
    r.f.controls.setReconcileMode("revert")
    await toApprovalRequired(r)
    await r.click(r.button("approve"))
    await r.until(() => r.status() === "BLOCKED", "BLOCKED")
    assert.match(r.panel().textContent ?? "", /Approval reverted/)
    assert.equal(r.element.querySelector('[data-testid="stocks-wallet-tx-hash"]')?.textContent, FIRST_HASH)
    assert.equal(r.actionButtons().length, 0)
    assert.equal(r.f.requests.length, 1)
  })

  await t.test("expiry disables an armed approval button and replaces the call to action", async (st) => {
    const m = await mount(st)
    await toApprovalRequired(m)
    m.f.controls.advance(600_000)
    await m.render()
    assert.equal(m.button("approve")?.disabled, true)
    await m.click(m.button("approve"))
    assert.equal(m.calls.approve, 0)
    assert.equal(m.f.requests.length, 0)
    assert.match(m.panel().textContent ?? "", /Deadline passed/)
    assert.match(m.panel().textContent ?? "", /Quote deadline passed — do not approve/)
    assert.match(m.region().textContent ?? "", /Quote deadline passed — do not approve/)
  })

  await t.test("keyboard focus never lands on a wallet-opening button; status is announced politely", async (st) => {
    const m = await mount(st)
    const check = m.button("prepare")!
    await act(async () => {
      check.focus()
      check.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      check.click()
    })
    await m.until(() => m.status() === "APPROVAL_REQUIRED", "APPROVAL_REQUIRED")
    const heading = m.element.querySelector('[data-testid="stocks-wallet-state"] > h3')
    assert.ok(document.activeElement === heading, "focus moved to the state heading")
    assert.notEqual((document.activeElement as HTMLElement | null)?.getAttribute("data-action"), "approve")
    const live = m.element.querySelectorAll('[role="status"][aria-live="polite"]')
    assert.equal(live.length, 1, "one status region")
    assert.match(live[0]!.textContent ?? "", /^(Check finished\. )?Approval required\. Approve exactly 300 ARCO_TEST_USDC/)
    const labelledBy = m.panel().getAttribute("aria-labelledby")!
    assert.equal(document.getElementById(labelledBy)?.textContent, "Buy NVDA: approve and deposit")
    for (const node of m.element.querySelectorAll("button")) assert.equal(node.getAttribute("type"), "button")
    assert.equal(m.element.querySelector('[aria-current="step"]')?.textContent?.includes("Approve exact amount"), true)
  })

  await t.test("one status region persists across scope changes and announces check results and the server result", async (st) => {
    const m = await mount(st)
    const region = m.region()
    m.f.controls.setAccount("B")
    m.setOrder(B_BUY)
    await m.render()
    assert.ok(m.region() === region, "the same element survives the account change")
    assert.match(region.textContent ?? "", /^Not checked yet\./)
    m.f.controls.setAccount("A")
    m.setOrder(A_BUY)
    await m.render()
    assert.ok(m.region() === region, "the same element after returning to A")

    m.f.controls.setReconcileMode("pending")
    await toApprovalRequired(m)
    await m.click(m.button("approve"))
    await m.until(() => m.status() === "APPROVAL_SUBMITTED", "APPROVAL_SUBMITTED")
    await m.settle(20)
    // RECEIPT_PENDING from the approval itself is evidence the server has not confirmed it yet.
    assert.match(region.textContent ?? "", /^Approval submitted — confirming\./)
    const beforeCheck = region.textContent
    await m.click(m.button("prepare"))
    await m.settle(30)
    assert.equal(m.status(), "APPROVAL_SUBMITTED")
    assert.notEqual(region.textContent, beforeCheck, "a check that ends on the same screen is still announced")
    // The controller ends an explicit check of a pending approval with the ambiguous RECOVERY_REQUIRED: neutral wording.
    assert.match(region.textContent ?? "", /^Check finished\. Approval sent — check needed\./)
    // Text moves away and back without a new check: no second "Check finished."
    m.setServerOrder(m.f.serverOrder(A_BUY))
    await m.render()
    assert.doesNotMatch(region.textContent ?? "", /^Check finished/)
    m.setServerOrder(null)
    await m.render()
    assert.doesNotMatch(region.textContent ?? "", /^Check finished/, "returning to the checked text is not a new check")
    for (let repeat = 0; repeat < 3; repeat++) {
      const before = region.textContent
      await m.click(m.button("prepare"))
      await m.settle(30)
      assert.match(region.textContent ?? "", /^Check finished\. Approval sent — check needed\./)
      assert.notEqual(region.textContent, before, `repeat ${repeat}: an identical result is announced again`)
    }

    m.f.controls.setReconcileMode("confirm")
    await m.click(m.button("prepare"))
    await m.until(() => m.status() === "READY_TRANSFER", "READY_TRANSFER")
    await m.until(() => m.button("submit")?.disabled === false, "deposit armed")
    await m.click(m.button("submit"))
    await m.until(() => m.status() === "SUBMITTED", "SUBMITTED")
    m.f.controls.setServerState(A_BUY, "COMPLETED")
    await m.click(m.element.querySelector('[data-testid="stocks-wallet-refresh-order"]'))
    await m.render()
    assert.match(region.textContent ?? "", /Order result from the server: Completed\.$/)
    assert.match(m.panel().textContent ?? "", /Deposit submitted — server status: Completed/)
  })

  await t.test("focus is rescued only while the user works in the panel; refresh keeps focus while busy", async (st) => {
    const m = await mount(st)
    m.f.controls.setWalletMode("hold")
    await toApprovalRequired(m)
    await m.click(m.button("approve"))
    await m.until(() => m.status() === "SIGNING", "SIGNING")
    const outside = document.createElement("button")
    document.body.append(outside)
    await act(async () => {
      outside.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }))
      outside.focus()
      outside.blur()
    })
    assert.ok(document.activeElement === document.body, "the user left the panel")
    m.f.controls.releaseHeld()
    await m.until(() => m.status() === "READY_TRANSFER", "READY_TRANSFER")
    await m.settle(ARM_MS * 3)
    assert.ok(document.activeElement === document.body, "focus is not taken after the user left the panel")
    outside.remove()

    m.setServerOrder(m.f.serverOrder(A_BUY))
    await m.render()
    const refresh = m.element.querySelector('[data-testid="stocks-wallet-refresh-order"]') as HTMLButtonElement
    await act(async () => refresh.focus())
    m.setRefreshing(true)
    await m.render()
    assert.equal(refresh.getAttribute("aria-disabled"), "true")
    assert.equal(refresh.disabled, false)
    assert.ok(document.activeElement === refresh, "keyboard focus stays on the refresh button")
    const before = m.refreshes()
    await act(async () => refresh.click())
    assert.equal(m.refreshes(), before, "a busy refresh ignores activation")
  })

  await t.test("a wallet button that is disabled and re-enabled must arm again before it accepts activation", async (st) => {
    const m = await mount(st)
    m.f.controls.setAllowance(A_BUY, "300000000")
    await m.click(m.button("prepare"))
    await m.until(() => m.status() === "READY_TRANSFER", "READY_TRANSFER")
    await m.until(() => m.button("submit")?.disabled === false, "deposit armed")
    m.setServerOrder({ ...m.f.serverOrder(A_BUY), state: "BROKER_PENDING" })
    await m.render()
    assert.equal(m.button("submit")?.disabled, true, "moved on: disabled")
    assert.match(m.panel().textContent ?? "", /Order moved on — do not deposit/)
    assert.match(m.element.querySelector('[data-testid="stocks-wallet-steps"]')?.textContent ?? "", /Not needed — order moved on/)
    m.setServerOrder(null)
    await m.render()
    assert.equal(m.button("submit")?.disabled, true, "re-enabled step starts unarmed")
    await m.click(m.button("submit"))
    assert.equal(m.calls.submit, 0)
    await m.until(() => m.button("submit")?.disabled === false, "armed again")
    assert.equal(m.f.requests.length, 0)
  })

  await t.test("activation re-checks availability: a deadline passed since the last render refuses the approval", async (st) => {
    const m = await mount(st, { tickMs: 0 })
    await toApprovalRequired(m)
    m.f.controls.advance(600_000) // no re-render: the button on screen is still enabled
    assert.equal(m.button("approve")?.disabled, false)
    await m.click(m.button("approve"))
    await m.settle(20)
    assert.equal(m.calls.approve, 0, "the adapter refuses before the controller")
    assert.equal(m.f.requests.length, 0)
  })

  await t.test("focus rescue also covers a check button disabled by the deadline without a title change", async (st) => {
    const m = await mount(st)
    m.f.controls.setReconcileMode("pending")
    await toApprovalRequired(m)
    await m.click(m.button("approve"))
    await m.until(() => m.status() === "APPROVAL_SUBMITTED", "APPROVAL_SUBMITTED")
    await m.settle(20)
    // A check that still finds it pending ends in "Approval sent — check needed", the title the deadline keeps.
    await m.click(m.button("prepare"))
    await m.settle(30)
    const heading = () => m.element.querySelector('[data-testid="stocks-wallet-state"] > h3')
    assert.equal(heading()?.textContent, "Approval sent — check needed")
    const check = m.button("prepare")!
    await act(async () => {
      check.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
      check.focus()
    })
    assert.ok(document.activeElement === check)
    m.f.controls.advance(600_000)
    await m.render()
    assert.equal(m.button("prepare")?.disabled, true)
    assert.equal(heading()?.textContent, "Approval sent — check needed", "the title did not change")
    assert.ok(document.activeElement === heading(), "focus moved off the disabled button")
    assert.match(m.panel().textContent ?? "", /can no longer check the approval/)
    assert.doesNotMatch(m.element.querySelector('[data-testid="stocks-wallet-steps"]')?.textContent ?? "", /After approval|Confirming/, "no deposit step is promised after the deadline")
  })

  await t.test("a countdown re-render after a press on panel text keeps focus where it is; a real state change still moves it", async (st) => {
    const m = await mount(st, { tickMs: 10 })
    const heading = () => m.element.querySelector('[data-testid="stocks-wallet-state"] > h3')
    const pressText = async (target: Element) => {
      await act(async () => {
        ;(document.activeElement as HTMLElement | null)?.blur()
        target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }))
      })
      assert.ok(document.activeElement === document.body, "a press on text leaves focus on the page body")
    }
    const ticksKeepFocus = async (label: string) => {
      const status = m.status()
      const title = heading()?.textContent
      const from = m.commits.length
      // One act per wait, so every tick commits on its own instead of being batched into one render.
      for (let i = 0; i < 5; i++) await m.settle(20)
      assert.ok(m.commits.length - from > 3, `${label}: the countdown re-rendered the panel more than three times`)
      assert.equal(m.status(), status, `${label}: the state is unchanged`)
      assert.equal(heading()?.textContent, title, `${label}: the title is unchanged`)
      assert.ok(document.activeElement === document.body, `${label}: focus is not moved without a state change`)
    }
    // Plain paragraph text on the unchecked screen.
    await pressText(m.panel().querySelector('[data-testid="stocks-wallet-state"] p')!)
    await ticksKeepFocus("paragraph")

    // The approval hash (a drag-selection starts with this press).
    m.f.controls.setReconcileMode("pending")
    await toApprovalRequired(m)
    await m.click(m.button("approve"))
    await m.until(() => m.status() === "APPROVAL_SUBMITTED", "APPROVAL_SUBMITTED")
    await m.settle(20)
    await pressText(m.element.querySelector('[data-testid="stocks-wallet-tx-hash"]')!)
    await ticksKeepFocus("hash")

    // A real state change while focus is on the body still goes to the state heading.
    m.f.controls.advance(600_000)
    await m.render()
    assert.equal(m.button("prepare")?.disabled, true)
    assert.ok(document.activeElement === heading(), "the deadline changed the state: focus moves to the state heading")
    assert.equal(m.f.requests.length, 1)
    assert.deepEqual(m.calls, { prepare: 1, approve: 1, submit: 0 })
  })

  await t.test("a click that leaves focus on the page body (Safari) still moves focus to the state heading on the CHECKING and result commits", async (st) => {
    const m = await mount(st)
    const heading = () => m.element.querySelector('[data-testid="stocks-wallet-state"] > h3') as HTMLElement
    m.f.controls.setHoldReads(true)
    const check = m.button("prepare")!
    await act(async () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      // Safari does not focus a clicked button.
      check.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }))
      check.click()
    })
    await m.until(() => m.f.state().heldReads > 0, "check in flight")
    assert.equal(m.status(), "CHECKING")
    assert.ok(document.activeElement === heading(), "the CHECKING commit moves focus from the body to the state heading")
    await act(async () => heading().blur())
    assert.ok(document.activeElement === document.body)
    m.f.controls.releaseReads()
    await m.until(() => m.status() === "APPROVAL_REQUIRED", "APPROVAL_REQUIRED")
    assert.ok(document.activeElement === heading(), "the result commit moves it as well")
    await m.until(() => m.button("approve")?.disabled === false, "approve armed")
    assert.ok(document.activeElement === heading(), "never onto the wallet-opening button")
    assert.equal(m.f.requests.length, 0)
  })

  await t.test("without a controller and ports the panel shows disabled execution", async (st) => {
    const m = await mount(st, { configured: false })
    assert.equal(m.status(), "UNAVAILABLE")
    assert.ok(m.actionButtons().every((node) => node.disabled))
    await m.click(m.button("prepare"))
    assert.deepEqual(m.calls, { prepare: 0, approve: 0, submit: 0 })
  })
})
