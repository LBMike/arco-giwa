import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { sha256, toHex, type Hex } from "viem"

import { planOrder } from "../stocks-wallet/planner"
import type { Stage, WalletSnapshot } from "../stocks-wallet/types"
import { executionAvailability } from "./availability"
import { createScriptedWallet, FIXTURE_WALLETS } from "./fixtures/scripted-wallet"
import { describeCode } from "./messages"
import { bindSnapshot, derivePanelModel, IDLE_SNAPSHOT, serverOrderAwaitsTransfer, type PanelInput } from "./model"

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

/** Any claim of order completion or a holding change. The one allowed sentence says what completion requires. */
const COMPLETION_CLAIM = /\b(order|deposit|escrow|trade|purchase|sale)\b[^.]{0,20}\b(is |was |now )?(complete|completed|filled|settled|executed)\b|\bfilled\b|\bsettled\b|(added to|now in|increase[sd]?)[^.]{0,20}holdings|holdings[^.]{0,20}(increase|grew|updated)/i
const ALLOWED_COMPLETION_TEXT = /reports this order completed|Payout if completed/g
function assertNoCompletionClaim(value: string, label: string) {
  assert.doesNotMatch(value.replace(ALLOWED_COMPLETION_TEXT, ""), COMPLETION_CLAIM, label)
}

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
  // Another SELL order's EXPIRED status does not disable this one.
  const otherExpired = sellSetup.model(sellSetup.snap("READY_TRANSFER"), { serverOrder: { orderId: "fixture-order-other-sell", side: "SELL", state: "EXPIRED", observedAt: new Date(sellSetup.now).toISOString() } })
  assert.equal(otherExpired.buttons[0]?.enabled, true)
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
  const everyState = [
    IDLE_SNAPSHOT,
    s.snap("CHECKING"),
    s.snap("APPROVAL_REQUIRED"),
    s.snap("SIGNING", "APPROVAL"),
    s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH),
    s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_NOT_ALLOWED"),
    s.snap("READY_TRANSFER"),
    s.snap("SIGNING", "TRANSFER"),
    s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH),
    s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH, "RECOVERY_REQUIRED"),
    s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN"),
    s.snap("BLOCKED", "TRANSFER", TRANSFER_HASH, "RECOVERY_REQUIRED"),
  ]
  for (const snapshot of everyState) {
    for (const serverState of [null, "AWAITING_FUNDING", "BROKER_PENDING", "MINT_UNKNOWN"]) {
      const model = s.model(snapshot, { serverOrder: serverState ? { orderId: s.plan.order.id, side: "BUY", state: serverState, observedAt: null } : null })
      assert.equal(model.server?.completed ?? false, false)
      assertNoCompletionClaim(`${text(model)} ${model.announcement}`, `${snapshot.status}/${snapshot.error}/${serverState}`)
    }
  }
  assertNoCompletionClaim("Holdings and balances change only after the server reports this order completed.", "allowed sentence")
  assert.throws(() => assertNoCompletionClaim("Your order is complete: the NVDA units are now in your holdings.", "claim"))
  assert.throws(() => assertNoCompletionClaim("Deposit completed.", "claim"))
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
  // Same side, different order: still not this order's result.
  const sameSideOther = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { serverOrder: { orderId: "fixture-order-other-buy", side: "BUY", state: "COMPLETED", observedAt: null } })
  assert.equal(sameSideOther.server, null)
  assert.notEqual(sameSideOther.steps[2]?.status, "done")
  assert.doesNotMatch(sameSideOther.title, /Completed/)
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
    assert.equal(model.side, null, "not even Buy/Sell of a hidden order")
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
  for (const [status, title] of [
    ["APPROVAL_REQUIRED", "Quote deadline passed — do not approve"],
    ["READY_TRANSFER", "Quote deadline passed — do not deposit"],
  ] as const) {
    const open = s.model(s.snap(status))
    const model = s.model(s.snap(status), { now: later })
    assert.equal(model.buttons[0]?.enabled, false, status)
    assert.equal(model.title, title, "the actionable title is replaced")
    assert.match(model.paragraphs[0]!, /quote deadline has passed/)
    assert.doesNotMatch(model.paragraphs.join(" "), /Nothing is sent until you press the button/)
    assert.notEqual(model.announcement, open.announcement, "expiry changes the announcement")
    assert.equal(model.code, "ORDER_EXPIRED")
  }
  const unknownLate = s.model(s.snap("UNKNOWN", "APPROVAL", null, "WALLET_OUTCOME_UNKNOWN"), { now: later })
  assert.equal(unknownLate.buttons[0]?.enabled, false)
  assert.match(unknownLate.paragraphs.join(" "), /can no longer check the recorded request/)
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
  const sources = ["../stocks-wallet/controller.ts", "../stocks-wallet/planner.ts", "../stocks-wallet-source/ports.ts", "../stocks-wallet-source/capture.ts", "../stocks-wallet-source/types.ts", "../stocks-execution-host/registry.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")
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

