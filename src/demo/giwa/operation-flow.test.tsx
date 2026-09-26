import assert from "node:assert/strict"
import test from "node:test"

import {
  displayAmount,
  initialOperationSteps,
  operationFlowView,
  operationResultMessage,
  runOperationFlow,
  type OperationFlow,
  type OperationOutcome,
  type OperationReview,
  type OperationStepId,
  type OperationStepState,
  type StepOutcome,
} from "./operation-flow"

const SAVINGS: OperationReview = {
  kind: "savings",
  operation: "deposit",
  productName: "USD Savings",
  pay: { amount: "1,000", symbol: "USDC", icon: "/logos/usdc.svg", sub: "~$1000.00" },
  receive: { amount: "998.2", symbol: "aUSD", icon: null, sub: "~$1000.00" },
  apyText: "4.52%",
}
const FUNDS: OperationReview = { ...SAVINGS, kind: "funds", productName: "Aksia CAPIX", receive: { ...SAVINGS.receive, amount: "9.87", symbol: "aCAPIX" }, apyText: null }

const flowOf = (review: OperationReview, patch: Partial<OperationFlow> = {}): OperationFlow => ({
  id: 1,
  review,
  steps: initialOperationSteps(true),
  outcome: null,
  open: true,
  ...patch,
})

test("amounts read as the panel's: grouped, at most 6 decimals (cut), no trailing zeros", () => {
  assert.equal(displayAmount("1000"), "1,000")
  assert.equal(displayAmount("1234567.5"), "1,234,567.5")
  assert.equal(displayAmount("1."), "1")
  assert.equal(displayAmount("0.1234567"), "0.123456")
  assert.equal(displayAmount("998.215612345678901234"), "998.215612")
  assert.equal(displayAmount("5.000000"), "5")
  assert.equal(displayAmount("007"), "7")
  assert.equal(displayAmount("--"), "--", "not a number: left as it is")
})

type Call = string
function driver(options: { approve?: StepOutcome | null; submit: StepOutcome; stopAfterApproval?: boolean; requested?: boolean }) {
  const calls: Call[] = []
  let outcome: OperationOutcome | null = null
  const run = runOperationFlow({
    approve:
      options.approve === undefined || options.approve === null
        ? null
        : async (onSent) => {
            calls.push("wallet:approve")
            onSent()
            return options.approve!
          },
    submit: async (onSent) => {
      calls.push("wallet:submit")
      onSent()
      return options.submit
    },
    stopped: () => options.stopAfterApproval === true,
    step: (id: OperationStepId, state: OperationStepState) => calls.push(`${id}:${state}`),
    finish: (next) => {
      outcome = next
      calls.push(`finish:${next.kind}`)
    },
    requested: options.requested ?? false,
  })
  return { run, calls, outcome: () => outcome }
}

test("one press runs the approval, then the operation, one wallet request at a time", async () => {
  const ok = driver({ approve: { ok: true, hash: "0xa" }, submit: { ok: true, hash: "0xb", received: "998.2" } })
  await ok.run
  assert.deepEqual(ok.calls, [
    "wallet:approve",
    "approve:processing",
    "approve:done",
    "submit:wallet",
    "wallet:submit",
    "submit:processing",
    "submit:done",
    "finish:success",
  ])
  assert.deepEqual(ok.outcome(), { kind: "success", hash: "0xb", received: "998.2" })

  const direct = driver({ submit: { ok: true, hash: "0xb" } })
  await direct.run
  assert.deepEqual(direct.calls, ["wallet:submit", "submit:processing", "submit:done", "finish:success"], "no approval step when the vault can already take it")
  assert.deepEqual(direct.outcome(), { kind: "success", hash: "0xb", received: null })

  const request = driver({ submit: { ok: true, hash: "0xc" }, requested: true })
  await request.run
  assert.deepEqual(request.outcome(), { kind: "requested", hash: "0xc" })
})

test("a failure stops at its step; closing the modal after the approval asks the wallet for nothing more", async () => {
  const declined = driver({ approve: { ok: false, message: "User rejected the request." }, submit: { ok: true, hash: "0xb" } })
  await declined.run
  assert.deepEqual(declined.calls, ["wallet:approve", "approve:processing", "approve:failed", "finish:failed"])
  assert.deepEqual(declined.outcome(), { kind: "failed", message: "User rejected the request." })

  const reverted = driver({ submit: { ok: false, message: "Transaction reverted before confirmation" } })
  await reverted.run
  assert.deepEqual(reverted.calls, ["wallet:submit", "submit:processing", "submit:failed", "finish:failed"])

  const closed = driver({ approve: { ok: true, hash: "0xa" }, submit: { ok: true, hash: "0xb" }, stopAfterApproval: true })
  await closed.run
  assert.deepEqual(closed.calls, ["wallet:approve", "approve:processing", "approve:done"], "the operation is never sent to the wallet")
  assert.equal(closed.outcome(), null)
})

