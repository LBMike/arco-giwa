import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { sha256, toHex, type Hex } from "viem"

import { planOrder } from "../stocks-wallet/planner"
import type { Stage, WalletSnapshot } from "../stocks-wallet/types"
import { executionAvailability } from "./availability"
import { createScriptedWallet, FIXTURE_WALLETS } from "./fixtures/scripted-wallet"
import { describeCode } from "./messages"
import { bindSnapshot, derivePanelModel, IDLE_SNAPSHOT, type PanelInput } from "./model"

const APPROVAL_HASH: Hex = sha256(toHex("model-approval"))
const TRANSFER_HASH: Hex = sha256(toHex("model-transfer"))

function setup(orderId = "fixture-order-a-buy-1") {
  const f = createScriptedWallet()
  if (orderId.includes("-b-")) f.controls.setAccount("B")
  const selection = f.selection(orderId)
  const context = f.context()
  const now = f.now()
  const plan = planOrder(selection, context, now)
  const availability = executionAvailability({ configured: true, ports: f.ports, context, selection, now })
  const snap = (status: WalletSnapshot["status"], stage: Stage | null = null, txHash: Hex | null = null, error: string | null = null): WalletSnapshot =>
    Object.freeze({ status, orderId: plan.order.id, intentKey: plan.intentKey, stage, txHash, error, plan })
  const model = (snapshot: WalletSnapshot, extra: Partial<PanelInput> = {}) => derivePanelModel({ snapshot, selection, account: context.walletAddress, availability, now, ...extra })
  return { f, selection, context, now, plan, availability, snap, model }
}

const text = (model: ReturnType<typeof derivePanelModel>) => [model.title, ...model.paragraphs, ...model.buttons.map((button) => button.label), ...model.steps.map((step) => step.detail), model.server?.label ?? ""].join(" ")

test("every controller status maps to its own panel with at most one enabled action", () => {
  const s = setup()
  const cases: [WalletSnapshot, string, string | null, boolean][] = [
    [IDLE_SNAPSHOT, "IDLE", "prepare", true],
    [s.snap("CHECKING"), "CHECKING", null, false],
    [s.snap("APPROVAL_REQUIRED"), "APPROVAL_REQUIRED", "approve", true],
    [s.snap("SIGNING", "APPROVAL"), "SIGNING", null, false],
    [s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECEIPT_PENDING"), "APPROVAL_SUBMITTED", "prepare", true],
    [s.snap("READY_TRANSFER"), "READY_TRANSFER", "submit", true],
    [s.snap("SIGNING", "TRANSFER"), "SIGNING", null, false],
    [s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), "SUBMITTED", "prepare", true],
    [s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN"), "UNKNOWN", "prepare", true],
    [s.snap("BLOCKED", "APPROVAL", APPROVAL_HASH, "APPROVAL_REVERTED"), "BLOCKED", null, false],
  ]
  for (const [snapshot, kind, enabledAction, hasEnabled] of cases) {
    const model = s.model(snapshot)
    assert.equal(model.kind, kind, `${snapshot.status}`)
    const enabled = model.buttons.filter((button) => button.enabled)
    assert.ok(enabled.length <= 1, `${kind}: one action at most`)
    assert.equal(enabled.length === 1, hasEnabled, `${kind}: enabled action`)
    if (enabledAction) assert.equal(enabled[0]?.action, enabledAction, kind)
    assert.ok(!model.buttons.some((button) => button.action === "approve") || !model.buttons.some((button) => button.action === "submit"), `${kind}: approve and deposit are never offered together`)
    assert.ok(model.order !== null && model.announcement.startsWith(model.title), kind)
  }
})

test("SIGNING disables every action; approval and transfer buttons are wallet-opening, checks are not", () => {
  const s = setup()
  for (const stage of ["APPROVAL", "TRANSFER"] as const) {
    const model = s.model(s.snap("SIGNING", stage))
    assert.deepEqual(model.buttons.map((button) => [button.action, button.enabled, button.opensWallet]), [[stage === "APPROVAL" ? "approve" : "submit", false, true]])
    assert.match(model.paragraphs.join(" "), /open in your wallet/)
  }
  assert.equal(s.model(s.snap("APPROVAL_REQUIRED")).buttons[0]?.opensWallet, true)
  assert.equal(s.model(s.snap("READY_TRANSFER")).buttons[0]?.opensWallet, true)
  assert.equal(s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH)).buttons[0]?.opensWallet, false)
})

