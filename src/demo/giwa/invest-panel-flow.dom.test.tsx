// GiwaInvestPanel with the transaction modal (onStart): the button names the operation even while an approval is still
// needed (the approval is the modal's first step), and one press hands the modal exactly what the panel shows.
// The press itself runs in React DOM, gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { GiwaInvestPanel } from "./components"
import type { OperationReview } from "./operation-flow"
import type { GiwaCatalogItem } from "./types"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type PanelProps = Parameters<typeof GiwaInvestPanel>[0]
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

const product = {
  productId: "acapix",
  symbol: "aCAPIX",
  name: "Arco CAPIX",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6, contract: { proxy: "0x00000000000000000000000000000000000000a1" }, faucet: "0x00000000000000000000000000000000000000f1" },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
} as unknown as GiwaCatalogItem

const props = (over: Record<string, unknown> = {}) =>
  ({
    product, price: 1, operation: "deposit", amount: "5", requestId: "1", paymentBalance: "100", productBalance: "50", allowance: "0",
    allowanceRequired: true, greenlistEnforced: false, activeVault: null, phase: "allowance-required", pausedNotice: null, error: null,
    txHashes: [], pendingRedemptions: [], onOperationChange: () => undefined, onAmountChange: () => undefined, onRequestIdChange: () => undefined,
    onApprove: () => undefined, onSubmit: () => undefined, onRequestRedeem: () => undefined, onClaim: () => undefined,
    onConnect: () => undefined, onSwitchNetwork: () => undefined,
    ...over,
  }) as unknown as PanelProps

/** The primary button's label: the last <button> in the panel. */
const primary = (html: string) => {
  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, "").trim())
  return buttons[buttons.length - 1]
}

test("with the modal the button names the operation; without it the panel keeps its Approve press", () => {
  assert.equal(primary(renderToStaticMarkup(<GiwaInvestPanel {...props({ onStart: () => undefined })} />)), "Invest")
  assert.equal(primary(renderToStaticMarkup(<GiwaInvestPanel {...props()} />)), "Approve")
  // Prerequisites still come first.
  assert.equal(primary(renderToStaticMarkup(<GiwaInvestPanel {...props({ onStart: () => undefined, amount: "500" })} />)), "Insufficient Balance")
  assert.equal(primary(renderToStaticMarkup(<GiwaInvestPanel {...props({ onStart: () => undefined, phase: "disconnected" })} />)), "Connect Wallet")
})

test("one press hands the modal what the panel shows (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="giwa-main" tabindex="-1"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { act, createElement: h } = React
    const main = w.document.getElementById("giwa-main")!
    const root = createRoot(main)
    const reviews: OperationReview[] = []
    let approvals = 0
    const press = async (over: Record<string, unknown>) => {
      await act(async () => root.render(h(GiwaInvestPanel, props({ onStart: (review: OperationReview) => reviews.push(review), onApprove: () => { approvals += 1 }, ...over }))))
      const buttons = main.querySelectorAll("button")
      const button = buttons[buttons.length - 1] as HTMLButtonElement
      await act(async () => button.click())
      return reviews[reviews.length - 1]
    }

    // Funds, an approval still needed: the modal gets the operation (its approval is the modal's job), not Approve.
    assert.deepEqual(await press({}), {
      kind: "funds",
      operation: "deposit",
      productName: "aCAPIX",
      pay: { amount: "5", symbol: "USDC", icon: "/logos/usdc.svg", sub: "~$5.00" },
      receive: { amount: "5", symbol: "aCAPIX", icon: "/logos/aksia.svg", sub: "~$5.00" },
      apyText: null,
    })
    assert.equal(approvals, 0, "the panel's own Approve press is not used")

    // Savings: its APY rides along for the success screen.
    const savings = await press({ amount: "1000", paymentBalance: "5000", price: 2, savings: { apyText: "4.52%", apyPercent: 4.52, acceptAssetIcon: null } })
    assert.equal(savings?.kind, "savings")
    assert.equal(savings?.apyText, "4.52%")
    assert.deepEqual(savings?.pay, { amount: "1,000", symbol: "USDC", icon: "/logos/usdc.svg", sub: "~$1000.00" })
    assert.equal(savings?.receive.amount, "500")

    // Redeem beyond instant liquidity: the modal runs a redemption request.
    const request = await press({ operation: "redeemInstant", allowanceRequired: false, phase: "ready", instantLiquidityUsd: 1, baseUsd: 1 })
    assert.equal(request?.operation, "requestRedeem")
    assert.deepEqual([request?.pay.symbol, request?.receive.symbol], ["aCAPIX", "USDC"])
    assert.equal(reviews.length, 3)

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