test("an approval the controller republishes with a later failure shows that reason, not 'confirming'", () => {
  const s = setup()
  const paused = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_NOT_ALLOWED"))
  assert.equal(paused.title, "Approval sent — check needed")
  assert.equal(paused.steps[0]?.detail, "Approval sent")
  assert.match(paused.paragraphs.join(" "), /Execution is not allowed for this order right now/)
  assert.doesNotMatch(paused.paragraphs.join(" "), /did not finish/)
  assert.equal(paused.tone, "warning")
  assert.equal(paused.buttons[0]?.enabled, true, "a read-only check stays available as the way out")
  const history = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "SUBMISSION_HISTORY_MISMATCH"))
  assert.equal(history.tone, "error")
  assert.match(history.paragraphs.join(" "), /needs a server check/)
  assert.match(history.paragraphs.join(" "), /contact operations/)
  const moved = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "ORDER_CHANGED"))
  assert.match(moved.paragraphs.join(" "), /moved on at the server/)
  const network = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "WALLET_NETWORK_INSTANCE_MISMATCH"))
  assert.match(network.paragraphs.join(" "), /Switch the wallet to GIWA Sepolia/)
  for (const pending of [null, "RECEIPT_PENDING"]) {
    const model = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, pending))
    assert.equal(model.title, "Approval submitted — confirming")
    assert.equal(model.steps[0]?.detail, "Confirming")
  }
  // RECOVERY_REQUIRED is also published for an approval the server already confirmed: neutral, never "unconfirmed".
  for (const side of ["BUY", "SELL"] as const) {
    const t = setup(side === "BUY" ? "fixture-order-a-buy-1" : "fixture-order-a-sell-1")
    const recovery = t.model(t.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECOVERY_REQUIRED"))
    assert.equal(recovery.title, "Approval sent — check needed")
    assert.equal(recovery.steps[0]?.detail, "Approval sent")
    assert.equal(recovery.tone, "info")
    assert.doesNotMatch([recovery.title, ...recovery.paragraphs, recovery.announcement].join(" "), /has not confirmed|confirming|was confirmed|is confirmed/i)
    assert.match(recovery.paragraphs.join(" "), new RegExp(`needs another check before the ${side === "BUY" ? "deposit" : "escrow"} can be offered\\. Check the approval status; the approval is not sent again\\.`))
    assert.deepEqual(recovery.buttons.map((button) => [button.action, button.enabled, button.opensWallet]), [["prepare", true, false]])
    assert.equal(recovery.txHash, APPROVAL_HASH)
  }
  const submitted = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH, "WALLET_NETWORK_INSTANCE_MISMATCH"))
  assert.match(submitted.paragraphs.join(" "), /different network/)
  assert.equal(submitted.txHash, TRANSFER_HASH)
})

