// The Savings deposit / withdraw screen in React DOM, against a scripted stand-in for useGiwaProductOperation: one press
// starts one transaction with what the screen shows, a screen reopened while a transaction is still in flight can start
// nothing until it is done, and Confirm re-checks the wallet before sending. Gated like the other DOM tests
// (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

import type { OperationFlow, OperationReview } from "./operation-flow"
import type { TransferLeftRunning } from "./SavingsTransferFlow"
import type { GiwaCatalogItem, UiPhase } from "./types"
import type { GiwaVaultDetail } from "./useGiwaVaultDetail"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

const product = {
  productId: "arcousd",
  symbol: "arcoUSD",
  name: "Arco USD",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  vaultConfig: null,
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
} as unknown as GiwaCatalogItem

type HookState = {
  phase: UiPhase
  operation: string
  amount: string
  flow: OperationFlow | null
  allowanceRequired: boolean
}

const WALLET_PHASES: readonly UiPhase[] = ["disconnected", "wrong-network", "missing-gas"]

test("savings transfer screen: one press, one transaction; nothing new while one is in flight (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="giwa-main" tabindex="-1"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement, SVGElement: w.SVGElement,
    Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    // React DOM detects its event support when first loaded, so the screen is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsTransferFlow } = (await import("./SavingsTransferFlow")) as AnyModule
    const { act, createElement: h, useState } = React

    const calls = { operations: [] as string[], amounts: [] as string[], starts: [] as OperationReview[], switches: 0, closes: [] as (TransferLeftRunning | null)[] }
    let patchHook: (patch: Partial<HookState>) => void = () => undefined

    function Harness({ open, mode }: { open: boolean; mode: "deposit" | "withdraw" }) {
      const [state, setState] = useState({ phase: "ready", operation: "deposit", amount: "1", flow: null, allowanceRequired: true } as HookState)
      patchHook = (patch) => setState((current: HookState) => ({ ...current, ...patch }))
      const panel = {
        product,
        price: 1,
        ...state,
        paymentBalance: "500",
        productBalance: "40",
        pausedNotice: null,
        pendingRedemptions: [],
        // As the hook: switching the operation puts the phase back to ready (unless the wallet itself is not ready).
        onOperationChange: (operation: string) => {
          calls.operations.push(operation)
          setState((current: HookState) => ({ ...current, operation, phase: WALLET_PHASES.includes(current.phase) ? current.phase : "ready" }))
        },
        onAmountChange: (amount: string) => {
          calls.amounts.push(amount)
          setState((current: HookState) => ({ ...current, amount }))
        },
        onStart: (review: OperationReview) => {
          calls.starts.push(review)
          setState((current: HookState) => ({
            ...current,
            phase: "approving",
            flow: { id: (current.flow?.id ?? 0) + 1, review, steps: [{ id: "approve", state: "wallet" }, { id: "submit", state: "upcoming" }], outcome: null, open: true },
          }))
        },
        onFlowClose: () =>
          setState((current: HookState) => ({ ...current, flow: current.flow && current.flow.outcome === null ? { ...current.flow, open: false } : null })),
        onFlowRetry: () => undefined,
        onConnect: () => undefined,
        onSwitchNetwork: () => {
          calls.switches += 1
        },
      }
      return h(SavingsTransferFlow, {
        open,
        mode,
        onClose: (left: TransferLeftRunning | null) => calls.closes.push(left),
        detail: {
          panel: panel as unknown as GiwaVaultDetail["panel"],
          market: { productId: "arcousd", navBase: 1, baseUsd: 1, navUsd: 1, apy: null, impliedApy: 4.79 },
          instantLiquidityUsd: 1_000_000,
          baseUsd: 1,
          vaultImage: undefined,
        },
        paySymbol: "USDC",
        payIcon: "/logos/usdc.svg",
        tokenSymbol: "arcoUSD",
        tokenIcon: undefined,
        apyPercent: 4.79,
        apyText: "4.79%",
        savingsUsd: 0,
        recipient: "0x1111111111111111111111111111111111111111",
      })
    }

    const main = w.document.getElementById("giwa-main")!
    const root = createRoot(main)
    const dialog = () => w.document.querySelector('[role="dialog"]') as HTMLElement | null
    const button = (label: string) =>
      [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined
    const type = async (value: string, label = "Amount in USDC") => {
      const input = dialog()!.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new w.Event("input", { bubbles: true }))
      })
    }
    const press = async (label: string) => {
      const target = button(label)
      assert.ok(target, `button "${label}" is shown`)
      await act(async () => target!.click())
    }

    // Opening switches the hook to a deposit with an empty amount.
    await act(async () => root.render(h(Harness, { open: true, mode: "deposit" })))
    assert.deepEqual(calls.operations, ["deposit"])
    assert.deepEqual(calls.amounts, [""])
    assert.equal(button("Enter an Amount")?.disabled, true)

    // The screen is as wide as the Savings dialogs, its two cards side by side from md up.
    const classes = () => [...dialog()!.querySelectorAll("div")].map((element) => element.className)
    assert.ok(classes().some((name) => name.includes("max-w-[760px]")), "760px column")
    assert.ok(classes().some((name) => name.includes("md:grid-cols-2")), "side-by-side cards")

    // The savings token balance shows what is held, then rolls to what it will be after the deposit (here at once: the
    // test DOM has no animation frames): 40 held + 100 bought at a price of 1. Screen readers get the settled figure.
    const rolling = () => dialog()!.querySelector("[data-rolling-balance]")?.textContent
    assert.equal(rolling(), "40.00")
    await type("100")
    assert.equal(rolling(), "140.00")
    assert.match(dialog()!.textContent ?? "", /Balance after this deposit 140\.00/)
    // A deposit shows what it earns (100 at 4.79%); what a withdrawal stops earning is the withdraw screen's.
    assert.match(dialog()!.textContent ?? "", /Earn ~4\.79 USDC\/year/)
    assert.doesNotMatch(dialog()!.textContent ?? "", /If you withdraw now/)

    // The arcoUSD it buys (+100) rolls digit by digit: in from below as it appears and grows, down as it shrinks.
    const payout = () => dialog()!.querySelector("[data-rolling-digits]")
    assert.equal(payout()?.textContent, "100")
    assert.equal(payout()?.querySelectorAll(".savings-digit-in-up").length, 3)
    await type("60")
    assert.ok(payout()?.querySelector(".savings-digit-in-down"), "a smaller figure rolls in from above")
    assert.ok(payout()?.querySelector(".savings-digit-out-down"), "the old digit leaves through the bottom")
    await type("100")
    assert.ok(payout()?.querySelector(".savings-digit-in-up"), "a larger one from below again")

    // Amount → Review → Approve and Deposit: exactly one transaction, with what the screen showed.
    await press("Review")
    await press("Approve and Deposit")
    assert.equal(calls.starts.length, 1)
    assert.equal(calls.starts[0]!.operation, "deposit")
    assert.deepEqual([calls.starts[0]!.pay.amount, calls.starts[0]!.pay.symbol, calls.starts[0]!.receive.symbol], ["100", "USDC", "arcoUSD"])
    assert.match(dialog()!.textContent ?? "", /Approve USDC in your wallet/)
    // The step in progress shows its coin (USDC, for the approval) with the GIWA badge and a ring turning around them;
    // the steps still to come do not turn.
    const approveStep = dialog()!.querySelector('[data-step="approve"]')!
    assert.ok(approveStep.querySelector("[data-step-spinner].animate-spin"), "a turning ring")
    assert.ok(approveStep.querySelector('img[alt="USDC"]'), "the coin being approved")
    assert.ok(approveStep.querySelector('img[alt="GIWA"]'), "with the GIWA badge")
    assert.equal(dialog()!.querySelector('[data-step="submit"] [data-step-spinner]'), null)

    // Closed while the approval is in flight: it is reported as left running, approval only.
    const close = dialog()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement
    await act(async () => close.click())
    assert.deepEqual(calls.closes[calls.closes.length - 1], { mode: "deposit", approvalOnly: true })

    // Reopened while the approval is still confirming: the hook is NOT switched (that would reset its busy phase and let
    // a second transaction start beside the first), and nothing can be reviewed.
    await act(async () => root.render(h(Harness, { open: false, mode: "deposit" })))
    await act(async () => root.render(h(Harness, { open: true, mode: "deposit" })))
    assert.deepEqual(calls.operations, ["deposit"], "no switch while busy")
    assert.equal(button("Processing the transaction")?.disabled, true)

    // The approval confirms: only now is the screen reset.
    await act(async () => patchHook({ phase: "success" }))
    assert.deepEqual(calls.operations, ["deposit", "deposit"])
    assert.equal(calls.amounts[calls.amounts.length - 1], "")

    // Confirm re-checks the wallet: on the wrong network it switches networks instead of sending.
    await type("50")
    await press("Review")
    await act(async () => patchHook({ phase: "wrong-network" }))
    await press("Switch to GIWA")
    assert.equal(calls.switches, 1)
    assert.equal(calls.starts.length, 1, "nothing sent on the wrong network")

    // Withdrawing rolls the same balance down instead: 40 held − 15 withdrawn.
    await act(async () => root.render(h(Harness, { open: false, mode: "withdraw" })))
    await act(async () => patchHook({ phase: "ready" }))
    await act(async () => root.render(h(Harness, { open: true, mode: "withdraw" })))
    assert.equal(rolling(), "40.00")
    assert.doesNotMatch(dialog()!.textContent ?? "", /If you withdraw now/, "nothing forgone before an amount")
    await type("15", "Amount in arcoUSD")
    assert.equal(rolling(), "25.00")
    assert.match(dialog()!.textContent ?? "", /Balance after this withdrawal 25\.00/)
    // What the withdrawal stops earning: the 15 USDC it pays out, at 4.79% a year.
    assert.match(dialog()!.textContent ?? "", /If you withdraw now, you stop earning~0\.71 USDC\/year/)
    // As on the deposit screen, the Arco SAVINGS row with the current APY heads the card on the right, once: after the
    // amount, right above what is forgone.
    const withdrawText = dialog()!.textContent ?? ""
    assert.equal(withdrawText.split("Current APY").length - 1, 1, "one APY row")
    assert.ok(withdrawText.indexOf("Current APY") < withdrawText.indexOf("If you withdraw now"))
    const amountInput = dialog()!.querySelector('input[aria-label="Amount in arcoUSD"]')!
    const apyRow = [...dialog()!.querySelectorAll("span")].find((element) => element.textContent?.startsWith("Current APY"))!
    assert.ok(amountInput.compareDocumentPosition(apyRow) & w.Node.DOCUMENT_POSITION_FOLLOWING, "APY row in the card after the amount")

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
