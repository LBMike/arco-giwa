import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { sha256, toHex, type Hex } from "viem"

import { planOrder } from "../stocks-wallet/planner"
import type { Stage, WalletSnapshot } from "../stocks-wallet/types"
import { executionAvailability } from "./availability"
import { createScriptedWallet, FIXTURE_WALLETS } from "./fixtures/scripted-wallet"
import { IDLE_SNAPSHOT } from "./model"
import { StocksWalletPanel, type StocksWalletPanelProps } from "./StocksWalletPanel"
import type { StocksWalletPanelActions } from "./types"

const TRANSFER_HASH: Hex = sha256(toHex("panel-transfer"))
const APPROVAL_HASH: Hex = sha256(toHex("panel-approval"))

function setup(orderId = "fixture-order-a-buy-1") {
  const f = createScriptedWallet()
  if (orderId.includes("-b-")) f.controls.setAccount("B")
  const selection = f.selection(orderId)
  const context = f.context()
  const now = f.now()
  const plan = planOrder(selection, context, now)
  const calls: string[] = []
  const actions: StocksWalletPanelActions = { prepare: () => void calls.push("prepare"), approve: () => void calls.push("approve"), submit: () => void calls.push("submit") }
  const snap = (status: WalletSnapshot["status"], stage: Stage | null = null, txHash: Hex | null = null, error: string | null = null): WalletSnapshot =>
    Object.freeze({ status, orderId: plan.order.id, intentKey: plan.intentKey, stage, txHash, error, plan })
  const props = (extra: Partial<StocksWalletPanelProps> = {}): StocksWalletPanelProps => ({
    snapshot: IDLE_SNAPSHOT,
    selection,
    account: context.walletAddress,
    availability: executionAvailability({ configured: true, ports: f.ports, context, selection, now }),
    now,
    network: { networkInstance: f.manifest.networkInstance, deploymentId: f.manifest.deploymentId },
    actions,
    ...extra,
  })
  const html = (extra: Partial<StocksWalletPanelProps> = {}) => renderToStaticMarkup(<StocksWalletPanel {...props(extra)} />)
  return { f, plan, snap, html, calls }
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")
}

function button(html: string, action: string): string | null {
  return new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html)?.[0] ?? null
}

test("summary: side, stock, exact approval and deposit amounts, network, deadline and test-asset labels", () => {
  const s = setup()
  const shown = text(s.html())
  assert.match(shown, /Buy NVDA: approve and deposit/)
  assert.match(shown, /Test assets only/)
  assert.match(shown, /no real-world value/)
  assert.match(shown, /Side Buy/)
  assert.match(shown, /Stock NVDA \(test units\)/)
  assert.match(shown, /Order quantity 2\.5 NVDA 2500000000 base units · 9 decimals/)
  assert.match(shown, /Approval amount 300 ARCO_TEST_USDC 300000000 base units · 6 decimals/)
  assert.match(shown, /Deposit amount 300 ARCO_TEST_USDC/)
  assert.match(shown, /Network GIWA Sepolia testnet · chain 91342 fixture-giwa-sepolia-1/)
  assert.match(shown, /Quote deadline 2026-09-17 00:10:00 UTC Open · 10 min 0 s left/)
  assert.match(shown, new RegExp(`Spender \\(funding vault\\) ${s.plan.spender}`))
  assert.match(shown, /Order result from the server Not reported/)
  const sell = setup("fixture-order-a-sell-1")
  const sold = text(sell.html({ snapshot: sell.snap("READY_TRANSFER") }))
  assert.match(sold, /Sell NVDA: approve and escrow/)
  assert.match(sold, /Escrow amount 0\.123456789 NVDA 123456789 base units · 9 decimals/)
  assert.match(sold, /Payout if completed \(test cash\) 14\.814814 ARCO_TEST_USDC/)
  assert.match(sold, /Escrow 0\.123456789 NVDA/)
  const small = setup("fixture-order-b-buy-1")
  const tiny = text(small.html({ snapshot: small.snap("APPROVAL_REQUIRED") }))
  assert.match(tiny, /Approval amount 0\.000001 ARCO_TEST_USDC 1 base unit · 6 decimals/)
  assert.match(tiny, /Approve 0\.000001 ARCO_TEST_USDC/)
  assert.doesNotMatch(tiny, /\b0 ARCO_TEST_USDC/)
})

test("wallet-opening buttons render disabled on first paint (armed only after the step is shown)", () => {
  const s = setup()
  const approval = s.html({ snapshot: s.snap("APPROVAL_REQUIRED") })
  assert.match(button(approval, "approve") ?? "", /disabled=""/)
  const ready = s.html({ snapshot: s.snap("READY_TRANSFER") })
  assert.match(button(ready, "submit") ?? "", /disabled=""/)
  assert.equal(button(ready, "approve"), null, "approval is not offered next to the deposit")
  // A read-only check is not wallet-opening and is available immediately.
  assert.doesNotMatch(button(s.html(), "prepare") ?? "missing", /disabled=""/)
  assert.deepEqual(s.calls, [], "rendering never calls an action")
})