test("a server status showing the order moved on disables approval and deposit/escrow (read-only checks remain)", () => {
  const s = setup()
  for (const state of ["BROKER_PENDING", "COMPLETED", "FUNDING_REVIEW_REQUIRED", "SOMETHING_UNRECOGNIZED"]) {
    const serverOrder = { orderId: s.plan.order.id, side: "BUY" as const, state, observedAt: new Date(s.now).toISOString() }
    const ready = s.model(s.snap("READY_TRANSFER"), { serverOrder })
    assert.equal(ready.buttons[0]?.enabled, false, state)
    assert.equal(ready.title, "Order moved on — do not deposit")
    assert.equal(ready.code, "ORDER_NOT_PAYABLE")
    const approval = s.model(s.snap("APPROVAL_REQUIRED"), { serverOrder })
    assert.equal(approval.buttons[0]?.enabled, false, state)
    assert.equal(approval.title, "Order moved on — do not approve")
    assert.equal(s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { serverOrder }).buttons[0]?.enabled, true, "checks stay available")
  }
  const awaiting = s.model(s.snap("READY_TRANSFER"), { serverOrder: { orderId: s.plan.order.id, side: "BUY", state: "AWAITING_FUNDING", observedAt: null } })
  assert.equal(awaiting.buttons[0]?.enabled, true)
  assert.equal(awaiting.steps[1]?.detail, "Ready — needs your click")
  const moved = s.model(s.snap("READY_TRANSFER"), { serverOrder: { orderId: s.plan.order.id, side: "BUY", state: "BROKER_PENDING", observedAt: null } })
  assert.deepEqual([moved.steps[1]?.status, moved.steps[1]?.detail], ["problem", "Not needed — order moved on"])
  const sell = setup("fixture-order-a-sell-1")
  const sellAwaiting = sell.model(sell.snap("READY_TRANSFER"), { serverOrder: { orderId: sell.plan.order.id, side: "SELL", state: "AWAITING_ESCROW", observedAt: null } })
  assert.equal(sellAwaiting.buttons[0]?.enabled, true, "SELL AWAITING_ESCROW still escrows")
  assert.equal(serverOrderAwaitsTransfer({ orderId: sell.plan.order.id, side: "SELL", state: "AWAITING_ESCROW", observedAt: null }, sell.plan.order.id, "SELL"), true)
  assert.equal(serverOrderAwaitsTransfer({ orderId: sell.plan.order.id, side: "SELL", state: "AWAITING_FUNDING", observedAt: null }, sell.plan.order.id, "SELL"), false)
  const other = s.model(s.snap("READY_TRANSFER"), { serverOrder: { orderId: "fixture-order-other-buy", side: "BUY", state: "BROKER_PENDING", observedAt: null } })
  assert.equal(other.buttons[0]?.enabled, true, "another order's status is ignored")
  assert.equal(serverOrderAwaitsTransfer(null, s.plan.order.id, "BUY"), true)
  assert.equal(serverOrderAwaitsTransfer({ orderId: s.plan.order.id, side: "BUY", state: "MINT_QUEUED", observedAt: null }, s.plan.order.id, "BUY"), false)
})

test("BLOCKED offers a read-only check for transient, network and recovery codes only", () => {
  const s = setup()
  const blocked = (error: string) => s.model(Object.freeze({ ...IDLE_SNAPSHOT, status: "BLOCKED" as const, error }))
  for (const code of ["READ_TIMEOUT", "EXECUTION_NOT_ALLOWED", "WALLET_NETWORK_INSTANCE_MISMATCH", "SUBMISSION_ALREADY_CLAIMED", "RECOVERY_REQUIRED"]) {
    assert.deepEqual(blocked(code).buttons.map((button) => [button.action, button.enabled, button.opensWallet]), [["prepare", true, false]], code)
  }
  for (const code of ["ORDER_EXPIRED", "SESSION_REQUIRED", "WALLET_MISMATCH", "DEPLOYMENT_NOT_REVIEWED", "ORDER_NOT_PAYABLE"]) {
    assert.equal(blocked(code).buttons.length, 0, code)
  }
  assert.equal(s.model(s.snap("BLOCKED", "TRANSFER", TRANSFER_HASH, "RECOVERY_REQUIRED")).buttons.length, 0, "reverted attempts get no button")
})