test("exact approval, deposit and escrow amounts; the smallest amount is never rounded to zero", () => {
  const buy = setup().model(IDLE_SNAPSHOT)
  assert.equal(buy.order?.approval.text, "300 ARCO_TEST_USDC")
  assert.equal(buy.order?.transfer.baseUnits, "300000000")
  assert.equal(buy.order?.quantity.text, "2.5 NVDA")
  assert.equal(buy.order?.payout, null)
  const sellSetup = setup("fixture-order-a-sell-1")
  const sell = sellSetup.model(sellSetup.snap("READY_TRANSFER"))
  assert.equal(sell.order?.approval.text, "0.123456789 NVDA")
  assert.equal(sell.order?.transfer.scale, 9)
  assert.equal(sell.order?.payout?.text, "14.814814 ARCO_TEST_USDC")
  assert.equal(sell.buttons[0]?.label, "Escrow 0.123456789 NVDA")
  const smallSetup = setup("fixture-order-b-buy-1")
  const small = smallSetup.model(smallSetup.snap("APPROVAL_REQUIRED"))
  assert.equal(small.order?.approval.text, "0.000001 ARCO_TEST_USDC")
  assert.equal(small.order?.quantity.text, "0.000000001 NVDA")
  assert.equal(small.buttons[0]?.label, "Approve 0.000001 ARCO_TEST_USDC")
  assert.doesNotMatch(text(small), /\b0 ARCO_TEST_USDC|\b0 NVDA/)
})

test("a hash, a confirmed approval or a submitted transfer is never shown as order completion", () => {
  const s = setup()
  for (const snapshot of [s.snap("READY_TRANSFER"), s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH)]) {
    const model = s.model(snapshot)
    assert.equal(model.server, null)
    // No status label claims completion; the explanatory text may only say what completion requires.
    assert.doesNotMatch(text(model), /\bCompleted\b|\bFilled\b|holdings increased/)
    assert.ok(![model.title, ...model.steps.map((step) => step.detail)].some((label) => /complete|filled|settled/i.test(label)), snapshot.status)
  }
  const submitted = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH))
  assert.equal(submitted.txHash, TRANSFER_HASH)
  assert.equal(submitted.steps[2]?.detail, "Waiting for the server")
  assert.match(submitted.paragraphs[0]!, /not the order result/)
  const completed = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { serverOrder: { orderId: s.plan.order.id, side: "BUY", state: "COMPLETED", observedAt: new Date(s.now).toISOString() } })
  assert.equal(completed.server?.completed, true)
  assert.equal(completed.steps[2]?.status, "done")
  // Only the SAME order's server state counts.
  const otherOrder = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { serverOrder: { orderId: "fixture-order-a-sell-1", side: "SELL", state: "COMPLETED", observedAt: null } })
  assert.equal(otherOrder.server, null)
  const unrecognized = s.model(IDLE_SNAPSHOT, { serverOrder: { orderId: s.plan.order.id, side: "BUY", state: "SETTLED_MAYBE", observedAt: null } })
  assert.equal(unrecognized.server?.completed, false)
  assert.equal(unrecognized.server?.category, "UNRECOGNIZED")
})

test("scope binding: another account's or order's snapshot renders as not checked, without hash or stage", () => {
  const a = setup()
  const aSubmitted = a.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH)
  const b = setup("fixture-order-b-buy-1")
  const underB = derivePanelModel({ snapshot: aSubmitted, selection: b.selection, account: b.context.walletAddress, availability: b.availability, now: b.now })
  assert.equal(underB.kind, "IDLE")
  assert.equal(underB.txHash, null)
  assert.equal(underB.snapshot, IDLE_SNAPSHOT)
  assert.equal(underB.plan?.order.id, "fixture-order-b-buy-1")
  const sell = setup("fixture-order-a-sell-1")
  const otherOrder = derivePanelModel({ snapshot: aSubmitted, selection: sell.selection, account: sell.context.walletAddress, availability: sell.availability, now: sell.now })
  assert.equal(otherOrder.txHash, null)
  assert.equal(otherOrder.kind, "IDLE")
  assert.equal(bindSnapshot(aSubmitted, b.plan.order, "BUY", FIXTURE_WALLETS.B), IDLE_SNAPSHOT)
  assert.equal(bindSnapshot(aSubmitted, a.plan.order, "SELL", FIXTURE_WALLETS.A), IDLE_SNAPSHOT, "side must match")
  assert.equal(bindSnapshot(aSubmitted, a.plan.order, "BUY", FIXTURE_WALLETS.A), aSubmitted)
  const errorOnly = Object.freeze({ ...IDLE_SNAPSHOT, status: "BLOCKED" as const, error: "READ_TIMEOUT" })
  assert.equal(bindSnapshot(errorOnly, a.plan.order, "BUY", FIXTURE_WALLETS.A), errorOnly)
  assert.equal(bindSnapshot({ ...errorOnly, txHash: TRANSFER_HASH }, a.plan.order, "BUY", FIXTURE_WALLETS.A), IDLE_SNAPSHOT)
})

