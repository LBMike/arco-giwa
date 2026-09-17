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
import { derivePanelModel, serverOrderAwaitsTransfer } from "./model"
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
  // Defense in depth: called directly (bypassing the adapter's availability check), the controller itself
  // refuses an approval without trusted reconciliation before any claim or wallet request (003A A3).
  for (const side of ["BUY", "SELL"] as const) {
    const direct = harness(side)
    direct.f.controls.setPortPresent("reconcile", false)
    direct.controller.select(direct.f.selection(ORDER[side]))
    await direct.controller.prepare()
    await direct.controller.approve()
    assert.equal(direct.f.requests.length, 0, `${side}: direct controller call opens no wallet`)
    assert.equal(direct.f.reads.claim, 0, `${side}: and consumes no durable claim`)
    assert.deepEqual([direct.controller.getSnapshot().status, direct.controller.getSnapshot().error], ["BLOCKED", "TRUSTED_RECONCILIATION_REQUIRED"])
    direct.controller.dispose()
  }

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

test("through the adapter: signed out, or a session for another wallet, renders no order details", () => {
  const f = createScriptedWallet()
  const controller = createStocksWalletController(f.ports)
  const selection = f.selection(ORDER.SELL)
  const render = (ports: typeof f.ports) => renderToStaticMarkup(<StocksWalletExecutionPanel controller={controller} ports={ports} selection={selection} tickMs={0} />)
  const leaked = new RegExp(`${ORDER.SELL}|0\\.123456789 NVDA|14\\.814814|${f.manifest.redemptionEscrow}|Sell NVDA`)
  assert.match(render(f.ports), leaked, "baseline: the owner sees the order")
  f.controls.setSignedIn(false)
  const signedOut = render(f.ports)
  assert.doesNotMatch(signedOut, leaked)
  assert.match(signedOut, /Code <span class="font-mono">SESSION_REQUIRED<\/span>/)
  f.controls.setSignedIn(true)
  // Connected wallet B while the session belongs to A.
  const otherWallet = { ...f.ports, context: () => ({ ...f.context(), walletAddress: "0x2222222222222222222222222222222222222222" }) }
  const mismatched = render(otherWallet)
  assert.doesNotMatch(mismatched, leaked)
  assert.match(mismatched, /data-status="UNAVAILABLE"/)
  assert.equal(f.requests.length, 0)
  controller.dispose()
})

test("a server status showing the order moved on makes approve and submit refuse, even when called directly", async () => {
  for (const [start, action] of [
    ["APPROVAL_REQUIRED", "approve"],
    ["READY_TRANSFER", "submit"],
  ] as const) {
    const h = harness()
    if (start === "READY_TRANSFER") h.f.controls.setAllowance(ORDER.BUY, "300000000")
    await h.actions().prepare()
    assert.equal(h.model().kind, start)
    h.f.controls.setServerState(ORDER.BUY, "BROKER_PENDING")
    const serverOrder = h.f.serverOrder(ORDER.BUY)
    const bound = h.f.selection(ORDER.BUY)
    const guarded = stocksWalletPanelActions(h.controller, {
      orderId: ORDER.BUY,
      side: "BUY",
      account: h.f.context().walletAddress,
      ready: () => executionAvailability({ configured: true, ports: h.f.ports, context: h.f.context(), selection: bound, now: h.f.now() }).status === "READY",
      signable: () => serverOrderAwaitsTransfer(serverOrder, ORDER.BUY, "BUY"),
    })
    await guarded[action]()
    await flush()
    assert.equal(h.f.requests.length, 0, action)
    assert.equal(h.controller.getSnapshot().status, start, "the controller was not invoked")
    h.controller.dispose()
  }
})

test("real controller: a confirmed approval followed by a paused policy reads 'approval sent', and recovers with a check", async () => {
  const h = harness()
  await h.actions().prepare()
  await h.actions().approve()
  await flush()
  assert.equal(h.model().kind, "READY_TRANSFER")
  h.f.controls.setPolicyAllowed(false)
  await h.actions().submit()
  await flush()
  const paused = h.model()
  assert.equal(h.controller.getSnapshot().status, "APPROVAL_SUBMITTED")
  assert.equal(paused.title, "Approval sent — check needed")
  assert.match(paused.paragraphs.join(" "), /Execution is not allowed for this order right now/)
  assert.equal(paused.steps[0]?.detail, "Approval sent")
  assert.equal(h.f.requests.length, 1)
  h.f.controls.setPolicyAllowed(true)
  await h.actions().prepare()
  await flush()
  assert.equal(h.model().kind, "READY_TRANSFER", "an explicit check recovers once the policy allows execution")
  assert.equal(h.f.requests.length, 1)
  h.controller.dispose()
})