test("disabled wallet steps and checks explain why", () => {
  const s = setup()
  const noReconcile = { status: "UNAVAILABLE" as const, code: "TRUSTED_RECONCILIATION_REQUIRED" }
  const ready = s.model(s.snap("READY_TRANSFER"), { availability: noReconcile })
  assert.equal(ready.title, "Deposit unavailable")
  assert.equal(ready.code, "TRUSTED_RECONCILIATION_REQUIRED")
  assert.match(ready.paragraphs[0]!, /Trusted server verification/)
  assert.equal(ready.buttons[0]?.enabled, false)
  const approval = s.model(s.snap("APPROVAL_REQUIRED"), { availability: { status: "UNAVAILABLE", code: "CURRENT_POLICY_REQUIRED" } })
  assert.equal(approval.title, "Approval unavailable")
  const unknown = s.model(s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN"), { availability: { status: "UNAVAILABLE", code: "SESSION_REQUIRED" } })
  assert.equal(unknown.buttons[0]?.enabled, false)
  assert.match(unknown.paragraphs.join(" "), /Checking is unavailable right now\. The Stocks sign-in session is missing/)
  const submitted = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { availability: { status: "UNAVAILABLE", code: "DEPLOYMENT_EVIDENCE_EXPIRED" } })
  assert.equal(submitted.code, "DEPLOYMENT_EVIDENCE_EXPIRED")
  assert.match(submitted.paragraphs.join(" "), /Checking is unavailable right now/)
  const missing = { status: "UNAVAILABLE" as const, code: "SESSION_REQUIRED" }
  for (const snapshot of [s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECEIPT_PENDING"), Object.freeze({ ...IDLE_SNAPSHOT, status: "BLOCKED" as const, error: "READ_TIMEOUT" })]) {
    const model = s.model(snapshot, { availability: missing })
    assert.equal(model.buttons[0]?.enabled, false, `${snapshot.status}: disabled while availability is missing`)
    assert.match(model.paragraphs.join(" "), /Checking is unavailable right now/)
  }
  assert.equal(ready.steps[1]?.detail, "Unavailable")
  assert.doesNotMatch(s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECEIPT_PENDING"), { availability: missing }).paragraphs.join(" "), /Check again in a moment/)
})

test("the announcement changes whenever the outcome text or the server result changes", () => {
  const s = setup()
  const a = (snapshot: WalletSnapshot, extra: Partial<PanelInput> = {}) => s.model(snapshot, extra).announcement
  assert.notEqual(a(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECEIPT_PENDING")), a(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_NOT_ALLOWED")))
  assert.notEqual(a(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH)), a(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH, "RECOVERY_REQUIRED")))
  assert.notEqual(a(s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN")), a(s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN"), { availability: { status: "UNAVAILABLE", code: "SESSION_REQUIRED" } }))
  const submitted = s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH)
  const server = (state: string) => ({ orderId: s.plan.order.id, side: "BUY" as const, state, observedAt: null })
  const waiting = s.model(submitted)
  const processing = s.model(submitted, { serverOrder: server("BROKER_PENDING") })
  const completed = s.model(submitted, { serverOrder: server("COMPLETED") })
  assert.equal(waiting.title, "Deposit submitted — waiting for the order result")
  assert.equal(completed.title, "Deposit submitted — server status: Completed")
  assert.match(completed.announcement, /Order result from the server: Completed\.$/)
  assert.equal(new Set([waiting.announcement, processing.announcement, completed.announcement]).size, 3)
})

test("after a transaction was sent, a failed check never says nothing was sent", () => {
  const s = setup()
  for (const code of ["REQUEST_FAILED", "READ_TIMEOUT", "STALE_RESPONSE", "ALLOWANCE_CHANGED", "CONTEXT_CHANGED"]) {
    for (const snapshot of [s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH, code), s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, code)]) {
      const model = s.model(snapshot)
      const shown = `${model.paragraphs.join(" ")} ${model.announcement}`
      assert.doesNotMatch(shown, /nothing was sent|was not sent|no (deposit|escrow|approval) was sent/i, `${snapshot.status}/${code}`)
      assert.match(shown, /hash is kept/, `${snapshot.status}/${code}`)
      assert.equal(model.txHash, snapshot.txHash)
    }
  }
  for (const code of ["REQUEST_FAILED", "READ_TIMEOUT", "ALLOWANCE_CHANGED"]) assert.doesNotMatch(describeCode(code, "BUY").next, /nothing was sent/i)
})