test("order details are shown only to the signed-in wallet that placed the order", () => {
  const s = setup()
  const snapshot = s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH)
  for (const [account, code] of [
    [null, "SESSION_REQUIRED"],
    [FIXTURE_WALLETS.B, "WALLET_MISMATCH"],
  ] as const) {
    const model = s.model(snapshot, { account })
    assert.equal(model.kind, "UNAVAILABLE")
    assert.equal(model.code, code)
    assert.equal(model.order, null)
    assert.equal(model.plan, null)
    assert.equal(model.txHash, null)
    assert.deepEqual(model.buttons.map((button) => button.enabled), [false])
    assert.doesNotMatch(text(model), /fixture-order|300|0x/)
  }
  assert.equal(s.model(snapshot, { selection: null }).code, "ORDER_REQUIRED")
  assert.equal(s.model(snapshot, { selection: { side: "BUY", order: { id: "x" } } }).code, "INVALID_ORDER")
  // A READY plan for a different order is never used.
  const other = setup("fixture-order-a-sell-1")
  const mismatched = s.model(IDLE_SNAPSHOT, { availability: other.availability })
  assert.equal(mismatched.code, "ORDER_SCOPE_MISMATCH")
  assert.equal(mismatched.buttons[0]?.enabled, false)
})

test("expiry disables approval and transfer; late submissions keep their hash", () => {
  const s = setup()
  const later = Date.parse(s.plan.order.quoteExpiresAt)
  const expiredAvailability = executionAvailability({ configured: true, ports: s.f.ports, context: s.context, selection: s.selection, now: later })
  assert.deepEqual(expiredAvailability, { status: "UNAVAILABLE", code: "ORDER_EXPIRED" })
  const idle = s.model(IDLE_SNAPSHOT, { now: later, availability: expiredAvailability })
  assert.equal(idle.kind, "UNAVAILABLE")
  assert.equal(idle.title, "Quote deadline passed")
  assert.equal(idle.order?.expired, true)
  assert.match(text(idle), /Do not send test cash for this order/)
  for (const status of ["APPROVAL_REQUIRED", "READY_TRANSFER"] as const) {
    const model = s.model(s.snap(status), { now: later })
    assert.equal(model.buttons[0]?.enabled, false, status)
    assert.match(model.paragraphs.join(" "), /quote deadline has passed/)
  }
  const late = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { now: later })
  assert.equal(late.txHash, TRANSFER_HASH)
  assert.equal(late.buttons[0]?.enabled, false)
  assert.equal(s.model(IDLE_SNAPSHOT, { now: Number.NaN }).order?.expired, true, "an unusable clock fails closed")
  const sell = setup("fixture-order-a-sell-1")
  const serverExpired = sell.model(sell.snap("READY_TRANSFER"), { serverOrder: { orderId: sell.plan.order.id, side: "SELL", state: "EXPIRED", observedAt: new Date(sell.now).toISOString() } })
  assert.equal(serverExpired.buttons[0]?.enabled, false)
  assert.match(text(serverExpired), /Do not escrow units for this order/)
})

test("UNKNOWN never offers a resend and REVERTED offers no retry", () => {
  const s = setup()
  for (const stage of ["APPROVAL", "TRANSFER"] as const) {
    const unknown = s.model(s.snap("UNKNOWN", stage, null, "WALLET_OUTCOME_UNKNOWN"))
    assert.deepEqual(unknown.buttons.map((button) => button.action), ["prepare"])
    assert.match(unknown.paragraphs.join(" "), /does not send it again/)
    assert.equal(unknown.steps[stage === "APPROVAL" ? 0 : 1]?.status, "problem")
  }
  const approval = s.model(s.snap("BLOCKED", "APPROVAL", APPROVAL_HASH, "APPROVAL_REVERTED"))
  assert.equal(approval.title, "Approval reverted")
  assert.equal(approval.txHash, APPROVAL_HASH)
  assert.equal(approval.buttons.length, 0)
  assert.equal(approval.tone, "error")
  const transfer = s.model(s.snap("BLOCKED", "TRANSFER", TRANSFER_HASH, "TRANSFER_REVERTED"))
  assert.equal(transfer.title, "Deposit reverted")
  assert.equal(transfer.txLabel, "Deposit transaction")
  assert.equal(transfer.buttons.length, 0)
  assert.equal(transfer.steps[0]?.status, "done")
  assert.equal(transfer.steps[1]?.status, "problem")
})

