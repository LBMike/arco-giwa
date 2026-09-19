// Card copy per state, rendered to static markup (no DOM). Pins what each state says and offers: never a claim that
// nothing was sent (the wallet did send the transaction behind a kept hash), always the never-again line while an
// action is offered, no order completion claim, and exactly one explicit action or none. The status region across
// re-renders runs in jsdom only when GIWA_HOST_DOM_RUNTIME is set (skipped otherwise).
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

// While the next action runs, the store may already hold its new state (RECORDED settles before the receipt check); the
// previous action's failure must not be shown next to "Checking with the server…" as if it were this run's result.
test("a running action never shows the previous action's failure", () => {
  const failed: RecoveryResult = { kind: "FAILED", code: "SUBMISSION_REQUEST_FAILED" }
  for (const kind of ["KEPT", "RECORDED"] as const) {
    const running = render(entry({ kind }, { busy: true }), failed)
    assert.deepEqual(running.buttons, [{ label: "Checking with the server…", disabled: true }], kind)
    assert.doesNotMatch(running.text, /could not be completed|did not arrive or was an error|may or may not/, `${kind}: no stale failure while running`)
    assert.ok(running.text.includes(neverAgain("approval")), `${kind}: the never-again line stays`)
    const settled = render(entry({ kind }), failed)
    assert.match(settled.text, /did not arrive or was an error/, `${kind}: the failure shows once the action has ended`)
  }
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

// UI review G3 K4: a verified approval names only the step that follows it on this order (a buy deposits, a sell escrows).
test("a verified approval names the order's own next step: deposit for a buy, escrow for a sell", () => {
  const buy = render(entry({ kind: "VERIFIED", status: "CONFIRMED" }, { side: "BUY" })).text
  assert.ok(buy.includes("An approval does not fund or complete the order. The order status shows the result, and the separate deposit step still follows the order's own rules and deadline."), buy)
  assert.doesNotMatch(buy, /escrow/)
  const sell = render(entry({ kind: "VERIFIED", status: "CONFIRMED" }, { side: "SELL" })).text
  assert.ok(sell.includes("An approval does not fund or complete the order. The order status shows the result, and the separate escrow step still follows the order's own rules and deadline."), sell)
  assert.doesNotMatch(sell, /deposit/)
})

// UI review G3 K1: the card itself is not a live region (it used to become role=status only after the first result was
// painted, so that result was not announced, and then re-read the whole card on every busy toggle). One always-mounted
// polite status region holds only the last result's sentence(s): never the busy label, the hash or the standing lines.
const decode = (value: string) => value.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
function statusRegion(html: string) {
  const match = html.match(/<p([^>]*data-testid="stocks-known-hash-announcement"[^>]*)>([^<]*)<\/p>/)
  return match ? { attributes: match[1]!, text: decode(match[2]!) } : null
}
const KEPT_FIRST = (step: string) => `Your wallet returned this ${step} transaction hash, but it could not be recorded on the server at the time (for example because the Stocks session had ended), so the server may not have it.`
const KEPT_FAILED = "The server's answer did not arrive or was an error, so it may or may not have recorded the hash. This did not open your wallet. Check again to see what the server has."
const RECORDED_FIRST = (step: string) => `The server has recorded this ${step} hash for the order's request. Its receipt is not verified yet, so the transaction is not confirmed.`
const RECORDED_FAILED = (step: string) => `The receipt check could not be completed: the server's answer did not arrive or was an error. The ${step} hash stays recorded on the server, and this check did not open your wallet. Check the receipt again to see whether it is verified.`
const SESSION_ENDED = "Your Stocks session can no longer be used for this. Sign in again with the same wallet to continue."

test("one always-mounted polite status region: empty before the first action, then only the result sentence(s)", () => {
  const before = render(entry({ kind: "KEPT" }))
  const region = statusRegion(before.html)
  assert.ok(region, "the region exists before the first action")
  assert.equal(region.text, "")
  for (const attribute of ['role="status"', 'aria-live="polite"', 'aria-atomic="true"', 'class="sr-only"']) assert.ok(region.attributes.includes(attribute), attribute)
  const results: { name: string; value: KnownHashEntry; last: RecoveryResult; said: string }[] = [
    { name: "kept, failed", value: entry({ kind: "KEPT" }), last: { kind: "FAILED", code: "SUBMISSION_TIMEOUT" }, said: `${KEPT_FIRST("approval")} ${KEPT_FAILED}` },
    { name: "kept, session ended", value: entry({ kind: "KEPT" }, { stage: "TRANSFER", side: "BUY" }), last: { kind: "SESSION_REJECTED" }, said: `${KEPT_FIRST("deposit")} ${SESSION_ENDED}` },
    { name: "recorded, pending", value: entry({ kind: "RECORDED" }, { stage: "TRANSFER", side: "SELL" }), last: { kind: "RECORDED_PENDING" }, said: RECORDED_FIRST("escrow") },
    { name: "recorded, failed", value: entry({ kind: "RECORDED" }, { stage: "TRANSFER", side: "SELL" }), last: { kind: "FAILED", code: "SUBMISSION_HTTP_ERROR" }, said: `${RECORDED_FIRST("escrow")} ${RECORDED_FAILED("escrow")}` },
    { name: "verified", value: entry({ kind: "VERIFIED", status: "CONFIRMED" }), last: { kind: "CONFIRMED" }, said: "The server verified this approval's receipt for the order's request." },
    { name: "conflict", value: entry({ kind: "BLOCKED", reason: "CONFLICT" }), last: { kind: "CONFLICT" }, said: "The server already has a different transaction hash for this request, so this hash was not recorded." },
  ]
  for (const item of results) {
    const { html } = render(item.value, item.last)
    const said = statusRegion(html)
    assert.ok(said, item.name)
    assert.equal(said.text.trimEnd(), `Check finished. ${item.said}`, item.name)
    assert.ok(!said.text.includes(HASH) && !said.text.includes("Checking with the server") && !said.text.includes("already sent") && !said.text.includes("tab's memory"), item.name)
    // The card itself is not a live region: exactly one status role and one aria-live on the card.
    assert.equal(html.match(/role="status"/g)?.length, 1, item.name)
    assert.equal(html.match(/aria-live=/g)?.length, 1, item.name)
  }
  // A running action: the busy label stays on the (disabled) button only; the region says nothing about it.
  const busy = render(entry({ kind: "KEPT" }, { busy: true }), { kind: "FAILED", code: "SUBMISSION_TIMEOUT" })
  assert.deepEqual(busy.buttons, [{ label: "Checking with the server…", disabled: true }])
  assert.equal(statusRegion(busy.html)?.text, "")
})

// Gated like the DOM tests (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json): the region across real renders.
test("the status region announces a repeated identical result again and never reads the previous result as the new one", { skip: !process.env.GIWA_HOST_DOM_RUNTIME }, async () => {
  const { createRequire } = await import("node:module")
  const { JSDOM } = createRequire(process.env.GIWA_HOST_DOM_RUNTIME!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const { act, StrictMode } = await import("react")
    const { createRoot } = await import("react-dom/client")
    const element = dom.window.document.createElement("div")
    dom.window.document.body.append(element)
    const root = createRoot(element)
    const said: string[] = []
    const region = () => element.querySelector('[data-testid="stocks-known-hash-announcement"]')?.textContent ?? null
    const show = async (value: KnownHashEntry, last: RecoveryResult | null) => {
      await act(async () => root.render(createElement(StrictMode, null, createElement(KnownHashRecoveryCard, { entry: value, lastResult: last, onRecover: () => undefined }))))
      said.push(region() ?? "")
    }
    const failed = () => Object.freeze({ kind: "FAILED", code: "SUBMISSION_TIMEOUT" }) as RecoveryResult
    await show(entry({ kind: "KEPT" }), null)
    assert.equal(region(), "", "mounted and empty before the first action")
    const first = failed()
    await show(entry({ kind: "KEPT" }), first)
    const once = region()!
    assert.equal(once.trimEnd(), `Check finished. ${KEPT_FIRST("approval")} ${KEPT_FAILED}`)
    // Check again: busy, then the store's end() paints before the new result arrives. The previous result is not read again.
    await show(entry({ kind: "KEPT" }, { busy: true }), first)
    assert.equal(region(), "", "a new action clears the previous result")
    await show(entry({ kind: "KEPT" }), first)
    assert.equal(region(), "", "the previous result is not put back before the new one arrives")
    // The same failure again (a new frozen object): the text changes, so it is announced again.
    await show(entry({ kind: "KEPT" }), failed())
    const twice = region()!
    assert.notEqual(twice, once)
    assert.equal(twice.trimEnd(), once.trimEnd())
    // Even without a busy render in between, another identical result changes the text.
    await show(entry({ kind: "KEPT" }), failed())
    assert.notEqual(region(), twice)
    assert.equal(region()!.trimEnd(), once.trimEnd())
    assert.ok(said.every((text) => !text.includes("Checking with the server") && !text.includes(HASH)), JSON.stringify(said))
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
