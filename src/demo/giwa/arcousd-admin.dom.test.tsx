// Admin · ArcoUSD processQueue control and the fund-buy pay-asset dropdown in React DOM:
// Preview → Sign & send (with the confirming step), a refused preview, and the dropdown's open /
// choose / Escape behaviour inside its themed portal.
//
// Gated like the other DOM tests: set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function withDom(run: (env: { doc: Document; React: AnyModule; root: AnyModule; act: (fn: () => unknown) => Promise<void> }) => Promise<void>) {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
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
    const root = createRoot(w.document.getElementById("root"))
    const act = async (fn: () => unknown) => {
      await React.act(async () => {
        await fn()
      })
    }
    await run({ doc: w.document, React, root, act })
    await act(() => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
}

const button = (doc: Document, label: string) => {
  const found = [...doc.querySelectorAll("button")].find((element) => element.textContent?.trim() === label)
  assert.ok(found, `no button "${label}"`)
  return found as HTMLButtonElement
}

test("processQueue control: preview, then sign & send with a confirming step (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { ProcessQueueControl } = (await import("./AdminArcoUSD")) as AnyModule
    const prepared = {
      transaction: { chainId: 91342, to: "0x00000000000000000000000000000000000000e5", value: "0x0", data: "0x", description: "processQueue" },
      symbol: "tUSDC",
      maxCount: 5,
      preview: { paid: 2, blockNumber: "777" },
    }
    const calls: string[] = []
    let finishConfirm: () => void = () => undefined
    const onPrepare = async (count: number) => {
      calls.push(`prepare:${count}`)
      return prepared
    }
    const onSend = (sent: unknown, onSigned: (hash: string) => void) =>
      new Promise<string>((resolve) => {
        calls.push(`send:${sent === prepared}`)
        onSigned(`0x${"ab".repeat(32)}`)
        finishConfirm = () => resolve(`0x${"ab".repeat(32)}`)
      })
    await act(() =>
      root.render(
        React.createElement(ProcessQueueControl, {
          symbol: "tUSDC",
          walletAddress: "0x00000000000000000000000000000000000000ee",
          onConnectWallet: () => undefined,
          onPrepare,
          onSend,
        }),
      ),
    )
    assert.equal(button(doc, "Sign & send").disabled, true)
    const input = doc.querySelector("input") as HTMLInputElement
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
      setter.call(input, "5")
      input.dispatchEvent(new window.Event("input", { bubbles: true }))
    })
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.deepEqual(calls, ["prepare:5"])
    assert.match(doc.body.textContent ?? "", /Would pay 2 requests now \(block 777\)\./)
    await act(() => button(doc, "Sign & send").click())
    assert.ok(button(doc, "Confirming…").disabled)
    assert.equal(input.disabled, true) // the batch cannot change under a transaction in flight
    await act(() => finishConfirm())
    await act(tick)
    assert.deepEqual(calls, ["prepare:5", "send:true"])
    assert.match(doc.body.textContent ?? "", /Sent\. View transaction/)
    assert.equal(button(doc, "Sign & send").disabled, true) // spent: preview again for the next batch
  })
})

test("processQueue control: a dry run that pays nothing cannot be sent", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { ProcessQueueControl } = (await import("./AdminArcoUSD")) as AnyModule
    const nothing = {
      transaction: { chainId: 91342, to: "0x00000000000000000000000000000000000000e5", value: "0x0", data: "0x", description: "processQueue" },
      symbol: "tUSDC",
      maxCount: 20,
      preview: { paid: 0, blockNumber: "778" },
    }
    await act(() =>
      root.render(
        React.createElement(ProcessQueueControl, {
          symbol: "tUSDC",
          walletAddress: "0x00000000000000000000000000000000000000ee",
          onConnectWallet: () => undefined,
          onPrepare: async () => nothing,
          onSend: async () => "0x",
        }),
      ),
    )
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /Would pay nothing now \(block 778\)/)
    assert.equal(button(doc, "Sign & send").disabled, true)
  })
})

