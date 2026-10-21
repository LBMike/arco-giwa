// The fund invest panel's pay asset in React DOM: the "You pay" token chip opens the Savings token picker ("Select a
// token"), a GIWA coin the Router takes switches the pay asset, coming-soon coins cannot be picked, and the Transaction
// Fees breakdown names the stablecoin swap fee of the coin paid with behind a "?". Gated like the other DOM tests
// (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import type { PayAssetOption } from "./arcousd-buy"
import type { GiwaCatalogItem } from "./types"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

const product = {
  productId: "umint",
  symbol: "uMINT",
  name: "Arco uMINT",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
} as unknown as GiwaCatalogItem

const option = (label: string, symbol: string, n: number, decimals: number, swapFeeBps: number, isArcoUSD = false): PayAssetOption => ({
  key: `0x${n.toString(16).padStart(40, "0")}`,
  symbol,
  label,
  address: `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`,
  decimals,
  swapFeeBps,
  isArcoUSD,
})
const USDC = option("USDC", "tUSDC", 0xa1, 6, 0)
const USDT = option("USDT", "tUSDT", 0xa2, 6, 10)
const RLUSD = option("RLUSD", "tRLUSD", 0xa3, 18, 10)
const ARCO = option("ArcoUSD", "ArcoUSD", 0xa4, 18, 0, true)
const PAY_ASSETS = [USDC, USDT, RLUSD, ARCO]

