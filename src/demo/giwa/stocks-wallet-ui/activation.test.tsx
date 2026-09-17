// Activation rules without a DOM: these run in the default frontend suite even where the jsdom gate
// is skipped (CI), so the in-flight lock and the arming rule are always covered.

import assert from "node:assert/strict"
import test from "node:test"

import { planOrder } from "../stocks-wallet/planner"
import type { WalletSnapshot } from "../stocks-wallet/types"
import { armKeyFor, createActivationGate, startActivation } from "./activation"
import { executionAvailability } from "./availability"
import { createScriptedWallet } from "./fixtures/scripted-wallet"
import { derivePanelModel, IDLE_SNAPSHOT, type PanelButton } from "./model"
import type { StocksWalletPanelActions } from "./types"

function setup() {
  const f = createScriptedWallet()
  const selection = f.selection("fixture-order-a-buy-1")
  const context = f.context()
  const plan = planOrder(selection, context, f.now())
  const availability = executionAvailability({ configured: true, ports: f.ports, context, selection, now: f.now() })
  const snap = (status: WalletSnapshot["status"]): WalletSnapshot => Object.freeze({ status, orderId: plan.order.id, intentKey: plan.intentKey, stage: null, txHash: null, error: null, plan })
  const model = (snapshot: WalletSnapshot) => derivePanelModel({ snapshot, selection, account: context.walletAddress, availability, now: f.now() })
  return { snap, model }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function recorder(result?: () => Promise<void>) {
  const calls: string[] = []
  const actions: StocksWalletPanelActions = {
    prepare: () => (calls.push("prepare"), result?.()),
    approve: () => (calls.push("approve"), result?.()),
    submit: () => (calls.push("submit"), result?.()),
  }
  return { calls, actions }
}

const APPROVE: PanelButton = { action: "approve", label: "Approve", enabled: true, opensWallet: true }
const CHECK: PanelButton = { action: "prepare", label: "Check order", enabled: true, opensWallet: false }

test("one activation at a time: repeated activation before the first settles runs the action once", async () => {
  const gate = createActivationGate()
  const pending = deferred()
  const { calls, actions } = recorder(() => pending.promise)
  const armed = { key: "k", armed: "k" }
  const first = startActivation(gate, APPROVE, armed, actions)
  assert.ok(first)
  assert.equal(startActivation(gate, APPROVE, armed, actions), null)
  assert.equal(startActivation(gate, CHECK, armed, actions), null, "no other action either")
  assert.deepEqual(calls, ["approve"])
  assert.equal(gate.pending(), "approve")
  pending.resolve()
  await first
  assert.equal(gate.pending(), null)
  assert.ok(startActivation(gate, CHECK, { key: null, armed: null }, actions))
  assert.deepEqual(calls, ["approve", "prepare"])
})

test("a wallet-opening button needs arming for the exact step; checks do not", () => {
  const { calls, actions } = recorder()
  for (const arming of [
    { key: null, armed: null },
    { key: "APPROVAL_REQUIRED|approve|intent", armed: null },
    { key: "READY_TRANSFER|submit|intent", armed: "APPROVAL_REQUIRED|approve|intent" },
  ]) {
    assert.equal(startActivation(createActivationGate(), APPROVE, arming, actions), null, JSON.stringify(arming))
  }
  assert.deepEqual(calls, [])
  assert.ok(startActivation(createActivationGate(), APPROVE, { key: "k", armed: "k" }, actions))
  assert.ok(startActivation(createActivationGate(), CHECK, { key: null, armed: null }, actions))
  assert.deepEqual(calls, ["approve", "prepare"])
})

test("disabled buttons, missing actions and throwing actions", async () => {
  const { calls, actions } = recorder()
  const gate = createActivationGate()
  assert.equal(startActivation(gate, { ...CHECK, enabled: false }, { key: null, armed: null }, actions), null)
  assert.equal(startActivation(gate, CHECK, { key: null, armed: null }, null), null)
  assert.deepEqual(calls, [])
  const throwing: StocksWalletPanelActions = {
    prepare: () => {
      throw new Error("boom")
    },
    approve: () => Promise.reject(new Error("boom")),
    submit: () => undefined,
  }
  await startActivation(gate, CHECK, { key: null, armed: null }, throwing)
  assert.equal(gate.pending(), null, "a throwing action releases the gate")
  await startActivation(gate, APPROVE, { key: "k", armed: "k" }, throwing)
  assert.equal(gate.pending(), null, "a rejecting action releases the gate")
})

test("arm keys: distinct per step, none while pending, without actions or without an enabled wallet button", () => {
  const s = setup()
  const approval = s.model(s.snap("APPROVAL_REQUIRED"))
  const ready = s.model(s.snap("READY_TRANSFER"))
  const approvalKey = armKeyFor(approval, null, true)
  const readyKey = armKeyFor(ready, null, true)
  assert.ok(approvalKey && readyKey)
  assert.notEqual(approvalKey, readyKey, "arming the approval never arms the deposit")
  assert.equal(armKeyFor(approval, "prepare", true), null)
  assert.equal(armKeyFor(approval, null, false), null)
  assert.equal(armKeyFor(s.model(IDLE_SNAPSHOT), null, true), null, "a check never arms")
  assert.equal(armKeyFor(s.model(s.snap("SIGNING")), null, true), null)
  // The approval's arming does not let the deposit button through.
  const { calls, actions } = recorder()
  const submit = ready.buttons[0]!
  assert.equal(startActivation(createActivationGate(), submit, { key: readyKey, armed: approvalKey }, actions), null)
  assert.deepEqual(calls, [])
})
