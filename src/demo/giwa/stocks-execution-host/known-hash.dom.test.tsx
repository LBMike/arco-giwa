// Kept-hash visibility at the FIRST commit of every scope change, in React DOM + StrictMode, with the real host
// provider (fixture sign-in against the in-process server), the real execution provider, order slot and session notice.
// The kept entries are placed in the store directly (their capture is covered by stocks-known-hash-recovery tests and
// page.dom.test.tsx); this file checks only who may see them, on which order, from the first commit on.
//
// Gated like page.dom.test.tsx: set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const KEPT_NOTICE = "This tab kept a transaction hash the server may not have recorded"

test("kept hashes are shown only to their owner on their order, from the first commit (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async (t) => {
  const { createInProcessStocks, HARNESS_FRONTEND_ORIGIN } = (await import("./testing/in-process-stocks")) as typeof import("./testing/in-process-stocks")
  const { createFakeEip1193Wallet } = (await import("./testing/fake-wallet")) as typeof import("./testing/fake-wallet")
  const { createKnownHashStore } = (await import("../stocks-known-hash-recovery/store")) as typeof import("../stocks-known-hash-recovery/store")
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: HARNESS_FRONTEND_ORIGIN, pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const harness = await createInProcessStocks()
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { StocksHostProvider, useGiwaStocksHost } = (await import("../stocks-host/StocksHostProvider")) as AnyModule
    const { StocksExecutionProvider, StocksOrderExecution, StocksExecutionSessionNotice } = (await import("./StocksExecutionProvider")) as AnyModule
    const { getAddress } = (await import("viem")) as AnyModule
    const { act, createElement: h, StrictMode, useLayoutEffect } = React

    const A = getAddress("0x000000000000000000000000000000000000a0d1")
    const B = getAddress("0x000000000000000000000000000000000000b0d1")
    const HASH = `0x${"4".repeat(64)}`
    const OTHER_HASH = `0x${"5".repeat(64)}`
    harness.seedCash(A, 1_000_000_000n)
    const session = harness.session(A)
    const accepted = await harness.createOrder("BUY", session)
    const order = accepted.order as AnyModule
    const store = createKnownHashStore()
    const kept = (overrides: Record<string, unknown>) => ({ claimId: "kept-1", intentKey: "a".repeat(64), stage: "TRANSFER", transactionDigest: "b".repeat(64), side: "BUY", orderId: order.id, deploymentDigest: order.deploymentDigest, wallet: A, chainId: 91342, apiBase: harness.apiBase, origin: HARNESS_FRONTEND_ORIGIN, txHash: HASH, ...overrides })
    assert.ok(store.remember(kept({})))
    // A kept hash of the same wallet for ANOTHER order must never appear on this order.
    assert.ok(store.remember(kept({ claimId: "kept-other-order", orderId: "another-order", txHash: OTHER_HASH })))

    const walletA = createFakeEip1193Wallet(harness.chain, { account: A })
    const walletB = createFakeEip1193Wallet(harness.chain, { account: B })
    let view = { address: A as string, chainId: 91342, epoch: "injected:a:1", source: { mode: "injected", provider: walletA } as AnyModule, apiBase: harness.apiBase as string, origin: HARNESS_FRONTEND_ORIGIN, row: { ...order, side: "BUY", state: "BROKER_PENDING" } as AnyModule }
    const clock = { now: () => Date.now(), monotonicNow: () => performance.now() }
    // Holds the recovery's inspect when asked, to act while it is in flight.
    const inspectGate: { hold: Promise<void> | null } = { hold: null }
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (inspectGate.hold && (init?.method ?? "GET") === "GET" && /\/wallet-submissions\//.test(String(input))) await inspectGate.hold
      return harness.fetch(input, init)
    }) as typeof globalThis.fetch
    let showSlot = true
    const dependencies = harness.signInDependencies()
    let host: AnyModule | null = null
    let phase = "initial"
    const commits: { phase: string; text: string }[] = []
    const element = document.createElement("div")
    document.body.append(element)
    const root = createRoot(element)
    function Capture() {
      host = useGiwaStocksHost()
      return null
    }
    function Content() {
      useLayoutEffect(() => {
        commits.push({ phase, text: element.textContent ?? "" })
      })
      return h("div", null, h(Capture), h(StocksExecutionSessionNotice), showSlot ? h(StocksOrderExecution, { order: view.row, observedAt: new Date().toISOString(), refreshing: false, onRefresh: () => undefined }) : null)
    }
    const tree = () =>
      h(StrictMode, null,
        h(StocksHostProvider, { context: { walletAddress: view.address, chainId: view.chainId, frontendOrigin: harness.frontendOrigin, apiBase: harness.apiBase, walletEpoch: view.epoch }, dependencies, walletSource: view.source },
          h(StocksExecutionProvider, { apiBase: view.apiBase, fetch, clock, activeSource: () => view.source, knownHashes: store, origin: view.origin }, h(Content))))
    const render = async (next: Partial<typeof view>, label: string) => {
      view = { ...view, ...next }
      phase = label
      await act(async () => {
        root.render(tree())
        await sleep(0)
      })
    }
    const firstCommit = (label: string) => {
      const first = commits.find((commit) => commit.phase === label)
      assert.ok(first, `a commit for ${label}`)
      return first.text
    }
    const card = () => element.querySelector('[data-testid="stocks-known-hash-recovery"]')
    const panel = () => element.querySelector('[data-testid="stocks-wallet-panel"]')
    const signIn = async () => {
      await act(async () => {
        await host!.signIn()
      })
      for (let i = 0; i < 200 && !host!.snapshot.session; i++) await act(async () => sleep(10))
      assert.ok(host!.snapshot.session, "signed in")
    }

    await t.test("signed out: the owner's wallet sees the kept-hash notice (no order or hash); nothing else", async () => {
      await render({}, "signed-out-A")
      const text = element.textContent ?? ""
      assert.ok(text.includes(KEPT_NOTICE), text)
      assert.ok(!text.includes(HASH) && !text.includes(order.id) && !text.includes(OTHER_HASH))
      assert.ok(card() === null && panel() === null)
    })

    await t.test("signed in as the owner: the recovery card for THIS order only; a moved-on, unpinned order gets no execution panel", async () => {
      await signIn()
      phase = "signed-in-A"
      await render({}, "signed-in-A")
      assert.ok(card() !== null, "recovery card")
      const text = element.textContent ?? ""
      assert.ok(text.includes(HASH), "the owner's own kept hash")
      assert.ok(!text.includes(OTHER_HASH), "another order's kept hash never shows here")
      assert.ok(panel() === null, "not payable and not pinned: no execution panel")
      assert.ok(!text.includes(KEPT_NOTICE), "no signed-out notice while signed in")
      assert.equal(walletA.calls.length, 0, "rendering sends and reads nothing from the wallet")
    })

    await t.test("a card that unmounts while its recovery is in flight neither reports nor stores the answer", async () => {
      let release!: () => void
      inspectGate.hold = new Promise<void>((resolve) => { release = resolve })
      const requests = harness.requests.length
      const button = card()!.querySelector<HTMLButtonElement>('button[data-action="record-known-hash"]')!
      await act(async () => {
        button.click()
        await sleep(0)
      })
      assert.equal(store.get("kept-1")?.busy, true)
      showSlot = false
      await render({}, "slot-hidden")
      await act(async () => {
        release()
        inspectGate.hold = null
        await sleep(50)
      })
      for (let i = 0; i < 100 && store.get("kept-1")?.busy; i++) await act(async () => sleep(10))
      // The server answer (no claim for this test-only binding) would block the hash; after the unmount nothing is stored.
      assert.deepEqual([store.get("kept-1")?.state.kind, store.get("kept-1")?.busy], ["KEPT", false])
      assert.equal(harness.requests.filter((request) => request.method === "POST").length, harness.requests.slice(0, requests).filter((request) => request.method === "POST").length, "no outcome or reconcile")
      showSlot = true
      await render({}, "slot-back")
      assert.ok(card() !== null)
      assert.equal(card()!.getAttribute("data-state"), "KEPT")
    })

    const hidden = async (label: string, next: Partial<typeof view>) => {
      await render(next, label)
      const first = firstCommit(label)
      assert.ok(!first.includes(HASH), `${label}: no kept hash on the first commit`)
      assert.ok(!first.includes(OTHER_HASH))
      assert.ok(card() === null, `${label}: no recovery card`)
    }

    await t.test("the first commit after each scope change never shows the kept hash", async () => {
      await hidden("other deployment on the row", { row: { ...view.row, deploymentDigest: "e".repeat(64) } })
      await render({ row: { ...order, side: "BUY", state: "BROKER_PENDING" } }, "back-to-row")
      assert.ok(card() !== null)
      await hidden("other frontend origin", { origin: "https://other-app.example.test" })
      await render({ origin: HARNESS_FRONTEND_ORIGIN }, "origin-back")
      assert.ok(card() !== null)
      await hidden("other API base", { apiBase: "https://other-api.example.test" })
      await render({ apiBase: harness.apiBase }, "api-back")
      assert.ok(card() !== null)
      await hidden("other chain", { chainId: 1 })
      const otherChain = element.textContent ?? ""
      assert.ok(otherChain.includes(KEPT_NOTICE), "another network keeps the kept-hash notice (not the no-hash wording)")
      assert.ok(!otherChain.includes("A wallet request from your last Stocks session"))
      await hidden("wallet B", { chainId: 91342, address: B, epoch: "injected:b:1", source: { mode: "injected", provider: walletB } })
      const text = element.textContent ?? ""
      assert.ok(!text.includes(KEPT_NOTICE), "B is not told about A's kept hash")
      assert.equal(walletB.calls.length, 0)
      // Back to A (signed out after the wallet change): the notice again, still without order or hash.
      await render({ address: A, epoch: "injected:a:2", source: { mode: "injected", provider: walletA } }, "back-to-A")
      const back = element.textContent ?? ""
      assert.ok(back.includes(KEPT_NOTICE), back)
      assert.ok(!back.includes(HASH))
    })

    await t.test("a verified hash no longer raises the signed-out notice", async () => {
      assert.ok(store.settle("kept-1", HASH, { kind: "VERIFIED", status: "CONFIRMED" }))
      assert.ok(store.settle("kept-other-order", OTHER_HASH, { kind: "VERIFIED", status: "CONFIRMED" }))
      await render({}, "all-verified")
      const text = element.textContent ?? ""
      assert.ok(!text.includes(KEPT_NOTICE), text)
    })

    await act(async () => root.unmount())
    element.remove()
  } finally {
    await harness.close()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