test("real controller: a wallet on another network instance blocks with a read-only check that recovers", async () => {
  const h = harness()
  h.f.controls.setNetworkMatches(false)
  await h.actions().prepare()
  const blocked = h.model()
  assert.equal(blocked.kind, "BLOCKED")
  assert.equal(blocked.code, "WALLET_NETWORK_INSTANCE_MISMATCH")
  assert.deepEqual(blocked.buttons.map((button) => [button.label, button.enabled]), [["Check again", true]])
  h.f.controls.setNetworkMatches(true)
  await h.actions().prepare()
  assert.equal(h.model().kind, "APPROVAL_REQUIRED")
  assert.equal(h.f.requests.length, 0)
  h.controller.dispose()
})

// GIWA-STOCKS-WALLET-INTEGRATION-003A A1/A2: the independent model review reproduced these four
// wording contradictions with the real controller (BUY/SELL). The expectations below are the
// correct ones; they failed on the reviewed candidate 68bb1ec.
function reviewed(h: ReturnType<typeof harness>, side: Side) {
  const orderId = ORDER[side]
  return (serverOrder: ReturnType<typeof h.f.serverOrder> | null = null) => {
    const selection = h.f.selection(orderId)
    h.controller.select(selection)
    return derivePanelModel({
      snapshot: h.controller.getSnapshot(),
      selection,
      account: h.f.context().walletAddress,
      availability: executionAvailability({ configured: true, ports: h.f.ports, context: h.f.context(), selection, now: h.f.now() }),
      now: h.f.now(),
      serverOrder,
    })
  }
}
const UNCONFIRMED_CLAIM = /server has not confirmed the approval yet|submitted — confirming/i

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: cancelling a later check never relabels a server-confirmed approval as unconfirmed (A1)`, async () => {
    const h = harness(side)
    const view = reviewed(h, side)
    try {
      await h.actions().prepare()
      await h.actions().approve()
      await flush()
      assert.equal(h.controller.getSnapshot().status, "READY_TRANSFER")
      const approval = [...h.f.journal().values()].find((row) => row.stage === "APPROVAL")
      assert.equal(approval?.status, "CONFIRMED")
      h.f.controls.setHoldReads(true)
      const reading = h.controller.prepare()
      await new Promise((resolve) => setImmediate(resolve))
      h.controller.cancel()
      h.f.controls.releaseReads()
      await reading
      // The unchanged controller republishes the known approval with RECOVERY_REQUIRED after cancel.
      assert.deepEqual([h.controller.getSnapshot().status, h.controller.getSnapshot().error], ["APPROVAL_SUBMITTED", "RECOVERY_REQUIRED"])
      const model = view()
      assert.doesNotMatch([model.title, ...model.paragraphs, model.announcement].join(" "), UNCONFIRMED_CLAIM)
      assert.notEqual(model.steps[0]?.detail, "Confirming")
      assert.equal(model.title, "Approval sent — check needed")
      assert.equal(model.txHash, approval?.txHash, "the approval hash stays visible")
      assert.deepEqual(model.buttons.map((button) => [button.action, button.opensWallet]), [["prepare", false]], "only a read-only check is offered")
      assert.equal(h.f.requests.length, 1)
      // The explicit check reads the confirmed record again: the separate deposit/escrow step returns, nothing is re-sent.
      await h.actions().prepare()
      await flush()
      assert.equal(view().kind, "READY_TRANSFER")
      assert.equal(h.f.requests.length, 1)
    } finally {
      h.f.controls.releaseReads()
      h.controller.dispose()
    }
  })

  test(`${side}: "confirming" is kept only for evidence of a pending server verification (A1)`, async () => {
    const h = harness(side)
    const view = reviewed(h, side)
    try {
      h.f.controls.setReconcileMode("pending")
      await h.actions().prepare()
      await h.actions().approve()
      await flush()
      assert.deepEqual([h.controller.getSnapshot().status, h.controller.getSnapshot().error], ["APPROVAL_SUBMITTED", "RECEIPT_PENDING"])
      const pending = view()
      assert.equal(pending.title, "Approval submitted — confirming")
      assert.match(pending.paragraphs.join(" "), /server has not confirmed the approval yet/)
      assert.equal(pending.steps[0]?.detail, "Confirming")
      // An explicit check that still finds it pending ends in the controller's ambiguous RECOVERY_REQUIRED.
      await h.actions().prepare()
      await flush()
      assert.deepEqual([h.controller.getSnapshot().status, h.controller.getSnapshot().error], ["APPROVAL_SUBMITTED", "RECOVERY_REQUIRED"])
      const checked = view()
      assert.doesNotMatch([checked.title, ...checked.paragraphs].join(" "), UNCONFIRMED_CLAIM)
      assert.match(checked.paragraphs.join(" "), /needs another check/)
      assert.equal(checked.buttons[0]?.enabled, true)
      assert.equal(h.f.requests.length, 1)
    } finally {
      h.controller.dispose()
    }
  })

  test(`${side}: a final server result replaces the waiting wording of a recorded ${side === "BUY" ? "deposit" : "escrow"} (A2)`, async () => {
    const h = harness(side)
    const view = reviewed(h, side)
    const orderId = ORDER[side]
    const NO_RESULT = /server has not reported a final result/i
    try {
      h.f.controls.setAllowance(orderId, "999999999999")
      await h.actions().prepare()
      await h.actions().submit()
      await h.actions().prepare()
      await flush()
      assert.deepEqual([h.controller.getSnapshot().status, h.controller.getSnapshot().error], ["SUBMITTED", "RECOVERY_REQUIRED"])
      const hash = h.controller.getSnapshot().txHash
      const without = view()
      assert.doesNotMatch(without.paragraphs.join(" "), NO_RESULT, "without a server status nothing is asserted about the server")
      assert.match(without.paragraphs.join(" "), /No final order result/)

      h.f.controls.setServerState(orderId, side === "BUY" ? "BROKER_PENDING" : "SELL_BROKER_PENDING")
      const processing = view(h.f.serverOrder(orderId))
      assert.match(processing.paragraphs.join(" "), /not a final result yet/)

      for (const state of side === "BUY" ? ["COMPLETED", "REFUNDED"] : ["COMPLETED", "RETURNED"]) {
        h.f.controls.setServerState(orderId, state)
        const final = view(h.f.serverOrder(orderId))
        const shown = [final.title, ...final.paragraphs, final.announcement].join(" ")
        assert.doesNotMatch(shown, NO_RESULT, state)
        assert.doesNotMatch(shown, /not a final result|No final order result/, state)
        assert.match(final.paragraphs.join(" "), /server reports a final result for this order/, state)
        assert.equal(final.server?.completed, state === "COMPLETED", `${state}: only COMPLETED is completion`)
        assert.equal(final.txHash, hash, "the recorded hash is still shown, never as the result")
        assert.deepEqual(final.buttons.map((button) => button.opensWallet), [false])
      }

      // Past the quote deadline a final server result is not described as held for review or unresolved.
      h.f.controls.setServerState(orderId, "COMPLETED")
      h.f.controls.advance(700_000)
      const late = view(h.f.serverOrder(orderId))
      assert.doesNotMatch(late.paragraphs.join(" "), /holds it for review|stays unresolved|server has not reported/i)
      assert.equal(h.f.requests.length, 1)
    } finally {
      h.controller.dispose()
    }
  })
}

// 003A-1: removing or renewing the deployment review while the wallet prompt is open keeps the same order's attempt
// on screen; the late hash is shown; nothing continues without fresh evidence and an explicit check.
for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: review evidence removed while the wallet prompt is open keeps "Confirm in your wallet", then shows the late hash`, async () => {
    const h = harness(side)
    const view = reviewed(h, side)
    try {
      h.f.controls.setWalletMode("hold")
      await h.actions().prepare()
      void h.controller.approve()
      for (let i = 0; i < 20 && h.f.state().held === 0; i++) await flush()
      assert.equal(view().kind, "SIGNING")
      h.f.controls.setReviewed(false)
      const open = view()
      assert.equal(open.kind, "SIGNING", "the open prompt is not replaced by an unavailable or unchecked screen")
      assert.match(open.paragraphs.join(" "), /open in your wallet/)
      assert.ok(open.buttons.every((button) => !button.enabled))
      h.f.controls.releaseHeld()
      await flush()
      const answered = view()
      assert.equal(answered.kind, "APPROVAL_SUBMITTED")
      assert.equal(answered.txHash, FIRST_HASH)
      assert.equal(answered.code, "EXECUTION_AUTHORITY_CHANGED")
      assert.ok(answered.buttons.every((button) => !button.opensWallet))
      assert.doesNotMatch(answered.paragraphs.join(" "), /nothing was sent|was not sent/i)
      assert.equal(h.f.reads.reconcile, 0, "no verification continues without evidence")
      assert.equal(h.f.requests.length, 1)
      // With review evidence back, an explicit check recovers the recorded approval without sending anything.
      h.f.controls.setReviewed(true)
      await h.actions().prepare()
      await flush()
      assert.equal(view().kind, "READY_TRANSFER")
      assert.equal(h.f.requests.length, 1)
    } finally {
      h.f.controls.releaseHeld()
      h.controller.dispose()
    }
  })
}