test("after the deadline, submitted and pending screens say they can no longer be checked", () => {
  const s = setup()
  const later = Date.parse(s.plan.order.quoteExpiresAt) + 1_000
  const expiredAvailability = executionAvailability({ configured: true, ports: s.f.ports, context: s.context, selection: s.selection, now: later })
  const submitted = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), { now: later, availability: expiredAvailability })
  assert.equal(submitted.buttons[0]?.enabled, false)
  assert.equal(submitted.code, "ORDER_EXPIRED")
  assert.match(submitted.paragraphs.join(" "), /can no longer check it/)
  const pending = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECEIPT_PENDING"), { now: later, availability: expiredAvailability })
  assert.equal(pending.buttons[0]?.enabled, false)
  assert.doesNotMatch(pending.paragraphs.join(" "), /Check again in a moment/)
  assert.match(pending.paragraphs.join(" "), /can no longer check the approval/)
  const blocked = s.model(Object.freeze({ ...IDLE_SNAPSHOT, status: "BLOCKED" as const, error: "READ_TIMEOUT" }), { now: later, availability: expiredAvailability })
  assert.equal(blocked.buttons[0]?.enabled, false)
  assert.match(blocked.paragraphs.join(" "), /no longer possible after the quote deadline/)
  const ready = s.model(s.snap("READY_TRANSFER"), { now: later, availability: expiredAvailability })
  assert.deepEqual([ready.steps[1]?.status, ready.steps[1]?.detail], ["problem", "Deadline passed"])
  const approval = s.model(s.snap("APPROVAL_REQUIRED"), { now: later, availability: expiredAvailability })
  assert.deepEqual([approval.steps[0]?.status, approval.steps[0]?.detail], ["problem", "Deadline passed"])
})

test("a recorded transfer without a hash follows the matching server result: final states replace the pending check wording (003A A2)", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const s = setup(side === "BUY" ? "fixture-order-a-buy-1" : "fixture-order-a-sell-1")
    const server = (state: string, orderId = s.plan.order.id) => ({ orderId, side, state, observedAt: new Date(s.now).toISOString() })
    const unknown = s.snap("UNKNOWN", "TRANSFER", null, "RECOVERY_REQUIRED")
    const later = Date.parse(s.plan.order.quoteExpiresAt) + 1_000
    const expired = { now: later, availability: executionAvailability({ configured: true, ports: s.f.ports, context: s.context, selection: s.selection, now: later }) }
    for (const state of side === "BUY" ? ["COMPLETED", "REFUNDED"] : ["COMPLETED", "RETURNED"]) {
      for (const extra of [{}, expired]) {
        const model = s.model(unknown, { serverOrder: server(state), ...extra })
        const shown = model.paragraphs.join(" ")
        assert.match(shown, /server reports a final result for this order/, `${side}/${state}`)
        assert.doesNotMatch(shown, /needs a server check before anything else|stays unresolved/, `${side}/${state}`)
        assert.match(shown, /does not send it again/, "the no-resend statement stays")
        assert.deepEqual(model.buttons.map((button) => button.opensWallet), [false])
      }
    }
    for (const serverOrder of [null, server(side === "BUY" ? "MINT_UNKNOWN" : "SETTLEMENT_UNKNOWN"), server("COMPLETED", "fixture-order-other")]) {
      const model = s.model(unknown, { serverOrder })
      assert.match(model.paragraphs.join(" "), /needs a server check before anything else can happen/, `${side}: non-final or non-matching status keeps the check wording`)
      assert.doesNotMatch(model.paragraphs.join(" "), /final result/)
    }
    // SUBMITTED + RECOVERY_REQUIRED: one sentence per server knowledge level, never derived from the hash.
    const submitted = s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH, "RECOVERY_REQUIRED")
    assert.match(s.model(submitted).paragraphs.join(" "), /No final order result from the server is shown for this order yet\./)
    assert.match(s.model(submitted, { serverOrder: server("COMPLETED", "fixture-order-other") }).paragraphs.join(" "), /No final order result/, "another order's result is ignored")
    assert.match(s.model(submitted, { serverOrder: server(side === "BUY" ? "BROKER_PENDING" : "LIQUIDITY_PENDING") }).paragraphs.join(" "), /latest order status is not a final result yet/)
    const review = s.model(submitted, { serverOrder: server("REVIEW_REQUIRED"), ...expired })
    assert.match(review.paragraphs.join(" "), /holds it for review/, "a non-final review state keeps the late-inclusion note")
    if (side === "SELL") assert.match(s.model(submitted, { serverOrder: server("EXPIRED") }).paragraphs.join(" "), /not a final result yet/, "SELL EXPIRED is not a terminal order result")
  }
})