test("missing configuration or evidence disables execution without any port read", () => {
  const s = setup()
  const variants: [string, () => ReturnType<typeof executionAvailability>][] = [
    ["NOT_CONFIGURED", () => executionAvailability({ configured: false, ports: s.f.ports, context: s.context, selection: s.selection, now: s.now })],
    ["NOT_CONFIGURED", () => executionAvailability({ configured: true, ports: null, context: s.context, selection: s.selection, now: s.now })],
    [
      "CURRENT_POLICY_REQUIRED",
      () => {
        const { readExecutionPolicy: _removed, ...ports } = s.f.ports
        return executionAvailability({ configured: true, ports, context: s.context, selection: s.selection, now: s.now })
      },
    ],
    ["DURABLE_SUBMISSION_GATE_REQUIRED", () => executionAvailability({ configured: true, ports: { ...s.f.ports, submissions: undefined as never }, context: s.context, selection: s.selection, now: s.now })],
    [
      "TRUSTED_RECONCILIATION_REQUIRED",
      () => {
        const { reconcile: _removed, ...submissions } = s.f.ports.submissions
        return executionAvailability({ configured: true, ports: { ...s.f.ports, submissions }, context: s.context, selection: s.selection, now: s.now })
      },
    ],
    ["DEPLOYMENT_NOT_REVIEWED", () => executionAvailability({ configured: true, ports: s.f.ports, context: { ...s.context, deployment: null }, selection: s.selection, now: s.now })],
    ["SESSION_REQUIRED", () => executionAvailability({ configured: true, ports: s.f.ports, context: { ...s.context, session: null }, selection: s.selection, now: s.now })],
    ["WALLET_MISMATCH", () => executionAvailability({ configured: true, ports: s.f.ports, context: { ...s.context, walletAddress: FIXTURE_WALLETS.B }, selection: s.selection, now: s.now })],
    ["INVALID_CONTEXT", () => executionAvailability({ configured: true, ports: s.f.ports, context: { ...s.context, apiBase: "not a url" }, selection: s.selection, now: s.now })],
  ]
  const before = { ...s.f.reads }
  for (const [code, run] of variants) {
    const availability = run()
    assert.deepEqual(availability, { status: "UNAVAILABLE", code }, code)
    const model = s.model(IDLE_SNAPSHOT, { availability })
    assert.equal(model.kind, "UNAVAILABLE", code)
    assert.deepEqual(model.buttons.map((button) => [button.action, button.enabled]), [["prepare", false]], code)
  }
  assert.deepEqual(s.f.reads, before, "availability performs no port call")
  assert.equal(s.f.requests.length, 0)
})

test("every stable code the wallet planner and controller can report has a specific reason", () => {
  const sources = ["../stocks-wallet/controller.ts", "../stocks-wallet/planner.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")
  const NOT_CODES = new Set(["APPROVAL_REQUIRED", "READY_TRANSFER", "APPROVAL_SUBMITTED", "REQUEST_MAY_START", "DEMO_TESTNET", "TEST_VALUE_ONLY", "MOCK_BROKER", "FIXED_MOCK_PRICE", "ARCO_TEST_USDC", "CHECK_PAUSE_AT_ORDER", "AWAITING_FUNDING", "AWAITING_ESCROW"])
  // Pure validation failures deliberately share the generic "failed validation" text.
  const VALIDATION = new Set(["INVALID_ADDRESS", "INVALID_HASH", "INVALID_AMOUNT", "INVALID_ID", "INVALID_API_BASE", "INVALID_SIDE", "ORDER_SIDE_MISMATCH", "INVALID_ORDER", "ORDER_KEY_MISMATCH", "ORDER_PRICE_MISMATCH", "TRANSACTION_MISMATCH", "INVALID_CONTEXT"])
  const codes = new Set([...sources.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)].map((match) => match[1]!).filter((code) => !NOT_CODES.has(code)))
  assert.ok(codes.size >= 45, `found ${codes.size} codes`)
  const generic = describeCode("SOMETHING_NEW", "BUY")
  for (const code of codes) {
    const described = describeCode(code, "BUY")
    if (VALIDATION.has(code)) assert.deepEqual(described, generic, code)
    else assert.notDeepEqual(described, generic, `${code} needs a specific reason and next step`)
  }
  assert.match(describeCode("TRANSFER_REVERTED", "SELL").reason, /escrow transaction reverted/)
  assert.equal(describeCode("READ_TIMEOUT", "BUY").step, "CHECK_AGAIN")
  assert.equal(describeCode("APPROVAL_REVERTED", "BUY").step, "RECOVERY")
})
