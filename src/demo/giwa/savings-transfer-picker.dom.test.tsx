// The Savings deposit / withdraw screen's coin row in React DOM: with coins to pick from, the deposit's coin row and the
// withdrawal's payout row open the token picker, a pick switches the screen to that coin (its chain named, its amount
// label), and nothing can be switched while a transaction is in flight. Gated like the other DOM tests
// (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

import type { SavingsAssetChoice } from "./savings-assets"
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

test("savings transfer screen: the coin row opens the token picker and a pick switches the coin (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
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
    // React DOM detects its event support when first loaded, so the screen is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsTransferFlow } = (await import("./SavingsTransferFlow")) as AnyModule
    const { SAVINGS_ASSET_OPTIONS } = (await import("./savings-assets")) as AnyModule
    const { act, createElement: h, useState } = React

    const option = (key: string) => SAVINGS_ASSET_OPTIONS.find((entry: { key: string }) => entry.key === key)
    const choices: SavingsAssetChoice[] = [
      { ...option("usdc-giwa"), available: true, balance: 9_000, usd: 9_000 },
      { ...option("usdt-ethereum"), available: true, balance: 10_000, usd: 10_000 },
      { ...option("rlusd-xrpl"), available: true, balance: 10_000, usd: 10_000 },
    ]
    const picks: string[] = []
    let setPhase: (phase: UiPhase) => void = () => undefined

    function Harness({ mode }: { mode: "deposit" | "withdraw" }) {
      const [selected, setSelected] = useState("usdc-giwa")
      const [phase, setPhaseState] = useState("ready" as UiPhase)
      const [amount, setAmount] = useState("")
      const [operation, setOperation] = useState(mode === "deposit" ? "deposit" : "redeemInstant")
      setPhase = setPhaseState
      const coin = option(selected)
      const panel = {
        product,
        price: 1,
        phase,
        operation,
        amount,
        flow: null,
        allowanceRequired: false,
        paymentBalance: "9000",
        productBalance: "40",
        pausedNotice: null,
        pendingRedemptions: [],
        onOperationChange: setOperation,
        onAmountChange: setAmount,
        onStart: () => undefined,
        onFlowClose: () => undefined,
        onFlowRetry: () => undefined,
        onConnect: () => undefined,
        onSwitchNetwork: () => undefined,
      }
      return h(SavingsTransferFlow, {
        open: true,
        mode,
        onClose: () => undefined,
        detail: {
          panel: panel as unknown as GiwaVaultDetail["panel"],
          market: { productId: "arcousd", navBase: 1, baseUsd: 1, navUsd: 1, apy: null, impliedApy: 4.79 },
          instantLiquidityUsd: 1_000_000,
          baseUsd: 1,
          vaultImage: undefined,
        },
        paySymbol: coin.symbol,
        payIcon: coin.logo,
        payChain: coin.chain,
        assetPicker: {
          choices,
          selected,
          onSelect: (key: string) => {
            picks.push(key)
            setSelected(key)
          },
        },
        tokenSymbol: "sArcoUSD",
        tokenIcon: undefined,
        apyPercent: 4.79,
        apyText: "4.79%",
        savingsUsd: 0,
        recipient: "0x1111111111111111111111111111111111111111",
      })
    }

    const root = createRoot(w.document.getElementById("giwa-main")!)
    const dialogs = () => [...w.document.querySelectorAll('[role="dialog"]')] as HTMLElement[]
    const coinRow = () => dialogs()[0]!.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement | null
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    // As a keyboard press or a pointer press in Chrome: the button takes focus, then activates.
    const press = (button: HTMLButtonElement) =>
      act(async () => {
        button.focus()
        button.click()
      })

    // Deposit: the coin paid with is a button naming its chain; it opens the picker on the coin in use.
    await act(async () => root.render(h(Harness, { mode: "deposit" })))
    await settle()
    assert.match(coinRow()!.textContent ?? "", /^USDC on GIWABalance 9,000, choose another coin$/)
    assert.ok(dialogs()[0]!.querySelector('input[aria-label="Amount in USDC"]'))
    await press(coinRow()!)
    await settle()
    assert.equal(dialogs().length, 2)
    const picker = dialogs()[1]!
    assert.equal(picker.querySelector('[data-choice="usdc-giwa"]')!.getAttribute("aria-pressed"), "true")
    // Picking the coin in use changes nothing; another coin switches the screen to it and closes the picker.
    await press(picker.querySelector('[data-choice="usdc-giwa"]') as HTMLButtonElement)
    assert.deepEqual(picks, [])
    assert.equal(dialogs().length, 1)
    await press(coinRow()!)
    await settle()
    await press(dialogs()[1]!.querySelector('[data-choice="usdt-ethereum"]') as HTMLButtonElement)
    await settle()
    assert.deepEqual(picks, ["usdt-ethereum"])
    assert.equal(dialogs().length, 1)
    assert.match(coinRow()!.textContent ?? "", /^USDT on Ethereum/)
    assert.ok(dialogs()[0]!.querySelector('input[aria-label="Amount in USDT"]'))
    // Focus is back on the row that opened the picker.
    assert.ok(w.document.activeElement === coinRow(), "focus back on the coin row")

    // While a transaction is in flight the row is no picker.
    await act(async () => setPhase("approving"))
    assert.equal(coinRow(), null)
    await act(async () => setPhase("ready"))
    assert.ok(coinRow())
    await act(async () => root.unmount())

    // Withdraw: the coin paid out is the picker; the savings token's row is not.
    const second = createRoot(w.document.getElementById("giwa-main")!)
    await act(async () => second.render(h(Harness, { mode: "withdraw" })))
    await settle()
    const pickers = [...dialogs()[0]!.querySelectorAll('button[aria-haspopup="dialog"]')]
    assert.equal(pickers.length, 1)
    assert.match(pickers[0]!.textContent ?? "", /^USDC on GIWA/)
    assert.ok(dialogs()[0]!.querySelector('input[aria-label="Amount in sArcoUSD"]'))
    await press(pickers[0] as HTMLButtonElement)
    await settle()
    await press(dialogs()[1]!.querySelector('[data-choice="rlusd-xrpl"]') as HTMLButtonElement)
    await settle()
    assert.match(coinRow()!.textContent ?? "", /^RLUSD on XRPL/)
    await act(async () => second.unmount())
    // jsdom fires a pending selectionchange on a timer; let it land while the DOM globals still exist.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