test("003A review: the neutral approval check wording holds on every branch and never promises what cannot happen", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const s = setup(side === "BUY" ? "fixture-order-a-buy-1" : "fixture-order-a-sell-1")
    const word = side === "BUY" ? "deposit" : "escrow"
    const recovery = s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "RECOVERY_REQUIRED")
    const later = Date.parse(s.plan.order.quoteExpiresAt) + 1_000
    const variants: [string, Partial<PanelInput>, RegExp][] = [
      // Not ready (for example the deployment evidence lease ended): the button is disabled, the wording stays neutral.
      ["unavailable", { availability: { status: "UNAVAILABLE", code: "DEPLOYMENT_NOT_REVIEWED" } }, new RegExp(`needs another check before the ${word} can be offered; the approval is not sent again\\.`)],
      ["expired", { now: later, availability: executionAvailability({ configured: true, ports: s.f.ports, context: s.context, selection: s.selection, now: later }) }, /The approval's status needs another check; the approval is not sent again\./],
      ["moved on", { serverOrder: { orderId: s.plan.order.id, side, state: "COMPLETED", observedAt: new Date(s.now).toISOString() } }, /The approval's status needs another check; the approval is not sent again\./],
    ]
    for (const [label, extra, expected] of variants) {
      const model = s.model(recovery, extra)
      const shown = [model.title, ...model.paragraphs, model.announcement].join(" ")
      assert.equal(model.title, "Approval sent — check needed", `${side}/${label}`)
      assert.doesNotMatch(shown, /has not confirmed|confirming/i, `${side}/${label}`)
      assert.match(model.paragraphs.join(" "), expected, `${side}/${label}`)
      assert.equal(model.txHash, APPROVAL_HASH)
      if (label !== "unavailable") assert.doesNotMatch(model.paragraphs.join(" "), new RegExp(`before the ${word} can be offered`), `${side}/${label}: no ${word} will be offered`)
      if (label !== "moved on") assert.equal(model.buttons[0]?.enabled, false, `${side}/${label}`)
    }
  }
})

test("003A review: settled UNKNOWN title, unrecognized server state, CONTEXT_EXPIRED promise and SELL articles", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const s = setup(side === "BUY" ? "fixture-order-a-buy-1" : "fixture-order-a-sell-1")
    const server = (state: string) => ({ orderId: s.plan.order.id, side, state, observedAt: new Date(s.now).toISOString() })
    const unknown = s.snap("UNKNOWN", "TRANSFER", null, "RECOVERY_REQUIRED")
    assert.equal(s.model(unknown, { serverOrder: server("COMPLETED") }).title, "Wallet result unknown — the server reports a final order result")
    assert.equal(s.model(unknown, { serverOrder: server(side === "BUY" ? "BROKER_PENDING" : "ESCROW_HELD") }).title, "Wallet result unknown — check required")
    assert.equal(s.model(unknown).title, "Wallet result unknown — check required")

    const unrecognized = s.model(s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH, "RECOVERY_REQUIRED"), { serverOrder: server("SETTLED_V2") })
    assert.equal(unrecognized.server?.category, "UNRECOGNIZED")
    assert.match(unrecognized.paragraphs.join(" "), /does not recognize/)
    assert.doesNotMatch(unrecognized.paragraphs.join(" "), /final result/)

    const expiredContext = describeCode("CONTEXT_EXPIRED", side)
    assert.doesNotMatch(expiredContext.next, /is shown again after the check\./)
    assert.match(expiredContext.next, new RegExp(`while the order still waits for the ${side === "BUY" ? "deposit" : "escrow"}, otherwise see the order result`))

    if (side === "SELL") {
      const shown = [
        describeCode("ORDER_NOT_PAYABLE", "SELL").reason,
        ...s.model(s.snap("SIGNING", "TRANSFER")).paragraphs,
        ...s.model(s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN")).paragraphs,
      ].join(" ")
      assert.doesNotMatch(shown, /\b[Aa] escrow\b/)
      assert.match(shown, /no longer waits for an escrow/)
      assert.match(shown, /An escrow request for exactly/)
      assert.match(shown, /An escrow request may have reached your wallet/)
    } else assert.match(describeCode("ORDER_NOT_PAYABLE", "BUY").reason, /no longer waits for a deposit\./)
  }
})