test("fund pay asset: the chip opens the token picker, a GIWA coin switches it, the swap fee sits in Transaction Fees (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="giwa-main" tabindex="-1"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement, SVGElement: w.SVGElement,
    Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    // React DOM detects its event support when first loaded, so it is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { GiwaInvestPanel } = (await import("./components")) as AnyModule
    const { fundPayChoices } = (await import("./arcousd-buy")) as AnyModule
    const { act, createElement: h, useState } = React

    const chosen: string[] = []
    const balances: Record<string, number> = { [USDC.key]: 100, [USDT.key]: 5_000, [RLUSD.key]: 0, [ARCO.key]: 20 }
    let setPhase: (phase: string) => void = () => undefined
    function Harness() {
      const [payKey, setPayKey] = useState(USDC.key)
      const [phase, setPhaseState] = useState("ready")
      setPhase = setPhaseState
      const payAsset = PAY_ASSETS.find((asset) => asset.key === payKey)!
      return h(GiwaInvestPanel, {
        product,
        price: 1,
        operation: "deposit",
        amount: "10",
        requestId: "1",
        paymentBalance: "100",
        productBalance: "0",
        allowance: "0",
        allowanceRequired: false,
        greenlistEnforced: false,
        activeVault: product.depositVaultAddress,
        phase,
        pausedNotice: null,
        error: null,
        txHashes: [],
        pendingRedemptions: [],
        routed: true,
        payAssets: PAY_ASSETS,
        payAsset,
        payBalance: String(balances[payKey]),
        payChoices: fundPayChoices(PAY_ASSETS, (asset: PayAssetOption) => balances[asset.key] ?? null),
        onPayAssetChange: (key: string) => {
          chosen.push(key)
          setPayKey(key)
        },
        onOperationChange: () => undefined,
        onAmountChange: () => undefined,
        onRequestIdChange: () => undefined,
        onApprove: () => undefined,
        onSubmit: () => undefined,
        onRequestRedeem: () => undefined,
        onClaim: () => undefined,
        onConnect: () => undefined,
        onSwitchNetwork: () => undefined,
      })
    }

    const doc = w.document
    const root = createRoot(doc.getElementById("giwa-main")!)
    await act(async () => root.render(h(Harness)))
    const chip = () => doc.querySelector('button[aria-label^="Pay with: "]') as HTMLButtonElement
    const dialog = () => doc.querySelector('[role="dialog"]') as HTMLElement | null
    const row = (key: string) => dialog()!.querySelector(`[data-choice="${key}"]`) as HTMLButtonElement
    // A press focuses the button it lands on (jsdom's click() does not), which is where the picker returns focus.
    const click = (element: HTMLElement) =>
      act(async () => {
        element.focus()
        element.click()
      })

    // The chip names the coin paid with and opens the picker on top of the panel.
    assert.equal(chip().getAttribute("aria-label"), "Pay with: USDC")
    assert.equal(chip().getAttribute("aria-haspopup"), "dialog")
    assert.ok(dialog() === null, "no picker")
    await click(chip())
    await act(settle)
    assert.equal(doc.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent, "Select a token")
    assert.ok(dialog()!.closest(".arco-demo"), "the picker is portalled inside the theme scope")
    assert.equal(row("usdc-giwa").getAttribute("aria-pressed"), "true")
    // The Router's coins on GIWA can be picked; the coins on other chains are coming soon.
    for (const key of ["usdc-giwa", "usdt-giwa", "rlusd-giwa", "arcousd-giwa"]) assert.equal(row(key).disabled, false, key)
    for (const key of ["usdc-ethereum", "usdt-ethereum", "rlusd-ethereum", "rlusd-xrpl"]) assert.equal(row(key).disabled, true, key)
    // The rows carry no fee notes (the fee is in Transaction Fees).
    assert.doesNotMatch(dialog()!.textContent ?? "", /fee/i)

    // Picking USDT closes the picker, switches the pay asset and gives focus back to the chip.
    await click(row("usdt-giwa"))
    await act(settle)
    assert.ok(dialog() === null, "no picker")
    assert.deepEqual(chosen, [USDT.key])
    assert.equal(chip().getAttribute("aria-label"), "Pay with: USDT")
    assert.ok(doc.activeElement === chip(), `focus is on ${doc.activeElement?.outerHTML.slice(0, 80)}`)

    // The coin already in use changes nothing.
    await click(chip())
    await act(settle)
    await click(row("usdt-giwa"))
    await act(settle)
    assert.deepEqual(chosen, [USDT.key])

    // Transaction Fees: the stablecoin swap fee of the coin paid with, and a "?" saying which coins pay it and who charges it.
    const feesToggle = [...doc.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Transaction Fees") as HTMLButtonElement
    await click(feesToggle)
    const help = () => doc.querySelector('button[aria-label="About Stablecoin swap fee"]') as HTMLButtonElement
    const swapRow = () => help().closest("div.border-t") as HTMLElement
    assert.ok(help(), "the swap fee row has a ? badge")
    assert.match(swapRow().textContent ?? "", /Stablecoin swap fee\s*\?\s*0\.1%/)
    const tip = "Paying with USDT or RLUSD includes a 0.1% swap fee. USDC and ArcoUSD have no swap fee. This fee goes to the third-party infrastructure that swaps the stablecoin."
    assert.equal(help().getAttribute("title"), tip) // shown on hover
    assert.equal(help().getAttribute("aria-expanded"), "false")
    await click(help()) // a press shows it under the row (touch screens)
    assert.equal(help().getAttribute("aria-expanded"), "true")
    assert.match(swapRow().textContent ?? "", new RegExp(tip.replace(/[.()?]/g, "\\$&")))

    // ArcoUSD pays no swap fee.
    await click(chip())
    await act(settle)
    await click(row("arcousd-giwa"))
    await act(settle)
    assert.equal(chip().getAttribute("aria-label"), "Pay with: ArcoUSD")
    assert.match(swapRow().textContent ?? "", /Stablecoin swap fee\s*\?\s*0%/)

    // Escape closes the picker and focus goes back to the chip; nothing changes.
    await click(chip())
    await act(settle)
    await act(async () => {
      doc.activeElement!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    assert.ok(dialog() === null, "Escape closed the picker")
    assert.ok(doc.activeElement === chip(), "focus is back on the chip")
    assert.equal(chosen.length, 2)

    // While a transaction runs the chip is locked, and a pick from a picker left open changes nothing.
    await click(chip())
    await act(settle)
    await act(async () => setPhase("submitting"))
    assert.equal(chip().disabled, true)
    await click(row("usdc-giwa"))
    await act(settle)
    assert.equal(chosen.length, 2)
    assert.equal(chip().getAttribute("aria-label"), "Pay with: ArcoUSD")

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
