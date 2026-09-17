// Real wallet controller + scripted fixture ports + the panel adapter, without a DOM.

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { sha256, toHex } from "viem"

import { createStocksWalletController } from "../stocks-wallet/controller"
import type { Side } from "../stocks-wallet/types"
import { stocksWalletPanelActions } from "./adapter"
import { executionAvailability } from "./availability"
import { countControllerActions, createScriptedWallet, type FixtureAccount } from "./fixtures/scripted-wallet"
import { derivePanelModel } from "./model"
import { StocksWalletExecutionPanel } from "./StocksWalletExecutionPanel"

const ORDER = { BUY: "fixture-order-a-buy-1", SELL: "fixture-order-a-sell-1" } as const
const FIRST_HASH = sha256(toHex("fixture-transaction-1"))

async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let j = 0; j < 50; j++) await Promise.resolve()
  }
}

function harness(side: Side = "BUY") {
  const f = createScriptedWallet()
  const controller = createStocksWalletController(f.ports)
  const counted = countControllerActions(controller)
  let orderId: string = ORDER[side]
  const selection = () => f.selection(orderId)
  const account = () => f.context().walletAddress
  // Mirrors useStocksWalletPanel: every render selects the displayed order before actions are bound.
  const actions = () => {
    counted.api.select(selection())
    const bound = selection()
    return stocksWalletPanelActions(counted.api, {
      orderId,
      side: bound.side,
      account: account(),
      ready: () => executionAvailability({ configured: true, ports: f.ports, context: f.context(), selection: bound, now: f.now() }).status === "READY",
    })
  }
  const model = () => {
    counted.api.select(selection())
    return derivePanelModel({
      snapshot: counted.api.getSnapshot(),
      selection: selection(),
      account: account(),
      availability: executionAvailability({ configured: true, ports: f.ports, context: f.context(), selection: selection(), now: f.now() }),
      now: f.now(),
    })
  }
  const render = () => renderToStaticMarkup(<StocksWalletExecutionPanel controller={counted.api} ports={f.ports} selection={selection()} tickMs={0} />)
  const asyncReads = () => Object.entries(f.reads).reduce((sum, [name, count]) => (name === "context" ? sum : sum + count), 0)
  return {
    f,
    controller,
    calls: counted.calls,
    actions,
    model,
    render,
    asyncReads,
    selectOrder(id: string) {
      orderId = id
      counted.api.select(selection())
    },
    switchAccount(who: FixtureAccount, id: string) {
      f.controls.setAccount(who)
      orderId = id
      counted.api.select(selection())
    },
  }
}