test("003A-1: authority and policy stop codes keep the recorded attempt honest on every screen", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const s = setup(side === "BUY" ? "fixture-order-a-buy-1" : "fixture-order-a-sell-1")
    const reserved = s.model(s.snap("UNKNOWN", "APPROVAL", null, "EXECUTION_AUTHORITY_CHANGED"))
    assert.equal(reserved.title, "Wallet result unknown — check required")
    assert.match(reserved.paragraphs.join(" "), /review expired or was renewed during this step, so no further step ran automatically/)
    assert.match(reserved.paragraphs.join(" "), /Do not repeat it from another app or wallet/)
    assert.equal(reserved.txHash, null)
    const approval = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_AUTHORITY_CHANGED"))
    assert.equal(approval.title, "Approval sent — check needed")
    assert.match(approval.paragraphs.join(" "), /approval hash is kept and the approval is not sent again/)
    const policy = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_POLICY_EXPIRED"))
    assert.equal(policy.title, "Approval sent — check needed")
    assert.doesNotMatch(policy.paragraphs.join(" "), /confirming|nothing was sent/i)
    for (const model of [reserved, approval, policy]) {
      assert.ok(model.buttons.every((button) => !button.opensWallet))
      assertNoCompletionClaim(`${text(model)} ${model.announcement}`, model.code ?? "")
    }
  }
})

