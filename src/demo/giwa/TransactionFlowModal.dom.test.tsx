// The transaction modal in React DOM: focus moves in and back, Tab stays inside, Escape closes (and never reaches a bottom
// sheet's own listener underneath), a layer on top keeps its keys, the backdrop closes only a finished flow, the body
// scroll lock is released, and a pending step's timer runs.
//
// Gated like the other DOM tests: set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

import type { FlowStep, TransactionFlowModalProps } from "./TransactionFlowModal"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("transaction modal: focus, keys, backdrop, scroll lock and timer (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="giwa-main" tabindex="-1"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent, MutationObserver: w.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { TransactionFlowModal } = (await import("./TransactionFlowModal")) as AnyModule
    const { act, createElement: h } = React
    const doc: Document = w.document
    const main = doc.getElementById("giwa-main")!
    const root = createRoot(main)

    const approve: FlowStep = { id: "approve", label: "Approve USDC", walletLabel: "Approve USDC in your wallet", processingLabel: "Approving USDC…", help: { question: "Why do I have to approve?", answer: "Once." }, state: "wallet" }
    const submit: FlowStep = { id: "submit", label: "Confirm deposit", walletLabel: "Confirm deposit in your wallet", processingLabel: "Deposit pending…", state: "upcoming" }
    let closes = 0
    const props = (patch: Partial<TransactionFlowModalProps>): TransactionFlowModalProps => ({
      open: true,
      title: "Review deposit",
      pay: { caption: "You deposit", amount: "1,000", symbol: "USDC" },
      steps: [approve, submit],
      result: null,
      error: null,
      onClose: () => { closes += 1 },
      ...patch,
    })
    const show = async (patch: Partial<TransactionFlowModalProps>) =>
      act(async () => root.render(h("div", null, h("button", { type: "button", id: "opener" }, "Invest"), h(TransactionFlowModal, props(patch)))))
    const key = async (target: Element, init: Record<string, unknown>) => {
      const event = new w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
      await act(async () => { target.dispatchEvent(event) })
      return event
    }
    const dialog = () => doc.querySelector('[role="dialog"][aria-modal="true"]')

    // Closed: nothing. The opener has focus when it opens.
    await show({ open: false })
    const opener = doc.getElementById("opener") as HTMLButtonElement
    opener.focus()
    assert.equal(dialog(), null)
    await show({})
    const close = dialog()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement
    assert.equal(doc.activeElement, close, "focus moves to Close")
    assert.equal(dialog()!.getAttribute("aria-labelledby") !== null && doc.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent, "Review deposit")
    assert.equal(doc.body.style.overflow, "hidden", "the page behind does not scroll")
    assert.ok(dialog()!.closest(".arco-demo"), "the portal keeps the theme tokens")

    // Tab stays inside: Close → the "why" → Close.
    const why = dialog()!.querySelector("summary") as HTMLElement
    let event = await key(close, { key: "Tab", shiftKey: true })
    assert.equal(event.defaultPrevented, true)
    assert.equal(doc.activeElement, why, "Shift+Tab from the first wraps to the last")
    event = await key(why, { key: "Tab" })
    assert.equal(doc.activeElement, close, "Tab from the last wraps to the first")

    // Escape closes this dialog only: a bottom sheet's document listener underneath never sees it.
    const sheetKeys: string[] = []
    const sheetListener = (e: KeyboardEvent) => sheetKeys.push(e.key)
    doc.addEventListener("keydown", sheetListener)
    await key(close, { key: "Escape" })
    assert.equal(closes, 1)
    assert.deepEqual(sheetKeys, [])

    // A layer opened on top (the wallet's own dialog) keeps its keys.
    const wallet = doc.createElement("div")
    wallet.setAttribute("role", "dialog")
    const walletButton = doc.createElement("button")
    wallet.append(walletButton)
    doc.body.append(wallet)
    walletButton.focus()
    await key(walletButton, { key: "Escape" })
    assert.equal(closes, 1, "Escape in the wallet's dialog does not close the flow")
    assert.deepEqual(sheetKeys, ["Escape"])
    wallet.remove()
    doc.removeEventListener("keydown", sheetListener)

    // The backdrop closes only a finished flow.
    const backdrop = () => dialog()!.parentElement as HTMLElement
    await act(async () => { backdrop().dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true })) })
    assert.equal(closes, 1, "a stray tap never stops a flow in progress")
    await show({ dismissible: true, result: { tone: "success", title: "Deposit successful!", message: "You're now earning 4.5% APY on your USDC." } })
    await act(async () => { backdrop().dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true })) })
    assert.equal(closes, 2)

    // Closing gives focus back to the opener and releases the scroll lock.
    close.focus()
    await show({ open: false })
    assert.equal(dialog(), null)
    assert.equal(doc.activeElement, opener, "focus returns to the opener")
    assert.equal(doc.body.style.overflow, "")

    // A pending step counts up.
    await show({ steps: [{ ...approve, state: "done" }, { ...submit, state: "processing" }] })
    await act(async () => { await sleep(1_150) })
    const pending = dialog()!.querySelector('[data-step="submit"]')!
    assert.match(pending.textContent ?? "", /Deposit pending…00:0[12]/)

    await act(async () => root.unmount())
    assert.equal(doc.body.style.overflow, "")
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
