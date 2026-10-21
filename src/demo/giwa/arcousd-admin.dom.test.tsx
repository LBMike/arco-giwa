// Admin · ArcoUSD processQueue control in React DOM: Preview → Sign & send (with the confirming
// step) and a refused preview. (The fund-buy pay asset is picked in the Savings token picker:
// fund-pay-picker.dom.test.tsx.)
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

test("distribute control: preview, sign & send, then spent; a reverting dry run cannot be sent (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { DistributeControl } = (await import("./AdminArcoUSD")) as AnyModule
    const transaction = { chainId: 91342, to: "0x0000000000000000000000000000000000000052", value: "0x0", data: "0xe4fc6b6d", description: "distribute" }
    const replies = [
      { transaction, preview: { amountUsd: "5.25", blockNumber: "901" } },
      { transaction, preview: { error: "distribute() would revert or could not be simulated: TooSoon()" } },
    ]
    const calls: string[] = []
    let finishConfirm: () => void = () => undefined
    const handlers = {
      walletAddress: "0x00000000000000000000000000000000000000ee",
      onConnectWallet: () => undefined,
      onPrepare: async () => {
        calls.push("prepare")
        return replies.shift()
      },
      onSend: (_sent: unknown, onSigned: (hash: string) => void) =>
        new Promise<string>((resolve) => {
          calls.push("send")
          onSigned(`0x${"cd".repeat(32)}`)
          finishConfirm = () => resolve(`0x${"cd".repeat(32)}`)
        }),
    }
    const render = (stateKey: string) => root.render(React.createElement(DistributeControl, { ...handlers, stateKey }))
    await act(() => render("2026-10-20T11:00:00.000Z"))
    assert.equal(button(doc, "Sign & send").disabled, true)
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /Would mint \$5\.25 into sArcoUSD now \(block 901\)\./)
    await act(() => button(doc, "Sign & send").click())
    assert.ok(button(doc, "Confirming…").disabled)
    await act(() => finishConfirm())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /Sent\. View transaction Refreshing the distributor…/)
    assert.equal(button(doc, "Sign & send").disabled, true)
    // The cached state still shows the old distribution: Preview waits until it changes.
    assert.equal(button(doc, "Preview").disabled, true)
    await act(() => render("2026-10-21T12:00:00.000Z"))
    assert.equal(button(doc, "Preview").disabled, false)

    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /TooSoon\(\)/)
    assert.equal(button(doc, "Sign & send").disabled, true)
    assert.deepEqual(calls, ["prepare", "send", "prepare"])
  })
})

// ── Buffer top-up (Overview › Fund buy gate) ──────────────────────────────

const TOP_UP_OPERATOR = "0x00000000000000000000000000000000000000ee"
const topUpReserve = {
  status: "live",
  gate: { status: "closed", reason: "insufficient-buffer", asset: "tUSDC", available: "1", threshold: "1000", checkedAt: "2026-10-20T09:00:00Z" },
  reserve: {
    mintCap: "10000000000000000000000000", // 10M ArcoUSD
    totalLiabilities: "1000000000000000000",
    assets: [
      { symbol: "tUSDT", decimals: 6, depositEnabled: true, balanceHuman: "0", queuedHuman: "0" },
      { symbol: "tUSDC", decimals: 6, depositEnabled: true, balanceHuman: "1", queuedHuman: "0" },
      { symbol: "tRLUSD", decimals: 18, depositEnabled: false, balanceHuman: "0", queuedHuman: "0" },
    ],
  },
}
const tx = (description: string) => ({ chainId: 91342, to: "0x00000000000000000000000000000000000000e5", value: "0x0", data: "0x", description })
const topUp = (overrides: Record<string, unknown> = {}) => ({
  symbol: "tUSDC",
  asset: "0x00000000000000000000000000000000000000C1",
  decimals: 6,
  amount: "1000000000",
  amountHuman: "1000",
  from: TOP_UP_OPERATOR,
  balanceHuman: "1000",
  needsApproval: false,
  transactions: [tx("deposit")],
  preview: { arcoUSDOutHuman: "1000", blockNumber: "61" },
  ...overrides,
})

async function typeInto(act: (fn: () => unknown) => Promise<void>, input: HTMLInputElement, value: string) {
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
}