test("003B: a host that loads review evidence keeps the read-only check available while only the evidence is missing", () => {
  const s = setup()
  const missing = { status: "UNAVAILABLE" as const, code: "DEPLOYMENT_NOT_REVIEWED" }
  for (const code of ["DEPLOYMENT_NOT_REVIEWED", "DEPLOYMENT_EVIDENCE_EXPIRED"]) {
    const without = s.model(IDLE_SNAPSHOT, { availability: { status: "UNAVAILABLE", code } })
    assert.equal(without.kind, "UNAVAILABLE", `${code}: no host evidence read → unavailable as before`)
    assert.equal(without.buttons[0]?.enabled, false)
    const loads = s.model(IDLE_SNAPSHOT, { availability: { status: "UNAVAILABLE", code }, evidenceRefreshable: true })
    assert.deepEqual([loads.kind, loads.title, loads.code], ["IDLE", "Not checked yet", null], code)
    assert.deepEqual(loads.buttons.map((button) => [button.action, button.enabled, button.opensWallet]), [["prepare", true, false]])
    assert.match(loads.paragraphs.join(" "), /first loads the current deployment review from the server/)
    assert.match(loads.paragraphs.join(" "), /does not open your wallet or send anything/)
  }
  // Other configuration problems are never treated as "just load evidence".
  const digest = s.model(IDLE_SNAPSHOT, { availability: { status: "UNAVAILABLE", code: "MANIFEST_DIGEST_MISMATCH" }, evidenceRefreshable: true })
  assert.deepEqual([digest.kind, digest.buttons[0]?.enabled], ["UNAVAILABLE", false])

  const failed = s.model(IDLE_SNAPSHOT, { availability: missing, evidenceRefreshable: true, evidenceFailure: "DEPLOYMENT_NOT_REVIEWED" })
  assert.deepEqual([failed.title, failed.code, failed.tone, failed.buttons[0]?.enabled], ["Review evidence not loaded", "DEPLOYMENT_NOT_REVIEWED", "warning", true])
  assert.equal(s.model(IDLE_SNAPSHOT, { availability: s.availability, evidenceFailure: "DEPLOYMENT_NOT_REVIEWED" }).title, "Not checked yet", "a failure is shown only while evidence is still missing")

  // Recorded screens keep their read-only check; wallet-opening steps need current evidence.
  const approval = s.model(s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_AUTHORITY_CHANGED"), { availability: missing, evidenceRefreshable: true })
  assert.deepEqual(approval.buttons.map((button) => [button.action, button.enabled]), [["prepare", true]])
  assert.doesNotMatch(approval.paragraphs.join(" "), /Checking is unavailable/)
  const unknown = s.model(s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN"), { availability: missing, evidenceRefreshable: true })
  assert.equal(unknown.buttons[0]?.enabled, true)
  for (const [status, action] of [["APPROVAL_REQUIRED", "approve"], ["READY_TRANSFER", "submit"]] as const) {
    const signing = s.model(s.snap(status), { availability: missing, evidenceRefreshable: true })
    assert.deepEqual(signing.buttons.map((button) => [button.action, button.enabled]), [[action, false]], `${status}: never enabled without current evidence`)
    assert.match(signing.title, /needs a new check$/)
    assert.doesNotMatch(signing.paragraphs.join(" "), /nothing was sent/i)
  }
})

test("003B: host capability codes have specific reasons and pass through the signed-out screen", () => {
  const s = setup()
  const generic = describeCode("SOMETHING_NEW", "BUY")
  for (const code of ["WALLET_SOURCE_UNSUPPORTED", "WALLET_SOURCE_MISSING", "WALLET_NOT_CONNECTED", "WALLET_NOT_ATTESTED", "ALLOWANCE_SCOPE_MISMATCH", "RECEIPT_PORT_INACTIVE", "API_BASE_NOT_CONFIGURED", "EXECUTION_CLOCK_UNAVAILABLE"]) {
    assert.notDeepEqual(describeCode(code, "BUY"), generic, code)
  }
  const unsupported = derivePanelModel({ snapshot: IDLE_SNAPSHOT, selection: s.selection, account: null, availability: { status: "UNAVAILABLE", code: "WALLET_SOURCE_UNSUPPORTED" }, now: s.now })
  assert.deepEqual([unsupported.kind, unsupported.code, unsupported.order, unsupported.side], ["UNAVAILABLE", "WALLET_SOURCE_UNSUPPORTED", null, null], "reason shown, order details hidden")
  assert.match(unsupported.paragraphs.join(" "), /cannot send exactly one transaction request/)
  assert.equal(unsupported.buttons.some((button) => button.enabled), false)
})

test("review 003B PANEL-2: a failed evidence read is explained on every screen that offers the read-only check", () => {
  const s = setup()
  const missing = { status: "UNAVAILABLE" as const, code: "DEPLOYMENT_NOT_REVIEWED" }
  const screens = [
    s.snap("APPROVAL_SUBMITTED", "APPROVAL", APPROVAL_HASH, "EXECUTION_AUTHORITY_CHANGED"),
    s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH),
    s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN"),
  ]
  for (const snapshot of screens) {
    const failed = s.model(snapshot, { availability: missing, evidenceRefreshable: true, evidenceFailure: "REQUEST_FAILED" })
    assert.match(failed.paragraphs.join(" "), /The deployment review could not be loaded for the last check\./, snapshot.status)
    assert.match(failed.paragraphs.join(" "), /nothing is sent again/, snapshot.status)
    assert.doesNotMatch(failed.paragraphs.join(" "), /nothing was sent/i, snapshot.status)
    const quiet = s.model(snapshot, { availability: missing, evidenceRefreshable: true })
    assert.doesNotMatch(quiet.paragraphs.join(" "), /could not be loaded/, `${snapshot.status}: no failure, no note`)
  }
})