// 003B: an explicit check may first load review evidence through the host. Nothing else ever does.
test("003B: prepare loads evidence first, then checks only if the fresh availability is READY; approve and submit never load evidence", async () => {
  const log: string[] = []
  let ready = false
  let checkable = true
  const snapshot = (status: string) => ({ status, orderId: "order-1", intentKey: "intent", stage: null, txHash: null, error: null, plan: { side: "BUY", order: { wallet: "0x1111111111111111111111111111111111111111" } } })
  let shown = snapshot("IDLE")
  const controller = {
    select: () => undefined,
    refreshContext: () => undefined,
    subscribe: () => () => undefined,
    getSnapshot: () => shown,
    prepare: async () => { log.push("prepare") },
    approve: async () => { log.push("approve") },
    submit: async () => { log.push("submit") },
  } as unknown as Parameters<typeof stocksWalletPanelActions>[0]
  let refresh: () => Promise<unknown> = async () => { log.push("evidence"); ready = true }
  const actions = stocksWalletPanelActions(controller, { orderId: "order-1", side: "BUY", account: "0x1111111111111111111111111111111111111111", ready: () => ready, checkable: () => checkable, refreshEvidence: () => refresh() })

  await actions.prepare()
  assert.deepEqual(log, ["evidence", "prepare"], "evidence first, then the read-only check")

  log.length = 0
  ready = false
  refresh = async () => { log.push("evidence") }
  await actions.prepare()
  assert.deepEqual(log, ["evidence"], "evidence still missing after the read: no controller check")

  log.length = 0
  refresh = async () => { log.push("evidence"); throw new Error("offline") }
  ready = true
  await actions.prepare()
  assert.deepEqual(log, ["evidence", "prepare"], "a failed evidence read does not block a check that is otherwise ready")

  log.length = 0
  checkable = false
  await actions.prepare()
  assert.deepEqual(log, [], "nothing runs when the check is not available at activation")

  log.length = 0
  checkable = true
  ready = true
  shown = snapshot("APPROVAL_REQUIRED")
  await actions.approve()
  shown = snapshot("READY_TRANSFER")
  await actions.submit()
  assert.deepEqual(log, ["approve", "submit"], "wallet-opening steps never load evidence")
})

test("003B: without a controller the host's unavailability code is what the panel explains", () => {
  const f = createScriptedWallet()
  const selection = f.selection("fixture-order-a-buy-1")
  const unsupported = renderToStaticMarkup(<StocksWalletExecutionPanel controller={null} ports={null} selection={selection} unavailableCode="WALLET_SOURCE_UNSUPPORTED" tickMs={0} />)
  assert.match(unsupported, /cannot send exactly one transaction request from this app/)
  assert.doesNotMatch(unsupported, /not configured in this app/)
  const plain = renderToStaticMarkup(<StocksWalletExecutionPanel controller={null} ports={null} selection={selection} tickMs={0} />)
  assert.match(plain, /not configured in this app/, "no host code: the existing NOT_CONFIGURED reason")
  assert.equal((unsupported.match(/<button[^>]*data-action="(approve|submit)"/g) ?? []).length, 0)
})