test("rendering and host state changes make no wallet request, no port read and no action call", () => {
  const h = harness()
  const steps: [string, () => void][] = [
    ["mount", () => undefined],
    ["re-render", () => undefined],
    ["account B", () => h.switchAccount("B", "fixture-order-b-buy-1")],
    ["account A", () => h.switchAccount("A", ORDER.BUY)],
    ["order switch", () => h.selectOrder(ORDER.SELL)],
    ["reconnect", () => h.f.controls.reconnect()],
    ["clock", () => h.f.controls.advance(30_000)],
    ["sign out", () => h.f.controls.setSignedIn(false)],
    ["sign in", () => h.f.controls.setSignedIn(true)],
    ["review removed", () => h.f.controls.setReviewed(false)],
    ["review restored", () => h.f.controls.setReviewed(true)],
    ["server state", () => h.f.controls.setServerState(ORDER.SELL, "SELL_BROKER_PENDING")],
    ["expiry", () => h.f.controls.advance(900_000)],
  ]
  for (const [label, change] of steps) {
    change()
    h.render()
    h.model()
    assert.equal(h.f.requests.length, 0, label)
    assert.equal(h.asyncReads(), 0, `${label}: no async port read without an explicit action`)
    assert.deepEqual(h.calls, { prepare: 0, approve: 0, submit: 0 }, label)
  }
  h.controller.dispose()
})

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: approval completion never submits; each explicit action makes exactly its own wallet request`, async () => {
    const h = harness(side)
    await h.actions().prepare()
    assert.equal(h.model().kind, "APPROVAL_REQUIRED")
    assert.equal(h.f.requests.length, 0, "a check never opens the wallet")
    await h.actions().approve()
    await flush()
    const ready = h.model()
    assert.equal(ready.kind, "READY_TRANSFER")
    assert.equal(h.f.requests.length, 1)
    assert.equal(h.f.requests[0]!.to.toLowerCase(), (side === "BUY" ? h.f.manifest.cashToken : h.f.manifest.stockToken).toLowerCase(), "the one request is the approval")
    // Renders, clock and a further read-only check after approval: still no deposit/escrow.
    for (let i = 0; i < 3; i++) {
      h.render()
      h.f.controls.advance(1_000)
      await flush()
    }
    assert.equal(h.calls.submit, 0)
    assert.equal(h.f.requests.length, 1, "no automatic deposit or escrow")
    await h.actions().submit()
    assert.equal(h.f.requests.length, 2)
    assert.equal(h.f.requests[1]!.to.toLowerCase(), (side === "BUY" ? h.f.manifest.fundingVault : h.f.manifest.redemptionEscrow).toLowerCase())
    const submitted = h.model()
    assert.equal(submitted.kind, "SUBMITTED")
    assert.ok(submitted.txHash)
    assert.equal(submitted.server, null, "hash is not the order result")
    h.controller.dispose()
  })
}

test("duplicate approve and submit invocations issue one wallet request each", async () => {
  const h = harness()
  await h.actions().prepare()
  const actions = h.actions()
  await Promise.all([actions.approve(), actions.approve(), h.actions().approve()])
  await flush()
  assert.equal(h.f.requests.length, 1)
  const ready = h.actions()
  await Promise.all([ready.submit(), ready.submit()])
  await flush()
  assert.equal(h.f.requests.length, 2)
  await h.actions().submit()
  await h.actions().approve()
  assert.equal(h.f.requests.length, 2, "a submitted order is never signed again")
  h.controller.dispose()
})

test("actions bound to a previous account or order do nothing", async () => {
  const h = harness()
  await h.actions().prepare()
  const stale = h.actions()
  h.switchAccount("B", "fixture-order-b-buy-1")
  await stale.approve()
  await stale.submit()
  assert.equal(h.calls.approve, 0)
  assert.equal(h.f.requests.length, 0)
  h.switchAccount("A", ORDER.BUY)
  const staleOrder = h.actions()
  await h.actions().prepare()
  h.selectOrder(ORDER.SELL)
  await staleOrder.approve()
  assert.equal(h.calls.approve, 0)
  assert.equal(h.f.requests.length, 0)
  h.controller.dispose()
})

test("account switch while the wallet prompt is open: B never sees A's transaction; A's late hash stays with A", async () => {
  const h = harness()
  h.f.controls.setWalletMode("hold")
  h.f.controls.setReconcileMode("pending")
  await h.actions().prepare()
  void h.actions().approve()
  for (let i = 0; i < 20 && h.f.state().held === 0; i++) await flush()
  assert.equal(h.model().kind, "SIGNING")
  h.switchAccount("B", "fixture-order-b-buy-1")
  const b = h.model()
  assert.equal(b.kind, "IDLE")
  assert.equal(b.txHash, null)
  assert.equal(b.plan?.order.id, "fixture-order-b-buy-1")
  h.f.controls.releaseHeld()
  await flush()
  const afterLate = h.model()
  assert.equal(afterLate.txHash, null, "the late hash never paints B's screen")
  assert.doesNotMatch(h.render(), new RegExp(FIRST_HASH))
  h.switchAccount("A", ORDER.BUY)
  assert.equal(h.model().kind, "IDLE", "A→B→A starts unchecked")
  await h.actions().prepare()
  await flush()
  const back = h.model()
  assert.equal(back.kind, "APPROVAL_SUBMITTED")
  assert.equal(back.txHash, FIRST_HASH, "the durable journal restores A's own approval hash")
  assert.equal(h.f.requests.length, 1, "nothing was sent again")
  h.controller.dispose()
})

test("order switch during a check keeps the other order's data off screen", async () => {
  const h = harness()
  h.f.controls.setWalletMode("hold")
  await h.actions().prepare()
  void h.actions().approve()
  for (let i = 0; i < 20 && h.f.state().held === 0; i++) await flush()
  h.selectOrder(ORDER.SELL)
  const sell = h.model()
  assert.equal(sell.kind, "IDLE")
  assert.equal(sell.order?.orderId, ORDER.SELL)
  h.f.controls.releaseHeld()
  await flush()
  assert.equal(h.model().txHash, null)
  assert.equal(h.f.requests.length, 1)
  h.controller.dispose()
})

test("expiry: approval and transfer after the deadline issue no wallet request", async () => {
  const h = harness()
  await h.actions().prepare()
  h.f.controls.advance(600_000)
  const expired = h.model()
  assert.equal(expired.buttons[0]?.enabled, false)
  await h.actions().approve()
  await flush()
  assert.equal(h.f.requests.length, 0)
  assert.equal(h.calls.approve, 0, "the adapter refuses before reaching the controller")
  // The controller independently refuses too.
  await h.controller.approve()
  await flush()
  assert.equal(h.f.requests.length, 0)
  assert.equal(h.model().kind, "BLOCKED")
  assert.equal(h.model().code, "ORDER_EXPIRED")

  const t = harness()
  t.f.controls.setAllowance(ORDER.BUY, "300000000")
  await t.actions().prepare()
  assert.equal(t.model().kind, "READY_TRANSFER")
  t.f.controls.advance(600_000)
  await t.actions().submit()
  await flush()
  assert.equal(t.f.requests.length, 0)
  h.controller.dispose()
  t.controller.dispose()
})

test("UNKNOWN: a rejected or malformed wallet answer is never resent, even by a new controller", async () => {
  for (const mode of ["reject", "invalid"] as const) {
    const h = harness()
    h.f.controls.setWalletMode(mode)
    await h.actions().prepare()
    await h.actions().approve()
    await flush()
    const unknown = h.model()
    assert.equal(unknown.kind, "UNKNOWN", mode)
    assert.deepEqual(unknown.buttons.map((button) => button.action), ["prepare"])
    h.f.controls.setWalletMode("hash")
    await h.actions().approve()
    await h.actions().submit()
    await h.actions().prepare()
    await flush()
    assert.equal(h.model().kind, "UNKNOWN")
    assert.equal(h.f.requests.length, 1, mode)
    h.controller.dispose()
    const reloaded = createStocksWalletController(h.f.ports)
    reloaded.select(h.f.selection(ORDER.BUY))
    await reloaded.prepare()
    await reloaded.approve()
    assert.equal(reloaded.getSnapshot().status, "UNKNOWN")
    assert.equal(h.f.requests.length, 1, `${mode}: reload does not re-sign`)
    reloaded.dispose()
  }
})

test("REVERTED approval and REVERTED transfer block with their hash and offer no retry", async () => {
  const h = harness()
  h.f.controls.setReconcileMode("revert")
  await h.actions().prepare()
  await h.actions().approve()
  await flush()
  const approval = h.model()
  assert.equal(approval.kind, "BLOCKED")
  assert.equal(approval.code, "APPROVAL_REVERTED")
  assert.equal(approval.txHash, FIRST_HASH)
  assert.equal(approval.buttons.length, 0)
  await h.actions().prepare()
  await h.actions().approve()
  assert.equal(h.f.requests.length, 1)
  h.controller.dispose()

  const t = harness("SELL")
  await t.actions().prepare()
  await t.actions().approve()
  await flush()
  await t.actions().submit()
  assert.equal(t.model().kind, "SUBMITTED")
  assert.equal(t.f.controls.revertTransfer(ORDER.SELL), true)
  await t.actions().prepare()
  await flush()
  const transfer = t.model()
  assert.equal(transfer.kind, "BLOCKED")
  // The controller's follow-up code here is RECOVERY_REQUIRED; the recorded stage identifies the revert.
  assert.equal(t.controller.getSnapshot().stage, "TRANSFER")
  assert.equal(transfer.code, "TRANSFER_REVERTED")
  assert.equal(transfer.title, "Escrow reverted")
  assert.ok(transfer.txHash)
  assert.equal(transfer.buttons.length, 0)
  await t.actions().submit()
  await t.actions().prepare()
  assert.equal(t.f.requests.length, 2)
  t.controller.dispose()
})

test("missing review evidence, policy, reconciliation or a denied policy: disabled screen, controller fails closed, 0 requests", async () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void, string][] = [
    ["review", (h) => h.f.controls.setReviewed(false), "DEPLOYMENT_NOT_REVIEWED"],
    ["policy port", (h) => h.f.controls.setPortPresent("readExecutionPolicy", false), "CURRENT_POLICY_REQUIRED"],
    ["reconciliation", (h) => h.f.controls.setPortPresent("reconcile", false), "TRUSTED_RECONCILIATION_REQUIRED"],
  ]
  for (const [label, change, code] of cases) {
    const h = harness()
    change(h)
    const model = h.model()
    assert.equal(model.kind, "UNAVAILABLE", label)
    assert.equal(model.code, code, label)
    assert.equal(model.buttons[0]?.enabled, false)
    await h.actions().prepare()
    await h.actions().approve()
    assert.equal(h.f.requests.length, 0, label)
    h.controller.dispose()
  }
  // Why the adapter re-checks availability itself: called directly, the existing controller opens the
  // approval request without trusted reconciliation and only fails afterwards (an approval that can
  // never be confirmed). The panel adapter never lets that request start.
  const direct = harness()
  direct.f.controls.setPortPresent("reconcile", false)
  direct.controller.select(direct.f.selection(ORDER.BUY))
  await direct.controller.prepare()
  await direct.controller.approve()
  assert.equal(direct.f.requests.length, 1, "controller-only behavior (unchanged by this module)")
  direct.controller.dispose()

  const denied = harness()
  denied.f.controls.setPolicyAllowed(false)
  await denied.actions().prepare()
  const blocked = denied.model()
  assert.equal(blocked.kind, "BLOCKED")
  assert.equal(blocked.code, "EXECUTION_NOT_ALLOWED")
  assert.equal(denied.f.requests.length, 0)
  denied.controller.dispose()
})

test("the connected panel renders not configured without a controller or ports", () => {
  const html = renderToStaticMarkup(<StocksWalletExecutionPanel controller={null} ports={null} selection={createScriptedWallet().selection(ORDER.BUY)} tickMs={0} />)
  assert.match(html, /data-status="UNAVAILABLE"/)
  assert.match(html, /Wallet execution is not configured in this app/)
  assert.doesNotMatch(html, /fixture-order-a-buy-1/, "no signed-in account, so no order details")
})