test("processQueue control: a refused preview shows the server's reason and sends nothing", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { ProcessQueueControl } = (await import("./AdminArcoUSD")) as AnyModule
    let sent = 0
    await act(() =>
      root.render(
        React.createElement(ProcessQueueControl, {
          symbol: "tUSDT",
          walletAddress: "0x00000000000000000000000000000000000000ee",
          onConnectWallet: () => undefined,
          onPrepare: async () => {
            throw new Error("ArcoUSD is not deployed")
          },
          onSend: async () => {
            sent++
            return "0x"
          },
        }),
      ),
    )
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /ArcoUSD is not deployed/)
    assert.equal(button(doc, "Sign & send").disabled, true)
    assert.equal(sent, 0)
  })
})

test("pay-asset dropdown: opens in a themed portal, chooses, and Escape returns focus (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { PayAssetSelect } = (await import("./PayAssetSelect")) as AnyModule
    const chosen: string[] = []
    const options = [
      { key: "usdc", label: "USDC", note: "No fee" },
      { key: "usdt", label: "USDT", note: "0.1% fee" },
    ]
    await act(() => root.render(React.createElement(PayAssetSelect, { options, selected: "usdc", onSelect: (key: string) => chosen.push(key) })))
    const trigger = doc.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
    await act(() => trigger.click())
    const menu = doc.querySelector('[role="menu"]') as HTMLElement
    assert.ok(menu, "menu opened")
    assert.ok(menu.parentElement?.classList.contains("arco-demo"), "the portal is wrapped in the theme scope")
    assert.equal(doc.activeElement?.getAttribute("aria-checked"), "true") // focus on the selected option
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[]
    await act(() => items[1].click())
    assert.deepEqual(chosen, ["usdt"])
    assert.equal(doc.querySelector('[role="menu"]'), null)
    assert.equal(doc.activeElement, trigger)

    await act(() => trigger.click())
    await act(() => {
      doc.querySelector('[role="menu"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    assert.equal(doc.querySelector('[role="menu"]'), null)
    assert.equal(doc.activeElement, trigger)
  })
})

test("alerts card: a test send shows each channel's answer (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { AlertsCard } = (await import("./AdminArcoUSD")) as AnyModule
    let answer: () => void = () => undefined
    const props = (onTest: () => Promise<unknown>) => ({
      hasAuth: true,
      now: Date.parse("2026-10-19T12:00:00.000Z"),
      onTest,
      alerts: {
        status: "live",
        channels: { telegram: true, slack: true },
        invalidSettings: [],
        intervalMs: 60_000,
        watcher: { lastRunAt: "2026-10-19T11:59:40.000Z", lastOkAt: "2026-10-19T11:59:40.000Z", lastError: null, stale: false },
        alerts: [],
      },
    })
    await act(() =>
      root.render(
        React.createElement(
          AlertsCard,
          props(
            () =>
              new Promise((resolve) => {
                answer = () => resolve({ telegram: { ok: true, at: "" }, slack: { ok: false, at: "", error: "Slack answered 404: no_service" } })
              }),
          ),
        ),
      ),
    )
    assert.match(doc.body.textContent ?? "", /Sends to Telegram and Slack/)
    await act(() => button(doc, "Send test alert").click())
    assert.equal(button(doc, "Sending…").disabled, true)
    await act(() => answer())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /Telegram: sent · Slack: failed \(Slack answered 404: no_service\)/)

    // A refused send (e.g. the 30-second cooldown) shows the server's reason.
    await act(() => root.render(React.createElement(AlertsCard, props(async () => Promise.reject(new Error("Wait 30 seconds between test alerts"))))))
    await act(() => button(doc, "Send test alert").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /Wait 30 seconds between test alerts/)
  })
})
