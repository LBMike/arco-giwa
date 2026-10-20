// Get ArcoUSD's Convert screen in React DOM (SavingsTransferFlow `convert`): titled Convert, without the Savings words;
// the paying row's picker lists ArcoUSD too and picking it turns the conversion around; on the way back the coin received
// is picked; the two-way arrow turns it around; nothing turns or switches while a transaction is in flight. Gated like
// the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

import type { ArcoUsdConvert } from "./arcousd-convert"
import type { UiPhase } from "./types"
import type { GiwaVaultDetail } from "./useGiwaVaultDetail"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const
const convert: ArcoUsdConvert = {
  token: address(0xa1),
  priceFeed: address(0xa2),
  converters: ["usdc-ethereum", "usdc-giwa", "usdt-ethereum", "rlusd-ethereum", "rlusd-xrpl"].map((option, index) => ({
    option,
    token: address(0x10 + index),
    converter: address(0x20 + index),
  })),
}

test("Convert screen: ArcoUSD in the paying picker turns it around, the coin back is picked, the two-way arrow flips (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
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
    const { ARCOUSD_OPTION, CONVERT_OPTIONS, convertChoices, converterFor, convertProduct } = (await import("./arcousd-convert")) as AnyModule
    const { act, createElement: h, useState } = React

    const balances = { "usdc-giwa": 9000, "usdt-ethereum": 10000, "arcousd-giwa": 500 }
    const log: string[] = []
    let setPhase: (phase: UiPhase) => void = () => undefined

    function Harness() {
      const [direction, setDirection] = useState("in")
      const [coin, setCoin] = useState("usdc-giwa")
      const [phase, setPhaseState] = useState("ready" as UiPhase)
      const [amount, setAmount] = useState("")
      const [operation, setOperation] = useState("deposit")
      setPhase = setPhaseState
      const option = CONVERT_OPTIONS.find((entry: { key: string }) => entry.key === coin)
      const product = convertProduct(convert, option, converterFor(convert, coin))
      const panel = {
        product,
        price: 1,
        phase,
        operation,
        amount,
        flow: null,
        allowanceRequired: true,
        paymentBalance: "9000",
        productBalance: "500",
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
        mode: direction === "in" ? "deposit" : "withdraw",
        onClose: () => undefined,
        detail: {
          panel: panel as unknown as GiwaVaultDetail["panel"],
          market: { productId: product.productId, navBase: 1, baseUsd: 1, navUsd: 1, apy: null, impliedApy: null },
          instantLiquidityUsd: null,
          baseUsd: 1,
          vaultImage: undefined,
        },
        paySymbol: option.symbol,
        payIcon: option.logo,
        payChain: option.chain,
        assetPicker: {
          choices: convertChoices(convert, balances, false),
          selected: coin,
          onSelect: (key: string) => {
            log.push(`coin:${key}`)
            setCoin(key)
          },
        },
        convert: {
          onFlip: () => {
            log.push("flip")
            setDirection((current: string) => (current === "in" ? "out" : "in"))
          },
          payPicker: {
            choices: convertChoices(convert, balances, true),
            selected: direction === "in" ? coin : ARCOUSD_OPTION.key,
            onSelect: (key: string) => {
              log.push(`pay:${key}`)
              if (key === ARCOUSD_OPTION.key) setDirection("out")
              else {
                setCoin(key)
                setDirection("in")
              }
            },
          },
        },
        tokenSymbol: "ArcoUSD",
        tokenIcon: "/logos/arcousd.png",
        apyPercent: null,
        apyText: "—",
        savingsUsd: null,
        recipient: "0x1111111111111111111111111111111111111111",
      })
    }

    const root = createRoot(w.document.getElementById("giwa-main")!)
    const dialogs = () => [...w.document.querySelectorAll('[role="dialog"]')] as HTMLElement[]
    const screen = () => dialogs()[0]!
    const rows = () => [...screen().querySelectorAll('button[aria-haspopup="dialog"]')] as HTMLButtonElement[]
    const flips = () => [...screen().querySelectorAll('button[aria-label="Switch direction"]')] as HTMLButtonElement[]
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    // As a keyboard press or a pointer press in Chrome: the button takes focus, then activates.
    const press = (button: HTMLButtonElement) =>
      act(async () => {
        button.focus()
        button.click()
      })
    const type = (input: HTMLInputElement, value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!
        setter.call(input, value)
        input.dispatchEvent(new w.Event("input", { bubbles: true }))
      })

    await act(async () => root.render(h(Harness)))
    await settle()
    // Titled Convert, without the Savings words; the arrow between the cards is a button (one per layout).
    assert.equal(screen().querySelector("h2")!.textContent, "Convert")
    assert.doesNotMatch(screen().textContent ?? "", /SAVINGS|Current APY|Earn ~|stop earning/)
    assert.equal(flips().length, 2)
    assert.ok(flips().every((button) => button.querySelector("svg") !== null && button.textContent === ""))

    // In: the coin paid is a picker; ArcoUSD, received, is not.
    assert.equal(rows().length, 1)
    assert.match(rows()[0]!.textContent ?? "", /^USDC on GIWABalance 9,000, choose another coin$/)
    assert.ok(screen().querySelector('input[aria-label="Amount in USDC"]'))
    await type(screen().querySelector('input[aria-label="Amount in USDC"]') as HTMLInputElement, "100")
    assert.match(screen().textContent ?? "", /1 USDC = 1 ArcoUSD/)
    assert.match(screen().textContent ?? "", /ArcoUSDBalance 500\+100/)

    // The paying picker lists ArcoUSD as well; picking it turns the conversion around.
    await press(rows()[0]!)
    await settle()
    assert.equal(dialogs().length, 2)
    assert.ok(dialogs()[1]!.querySelector('[data-choice="arcousd-giwa"]'))
    await press(dialogs()[1]!.querySelector('[data-choice="arcousd-giwa"]') as HTMLButtonElement)
    await settle()
    assert.deepEqual(log, ["pay:arcousd-giwa"])
    assert.equal(dialogs().length, 1)

    // Out: ArcoUSD is paid (its picker still opens) and the coin received is picked, from the stablecoins only.
    assert.equal(rows().length, 2)
    assert.match(rows()[0]!.textContent ?? "", /^ArcoUSD on GIWABalance 500, choose another coin$/)
    assert.match(rows()[1]!.textContent ?? "", /^USDC on GIWABalance 9,000, choose another coin$/)
    assert.ok(screen().querySelector('input[aria-label="Amount in ArcoUSD"]'))
    await press(rows()[1]!)
    await settle()
    assert.equal(dialogs()[1]!.querySelector('[data-choice="arcousd-giwa"]'), null)
    await press(dialogs()[1]!.querySelector('[data-choice="usdt-ethereum"]') as HTMLButtonElement)
    await settle()
    assert.deepEqual(log, ["pay:arcousd-giwa", "coin:usdt-ethereum"])
    assert.match(rows()[1]!.textContent ?? "", /^USDT on Ethereum/)
    await type(screen().querySelector('input[aria-label="Amount in ArcoUSD"]') as HTMLInputElement, "50")
    assert.match(screen().textContent ?? "", /1 ArcoUSD = 1 USDT/)

    // The two-way arrow turns it back: USDT is paid now.
    await press(flips()[1]!)
    await settle()
    assert.deepEqual(log, ["pay:arcousd-giwa", "coin:usdt-ethereum", "flip"])
    assert.equal(rows().length, 1)
    assert.match(rows()[0]!.textContent ?? "", /^USDT on Ethereum/)

    // The review's action converts (approving first when needed).
    await type(screen().querySelector('input[aria-label="Amount in USDT"]') as HTMLInputElement, "100")
    const review = [...screen().querySelectorAll("button")].find((button) => button.textContent === "Review") as HTMLButtonElement
    await press(review)
    await settle()
    assert.ok([...screen().querySelectorAll("button")].some((button) => button.textContent === "Approve and Convert"))
    await press(screen().querySelector('button[aria-label="Back"]') as HTMLButtonElement)
    await settle()

    // While a transaction is in flight nothing turns or switches.
    await act(async () => setPhase("approving"))
    assert.ok(flips().every((button) => button.disabled))
    assert.equal(rows().length, 0)
    await act(async () => setPhase("ready"))
    assert.ok(flips().every((button) => !button.disabled))
    await act(async () => root.unmount())
    // jsdom fires a pending selectionchange on a timer; let it land while the DOM globals still exist.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