test("Savings reads as a deposit, Funds as an investment, each with its own success screen", () => {
  const savings = operationFlowView(flowOf(SAVINGS))
  assert.equal(savings.title, "Review deposit")
  assert.equal(savings.payCaption, "You deposit")
  assert.deepEqual(savings.steps.map((step) => [step.label, step.walletLabel, step.processingLabel, step.state]), [
    ["Approve USDC", "Approve USDC in your wallet", "Approving USDC…", "wallet"],
    ["Confirm deposit", "Confirm deposit in your wallet", "Deposit pending…", "upcoming"],
  ])
  assert.equal(savings.steps[0]!.help?.answer, "Approving lets this savings account take USDC from your wallet. You only do this once.")
  const funds = operationFlowView(flowOf(FUNDS))
  assert.equal(funds.title, "Review investment")
  assert.equal(funds.payCaption, "You pay")
  assert.equal(funds.steps[1]!.walletLabel, "Confirm investment in your wallet")
  assert.equal(funds.steps[0]!.help?.answer, "Approving lets this fund take USDC from your wallet. You only do this once.")

  const saved = operationFlowView(flowOf(SAVINGS, { outcome: { kind: "success", hash: "0xb", received: "998.215" } }))
  assert.deepEqual(saved.result, {
    tone: "success",
    title: "Deposit successful!",
    message: "You're now earning 4.52% APY on your USDC.",
    from: { amount: "1,000", symbol: "USDC" },
    to: { amount: "998.215", symbol: "aUSD" },
    hash: "0xb",
  })
  const invested = operationFlowView(flowOf(FUNDS, { outcome: { kind: "success", hash: "0xb", received: "9.8765" } }))
  assert.equal(invested.result?.title, "Investment successful!")
  assert.equal(invested.result?.message, "You now hold 9.8765 aCAPIX in Aksia CAPIX.")
  // Without the receipt's amount: the estimate in the summary, and no exact claim in the message.
  const estimated = operationFlowView(flowOf(FUNDS, { outcome: { kind: "success", hash: "0xb", received: null } }))
  assert.deepEqual(estimated.result?.to, { amount: "≈9.87", symbol: "aCAPIX" })
  assert.equal(estimated.result?.message, "Your aCAPIX is now in your wallet.")
})

test("each operation's words: withdrawal, redemption and requests", () => {
  const success = (review: OperationReview, received: string | null = "1,001.5") => operationResultMessage(review, { kind: "success", hash: "0x1", received })
  const requested = (review: OperationReview) => operationResultMessage(review, { kind: "requested", hash: "0x1" })
  assert.equal(success({ ...SAVINGS, apyText: "—" }), "Your USDC is now earning yield.", "unknown APY")
  assert.equal(success({ ...FUNDS, productName: "aCAPIX" }, "9.8"), "You now hold 9.8 aCAPIX.", "no display name: not repeated")
  const withdraw: OperationReview = { ...SAVINGS, operation: "redeemInstant", pay: { ...SAVINGS.receive }, receive: { ...SAVINGS.pay } }
  assert.equal(operationFlowView(flowOf(withdraw, { steps: initialOperationSteps(false) })).title, "Review withdrawal")
  assert.equal(operationFlowView(flowOf(withdraw, { steps: initialOperationSteps(false) })).payCaption, "You withdraw")
  assert.equal(success(withdraw), "1,001.5 USDC is back in your wallet.")
  const redeem: OperationReview = { ...withdraw, kind: "funds" }
  assert.equal(operationFlowView(flowOf(redeem, { outcome: { kind: "success", hash: "0x1", received: "1" } })).result?.title, "Redemption complete!")
  assert.equal(success(redeem, null), "Your USDC is back in your wallet.")
  const savingsRequest: OperationReview = { ...withdraw, operation: "requestRedeem" }
  const fundsRequest: OperationReview = { ...redeem, operation: "requestRedeem" }
  assert.equal(requested(savingsRequest), "Your USDC arrives in your wallet once the withdrawal is processed. Track it in the Pending tab.")
  assert.equal(requested(fundsRequest), "Your USDC payout follows once the redemption is processed. Track it in the Pending tab.")
  const pending = operationFlowView(flowOf(fundsRequest, { steps: initialOperationSteps(false), outcome: { kind: "requested", hash: "0x2" } }))
  assert.equal(pending.result?.tone, "pending")
  assert.equal(pending.result?.title, "Redemption requested")
  assert.equal(pending.result?.to, null, "nothing received yet")
  const failed = operationFlowView(flowOf(FUNDS, { outcome: { kind: "failed", message: "User rejected the request." } }))
  assert.equal(failed.error, "User rejected the request.")
  assert.equal(failed.result, null)
})
