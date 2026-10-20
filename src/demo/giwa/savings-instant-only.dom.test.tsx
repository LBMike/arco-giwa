// The Savings withdraw screen on ArcoUSD v1 (the sArcoUSD account, Get ArcoUSD back to a coin): withdrawals are Instant
// only, so a withdrawal larger than the free buffer is stopped with the buffer named, instead of turning into a request.
// Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

import type { GiwaCatalogItem, UiPhase } from "./types"
import type { GiwaVaultDetail } from "./useGiwaVaultDetail"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

const product = {
  productId: "sarcousd",
  symbol: "sArcoUSD",
  name: "sArcoUSD",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "USD Coin", decimals: 6 },
  vaultConfig: null,
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000c1",
  priceFeedAddress: null,
  arcoUSD: { kind: "zap", depositPrice: 1, redeemPrice: 1 },
} as unknown as GiwaCatalogItem

test("ArcoUSD v1 withdraw screen: Instant only; past the free buffer it stops and names the buffer (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
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
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsTransferFlow } = (await import("./SavingsTransferFlow")) as AnyModule
    const { act, createElement: h, useState } = React

    const calls = { operations: [] as string[] }

    function Harness({ instantOnly, liquidity }: { instantOnly: boolean; liquidity: number }) {
      const [state, setState] = useState({ phase: "ready" as UiPhase, operation: "deposit", amount: "1" })
      const panel = {
        product,
        price: 1,
        ...state,
        flow: null,
        allowanceRequired: false,
        instantOnly,
        paymentBalance: "500",
        productBalance: "300",
        pausedNotice: null,
        pendingRedemptions: [],
        onOperationChange: (operation: string) => {
          calls.operations.push(operation)
          setState((current: typeof state) => ({ ...current, operation, phase: "ready" as UiPhase }))
        },
        onAmountChange: (amount: string) => setState((current: typeof state) => ({ ...current, amount })),
        onStart: () => undefined,
        onFlowClose: () => undefined,
        onFlowRetry: () => undefined,
        onConnect: () => undefined,
        onSwitchNetwork: () => undefined,
      }
      return h(SavingsTransferFlow, {
        open: true,
        mode: "withdraw",
        onClose: () => undefined,
        detail: {
          panel: panel as unknown as GiwaVaultDetail["panel"],
          market: { productId: "sarcousd", navBase: 1, baseUsd: 1, navUsd: 1, apy: 4.5, impliedApy: null },
          instantLiquidityUsd: liquidity,
          baseUsd: 1,
          vaultImage: undefined,
        },
        paySymbol: "USDC",
        payIcon: "/logos/usdc.svg",
        tokenSymbol: "sArcoUSD",
        tokenIcon: undefined,
        apyPercent: 4.5,
        apyText: "4.5%",
        savingsUsd: 300,
        recipient: "0x1111111111111111111111111111111111111111",
      })
    }

    const main = w.document.getElementById("giwa-main")!
    const root = createRoot(main)
    const dialog = () => w.document.querySelector('[role="dialog"]') as HTMLElement | null
    const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])] as HTMLButtonElement[]
    const button = (label: string) => buttons().find((item) => item.textContent?.trim() === label)
    const type = async (value: string) => {
      const input = dialog()!.querySelector('input[aria-label^="Amount in"]') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new w.Event("input", { bubbles: true }))
      })
    }

    // 10 USDC free in the Reserve; 100 sArcoUSD asked: Instant only, so it stops and says what can go now.
    await act(async () => root.render(h(Harness, { instantOnly: true, liquidity: 10 })))
    assert.deepEqual(calls.operations, ["redeemInstant"], "the hook runs an Instant withdrawal")
    await type("100")
    const text = () => dialog()!.textContent ?? ""
    assert.match(text(), /Instant liquidity is 10 USDC\. Withdraw up to that amount, or try again later\./)
    assert.doesNotMatch(text(), /processed as a request/)
    assert.equal(button("Temporarily unavailable")?.disabled, true)
    assert.deepEqual(calls.operations, ["redeemInstant"], "never switched to a request")

    // Within the buffer it goes ahead.
    await type("5")
    assert.doesNotMatch(text(), /Instant liquidity is/)
    assert.equal(button("Review")?.disabled, false)

    // A vault pair (not ArcoUSD v1) keeps its request: the same shortfall is offered as a requested withdrawal.
    await act(async () => root.render(h(Harness, { instantOnly: false, liquidity: 10 })))
    await type("100")
    assert.match(text(), /processed as a request/)
    assert.equal(button("Review")?.disabled, false)

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