test("buffer top-up: approve, check again, then deposit from the operator wallet (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { BufferTopUpControl } = (await import("./AdminArcoUSD")) as AnyModule
    const calls: string[] = []
    const approveFirst = topUp({ needsApproval: true, transactions: [tx("approve"), tx("deposit")], preview: { afterApproval: true } })
    const approved = topUp()
    let prepares = 0
    const onPrepare = async (asset: string, amount: string) => {
      calls.push(`prepare:${asset}:${amount}`)
      prepares += 1
      // The first read after the approval still trails: the control asks again.
      return prepares === 1 ? approveFirst : prepares === 2 ? approveFirst : approved
    }
    const onSend = async (sent: { description: string }, onSigned: (hash: string) => void) => {
      calls.push(`send:${sent.description}`)
      onSigned(`0x${(sent.description === "approve" ? "aa" : "bb").repeat(32)}`)
      return "0x"
    }
    await act(() =>
      root.render(
        React.createElement(BufferTopUpControl, {
          reserve: topUpReserve,
          walletAddress: TOP_UP_OPERATOR,
          onConnectWallet: () => undefined,
          onPrepare,
          onSend,
          wait: async () => undefined,
        }),
      ),
    )
    // The gate's asset comes first; an asset with deposits off is not offered.
    const select = doc.querySelector("select") as HTMLSelectElement
    assert.deepEqual([...select.options].map((option) => option.value), ["tUSDC", "tUSDT"])
    const input = doc.querySelector("input") as HTMLInputElement
    assert.equal(button(doc, "Preview").disabled, true)
    await typeInto(act, input, "1000.1234567") // more decimals than tUSDC has
    assert.equal(button(doc, "Preview").disabled, true)
    await typeInto(act, input, "1000")
    await act(() => button(doc, "Preview").click())
    await act(tick)
    const shown = doc.body.textContent ?? ""
    assert.match(shown, /holds 1,000 tUSDC\. Two signatures: approve 1,000 tUSDC, then the deposit\./)
    assert.match(shown, /The deposit is checked again once the approval confirms\./)
    assert.match(shown, /Buffer after: \$1,001 · Reaches the threshold: the gate opens on the next reserve read/)
    await act(() => button(doc, "Approve & deposit").click())
    await act(tick)
    assert.deepEqual(calls, ["prepare:tUSDC:1000", "send:approve", "prepare:tUSDC:1000", "prepare:tUSDC:1000", "send:deposit"])
    assert.match(doc.body.textContent ?? "", /Deposited\. The gate updates on the next reserve read\. View approval View deposit/)
    assert.equal(input.value, "")
  })
})

test("buffer top-up: the signer wallet is refused, another connected wallet cannot sign, a failed dry run cannot be sent", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { BufferTopUpControl } = (await import("./AdminArcoUSD")) as AnyModule
    let reply: () => Promise<unknown> = async () => {
      throw new Error("This wallet is the Stocks signer. A transaction from it moves the nonce the signer keeps and stops Stocks until its journal is re-seeded. Sign in with another operator wallet.")
    }
    const sent: string[] = []
    const render = (walletAddress: string) =>
      act(() =>
        root.render(
          React.createElement(BufferTopUpControl, {
            reserve: topUpReserve,
            walletAddress,
            onConnectWallet: () => undefined,
            onPrepare: () => reply(),
            onSend: async (transaction: { description: string }) => (sent.push(transaction.description), "0x"),
            wait: async () => undefined,
          }),
        ),
      )
    await render(TOP_UP_OPERATOR)
    await typeInto(act, doc.querySelector("input") as HTMLInputElement, "500")
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /This wallet is the Stocks signer/)
    assert.equal(button(doc, "Sign & send").disabled, true)

    // Prepared for the signed-in operator, but another wallet is connected.
    reply = async () => topUp({ amount: "500000000", amountHuman: "500" })
    await render("0x00000000000000000000000000000000000000f0")
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /The connected wallet is not the signed-in operator wallet 0x0000…00ee\. Switch to it to sign\./)
    assert.match(doc.body.textContent ?? "", /Still \$499 below the threshold/)
    assert.equal(button(doc, "Sign & send").disabled, true)

    // A deposit that would revert is shown and cannot be sent.
    reply = async () => topUp({ preview: { error: "deposit would revert or could not be simulated: FP: fn paused" } })
    await render(TOP_UP_OPERATOR)
    await act(() => button(doc, "Preview").click())
    await act(tick)
    assert.match(doc.body.textContent ?? "", /FP: fn paused/)
    assert.equal(button(doc, "Sign & send").disabled, true)
    assert.deepEqual(sent, [])
  })
})

test("buffer top-up: a failed check after the approval says the approval landed and to preview again", { skip: !runtime }, async () => {
  await withDom(async ({ doc, React, root, act }) => {
    const { BufferTopUpControl } = (await import("./AdminArcoUSD")) as AnyModule
    const sent: string[] = []
    let prepares = 0
    await act(() =>
      root.render(
        React.createElement(BufferTopUpControl, {
          reserve: topUpReserve,
          walletAddress: TOP_UP_OPERATOR,
          onConnectWallet: () => undefined,
          onPrepare: async () => {
            prepares += 1
            if (prepares === 1) return topUp({ needsApproval: true, transactions: [tx("approve"), tx("deposit")], preview: { afterApproval: true } })
            throw new Error("Could not read the wallet's tUSDC: rpc down")
          },
          onSend: async (transaction: { description: string }, onSigned: (hash: string) => void) => {
            sent.push(transaction.description)
            onSigned(`0x${"aa".repeat(32)}`)
            return "0x"
          },
          wait: async () => undefined,
        }),
      ),
    )
    await typeInto(act, doc.querySelector("input") as HTMLInputElement, "1000")
    await act(() => button(doc, "Preview").click())
    await act(tick)
    await act(() => button(doc, "Approve & deposit").click())
    await act(tick)
    assert.deepEqual(sent, ["approve"]) // no deposit without a fresh check
    assert.equal(prepares, 4) // the first preview, then three checks after the approval
    assert.match(
      doc.body.textContent ?? "",
      /Approval confirmed, but the deposit could not be prepared \(Could not read the wallet's tUSDC: rpc down\)\. Preview again to deposit\. View approval/,
    )
  })
})
