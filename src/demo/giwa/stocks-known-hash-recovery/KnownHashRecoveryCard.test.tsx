// Card copy per state, rendered to static markup (no DOM). Pins what each state says and offers: never a claim that
// nothing was sent (the wallet did send the transaction behind a kept hash), always the never-again line while an
// action is offered, no order completion claim, and exactly one explicit action or none.
import assert from "node:assert/strict"
import test from "node:test"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { KnownHashRecoveryCard } from "./KnownHashRecoveryCard"
import type { RecoveryResult } from "./recover"
import type { KnownHashEntry, KnownHashState } from "./store"

const HASH = `0x${"9".repeat(64)}`
function entry(state: KnownHashState, overrides: Partial<KnownHashEntry> = {}): KnownHashEntry {
  return Object.freeze({ claimId: "claim-1", intentKey: "a".repeat(64), stage: "APPROVAL", transactionDigest: "b".repeat(64), side: "BUY", orderId: "order-42", deploymentDigest: "d".repeat(64), wallet: "0x000000000000000000000000000000000000a11c", chainId: 91342, apiBase: "https://api.example.test", origin: "https://app.example.test", txHash: HASH, capturedAt: 1, state, busy: false, ...overrides })
}
function render(value: KnownHashEntry, last: RecoveryResult | null = null) {
  const html = renderToStaticMarkup(createElement(KnownHashRecoveryCard, { entry: value, lastResult: last, onRecover: () => undefined }))
  const text = html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => ({ label: match[1], disabled: /disabled=""/.test(match[0]) }))
  return { html, text, buttons }
}
const neverAgain = (step: string) => `The ${step} transaction behind this hash was already sent. Do not send this ${step} again from this or any other app or wallet.`
const stepOf = (value: KnownHashEntry) => (value.stage === "APPROVAL" ? "approval" : value.side === "SELL" ? "escrow" : "deposit")

const cases: { name: string; value: KnownHashEntry; last?: RecoveryResult; action: string | null; neverAgain: boolean }[] = [
  { name: "kept", value: entry({ kind: "KEPT" }), action: "Record this hash", neverAgain: true },
  { name: "kept after a failure", value: entry({ kind: "KEPT" }), last: { kind: "FAILED", code: "SUBMISSION_TIMEOUT" }, action: "Check again", neverAgain: true },
  { name: "kept after the session ended", value: entry({ kind: "KEPT" }), last: { kind: "SESSION_REJECTED" }, action: null, neverAgain: true },
  { name: "recorded, receipt pending", value: entry({ kind: "RECORDED" }), action: "Check the receipt again", neverAgain: true },
  { name: "recorded, then a failure", value: entry({ kind: "RECORDED" }), last: { kind: "FAILED", code: "SUBMISSION_HTTP_ERROR" }, action: "Check the receipt again", neverAgain: true },
  { name: "verified approval", value: entry({ kind: "VERIFIED", status: "CONFIRMED" }), action: null, neverAgain: false },
  { name: "verified escrow", value: entry({ kind: "VERIFIED", status: "CONFIRMED" }, { stage: "TRANSFER", side: "SELL" }), action: null, neverAgain: false },
  { name: "reverted", value: entry({ kind: "VERIFIED", status: "REVERTED" }), action: null, neverAgain: false },
  { name: "conflict", value: entry({ kind: "BLOCKED", reason: "CONFLICT" }), action: null, neverAgain: false },
  { name: "no claim", value: entry({ kind: "BLOCKED", reason: "NO_CLAIM" }), action: null, neverAgain: false },
]

test("each state says the truth about the wallet, offers one explicit action or none, and never claims order completion", () => {
  for (const item of cases) {
    const { text, buttons } = render(item.value, item.last ?? null)
    assert.doesNotMatch(text, /nothing was sent|nothing is sent from your wallet/i, `${item.name}: the wallet DID send the transaction behind this hash`)
    assert.doesNotMatch(text, /order (is|was|has been) (complete|completed|filled|settled)|order completed/i, item.name)
    assert.ok(text.includes(HASH), `${item.name}: the owner's own hash`)
    assert.ok(!text.includes("order-42"), `${item.name}: the card names no order ID (the order card does)`)
    assert.equal(text.includes(neverAgain(stepOf(item.value))), item.neverAgain, `${item.name}: never-again line`)
    // An approval card never tells the user not to send the deposit or escrow the order may still need.
    if (item.value.stage === "APPROVAL") assert.doesNotMatch(text, /(deposit|escrow)[^.]*again|again[^.]*(deposit|escrow)/i, `${item.name}: approval card and the next step`)
    if (!item.neverAgain) assert.match(text, /Do not (send|repeat)|does not fund|not the order result/, `${item.name}: guidance`)
    assert.deepEqual(buttons.map((button) => button.label), item.action ? [item.action] : [], item.name)
    if (item.value.state.kind === "KEPT" || item.value.state.kind === "RECORDED") assert.ok(text.includes("kept only in this tab's memory"), `${item.name}: reload limit`)
  }
  assert.ok(render(entry({ kind: "VERIFIED", status: "CONFIRMED" })).text.includes("An approval does not fund or complete the order"))
  assert.ok(render(entry({ kind: "VERIFIED", status: "CONFIRMED" }, { stage: "TRANSFER", side: "SELL" })).text.includes("This is not the order result"))
  assert.ok(render(entry({ kind: "KEPT" }, { stage: "TRANSFER", side: "SELL" })).text.startsWith("Escrow hash kept in this tab"))
  assert.ok(render(entry({ kind: "KEPT" }, { stage: "TRANSFER", side: "BUY" })).text.startsWith("Deposit hash kept in this tab"))
  const failed = render(entry({ kind: "KEPT" }), { kind: "FAILED", code: "SUBMISSION_TIMEOUT" }).text
  assert.ok(failed.includes("so it may or may not have recorded the hash. This did not open your wallet."), failed)
  assert.doesNotMatch(failed, /send anything/, "the record request may have reached the server")
  assert.ok(render(entry({ kind: "KEPT" })).text.includes("Until this hash is recorded, the order's own check may show the result as unknown."))
  assert.ok(!render(entry({ kind: "RECORDED" })).text.includes("Until this hash is recorded"))
  for (const [stage, side, step] of [["TRANSFER", "BUY", "deposit"], ["TRANSFER", "SELL", "escrow"]] as const) {
    const text = render(entry({ kind: "KEPT" }, { stage, side })).text
    assert.ok(text.includes(neverAgain(step)), `${side} ${stage}`)
    assert.ok(render(entry({ kind: "BLOCKED", reason: "CONFLICT" }, { stage, side })).text.includes(`Do not send this ${step} again`))
  }
})