test("SIGNING, UNKNOWN, REVERTED and SUBMITTED screens", () => {
  const s = setup()
  const signing = s.html({ snapshot: s.snap("SIGNING", "TRANSFER") })
  assert.match(text(signing), /Confirm in your wallet/)
  assert.match(text(signing), /A deposit request for exactly 300 ARCO_TEST_USDC to the funding vault is open in your wallet/)
  for (const tag of signing.match(/<button[^>]*>/g) ?? []) assert.match(tag, /disabled=""/)

  const submitted = s.html({ snapshot: s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH) })
  const submittedText = text(submitted)
  assert.match(submittedText, /Deposit submitted — waiting for the order result/)
  assert.match(submittedText, new RegExp(`Deposit transaction hash ${TRANSFER_HASH}`))
  assert.match(submittedText, /not the order result/)
  assert.doesNotMatch(submittedText, /\bCompleted\b/)
  assert.equal(button(submitted, "submit"), null)
  const completed = text(s.html({ snapshot: s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), serverOrder: { orderId: s.plan.order.id, side: "BUY", state: "COMPLETED", observedAt: "2026-09-17T00:05:00.000Z" } }))
  assert.match(completed, /Order result from the server Completed The test units are issued and finalized\. Status as of 2026-09-17 00:05:00 UTC/)
  const refreshing = s.html({ snapshot: s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH), onRefreshServerOrder: () => undefined, serverOrderRefreshing: true })
  const refreshTag = /<button[^>]*data-testid="stocks-wallet-refresh-order"[^>]*>/.exec(refreshing)?.[0] ?? ""
  assert.match(refreshTag, /aria-disabled="true"/)
  assert.doesNotMatch(refreshTag, /\sdisabled=""/, "stays focusable while the host refreshes")

  const unknown = s.html({ snapshot: s.snap("UNKNOWN", "TRANSFER", null, "WALLET_OUTCOME_UNKNOWN") })
  assert.match(text(unknown), /Wallet result unknown — check required/)
  assert.match(text(unknown), /does not send it again/)
  assert.match(text(unknown), /Code WALLET_OUTCOME_UNKNOWN/)
  assert.equal(button(unknown, "approve"), null)
  assert.equal(button(unknown, "submit"), null)

  const reverted = s.html({ snapshot: s.snap("BLOCKED", "APPROVAL", APPROVAL_HASH, "APPROVAL_REVERTED") })
  assert.match(text(reverted), /Approval reverted/)
  assert.match(text(reverted), new RegExp(`Approval transaction hash ${APPROVAL_HASH}`))
  assert.doesNotMatch(reverted, /data-action=/, "no retry")

  const blocked = text(s.html({ snapshot: Object.freeze({ ...IDLE_SNAPSHOT, status: "BLOCKED", error: "EXECUTION_NOT_ALLOWED" }) }))
  assert.match(blocked, /Execution blocked Execution is not allowed for this order right now/)
  assert.match(blocked, /Check again/)
})

test("unavailable configuration shows disabled execution; another wallet sees no order data", () => {
  const s = setup()
  const unconfigured = s.html({ availability: { status: "UNAVAILABLE", code: "NOT_CONFIGURED" }, actions: null, network: null })
  assert.match(text(unconfigured), /Wallet execution unavailable Wallet execution is not configured in this app/)
  assert.match(button(unconfigured, "prepare") ?? "", /disabled=""/)
  const other = s.html({ account: FIXTURE_WALLETS.B, snapshot: s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH) })
  assert.doesNotMatch(other, new RegExp(`${TRANSFER_HASH}|${s.plan.order.id}|300 ARCO_TEST_USDC|${s.plan.spender}`))
  assert.match(text(other), /The connected wallet is not the wallet that placed this order/)
  assert.match(other, /<h2 id="[^"]+"[^>]*>Stocks wallet steps<\/h2>/, "the heading does not reveal Buy/Sell either")
  const sellSetup = setup("fixture-order-a-sell-1")
  assert.doesNotMatch(sellSetup.html({ account: FIXTURE_WALLETS.B }), /Sell NVDA|escrow/i)
  const signedOut = s.html({ account: null, snapshot: s.snap("SUBMITTED", "TRANSFER", TRANSFER_HASH) })
  assert.doesNotMatch(signedOut, new RegExp(`${TRANSFER_HASH}|${s.plan.order.id}`))
})

test("accessible structure: labelled section, polite status region, step progress, native buttons, tokens only", () => {
  const s = setup()
  const html = s.html({ snapshot: s.snap("APPROVAL_REQUIRED") })
  const labelledBy = /<section[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1]
  assert.ok(labelledBy)
  assert.match(html, new RegExp(`<h2 id="${labelledBy!.replace(/[:]/g, "\\:")}"[^>]*>Buy NVDA: approve and deposit</h2>`))
  assert.match(html, /<p role="status" aria-live="polite" aria-atomic="true" class="sr-only"[^>]*>Approval required\. Approve exactly 300 ARCO_TEST_USDC/)
  assert.match(html, /<li aria-current="step"[^>]*data-step-status="current"/)
  assert.match(html, /<h3 tabindex="-1"/)
  for (const tag of html.match(/<button[^>]*>/g) ?? []) {
    assert.match(tag, /type="button"/)
    assert.match(tag, /min-h-11/, "touch target")
    assert.match(tag, /focus-visible:outline/)
  }
  assert.match(html, /<button[^>]*class="[^"]*w-full[^"]*sm:w-auto/, "full-width actions on phones")
  assert.match(html, /\[overflow-wrap:anywhere\]/, "addresses wrap instead of overflowing")
  assert.doesNotMatch(html, new RegExp(`(^|\\s|")(${"bg"}|${"text"}|${"border"})-(${"white"}|${"black"}|(slate|gray|red|green|amber)-\\d{2,3})(\\s|")`))
  const nested = renderToStaticMarkup(
    <StocksWalletPanel snapshot={IDLE_SNAPSHOT} selection={null} account={null} availability={{ status: "UNAVAILABLE", code: "ORDER_REQUIRED" }} now={0} actions={null} headingLevel={3} />,
  )
  assert.match(nested, /<h3 id="[^"]+"[^>]*>Stocks wallet steps<\/h3>/)
  assert.match(nested, /<h4 tabindex="-1"/)
})