test("a running action shows a disabled, busy button", () => {
  const { buttons, html } = render(entry({ kind: "KEPT" }, { busy: true }))
  assert.deepEqual(buttons, [{ label: "Checking with the server…", disabled: true }])
  assert.match(html, /aria-busy="true"/)
})

// 003D-1 (Codex KH-UI-003D-P3-01): a failed receipt check after the hash was recorded must not say the server may or may
// not have the hash. KEPT + FAILED keeps that uncertainty (the record request may or may not have reached the server).
test("a failure keeps the right certainty: KEPT may or may not be recorded; RECORDED stays recorded and only the receipt is unknown", () => {
  const failures: RecoveryResult[] = [{ kind: "FAILED", code: "SUBMISSION_REQUEST_FAILED" }, { kind: "FAILED", code: "SUBMISSION_TIMEOUT" }, { kind: "FAILED", code: "SUBMISSION_HTTP_ERROR" }]
  const steps = [
    { stage: "APPROVAL", side: "BUY", step: "approval", title: "Approval hash kept in this tab" },
    { stage: "APPROVAL", side: "SELL", step: "approval", title: "Approval hash kept in this tab" },
    { stage: "TRANSFER", side: "BUY", step: "deposit", title: "Deposit hash kept in this tab" },
    { stage: "TRANSFER", side: "SELL", step: "escrow", title: "Escrow hash kept in this tab" },
  ] as const
  for (const { stage, side, step, title } of steps) {
    for (const failure of failures) {
      const label = `${side} ${stage} ${failure.kind === "FAILED" ? failure.code : ""}`
      const recorded = render(entry({ kind: "RECORDED" }, { stage, side }), failure)
      assert.ok(recorded.text.startsWith(title), `${label}: step wording`)
      assert.ok(recorded.text.includes(`The server has recorded this ${step} hash for the order's request.`), `${label}: recorded`)
      assert.ok(recorded.text.includes(`The receipt check could not be completed: the server's answer did not arrive or was an error. The ${step} hash stays recorded on the server, and this check did not open your wallet. Check the receipt again to see whether it is verified.`), `${label}: receipt-check failure`)
      assert.doesNotMatch(recorded.text, /may or may not|may not have (it|recorded)|could not be recorded|not recorded/i, `${label}: no contradiction with "recorded"`)
      assert.deepEqual(recorded.buttons.map((button) => button.label), ["Check the receipt again"], `${label}: explicit receipt check stays`)
      assert.ok(recorded.text.includes(neverAgain(step)), `${label}: never this step again`)
      assert.ok(recorded.text.includes("kept only in this tab's memory"), `${label}: tab memory limit`)
      assert.doesNotMatch(recorded.text, /order (is|was|has been) (complete|completed)/i)

      const kept = render(entry({ kind: "KEPT" }, { stage, side }), failure)
      assert.ok(kept.text.startsWith(title), `${label}: step wording`)
      assert.ok(kept.text.includes("The server's answer did not arrive or was an error, so it may or may not have recorded the hash. This did not open your wallet. Check again to see what the server has."), `${label}: record uncertainty kept`)
      assert.ok(!kept.text.includes("stays recorded") && !kept.text.includes("The server has recorded"), `${label}: KEPT never claims the hash is recorded`)
      assert.deepEqual(kept.buttons.map((button) => button.label), ["Check again"], label)
      assert.ok(kept.text.includes(neverAgain(step)) && kept.text.includes("kept only in this tab's memory"), label)
    }
  }
  // Without a failure, RECORDED says nothing about a failed check, and KEPT offers the first recording.
  assert.ok(!render(entry({ kind: "RECORDED" })).text.includes("could not be completed"))
  assert.deepEqual(render(entry({ kind: "KEPT" })).buttons.map((button) => button.label), ["Record this hash"])
})
