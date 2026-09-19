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
      assert.ok(!firstCommit("wallet B").includes(KEPT_NOTICE), "B is not told about A's kept hash, from the first commit")
      const text = element.textContent ?? ""
      assert.ok(!text.includes(KEPT_NOTICE), "B is not told about A's kept hash")
      // B signed in (a live session for another owner) with A's order row on screen: still nothing of A's.
      await signIn()
      await hidden("B signed in with A's order row", {})
      assert.ok(!firstCommit("B signed in with A's order row").includes(KEPT_NOTICE))
      await act(async () => {
        host!.logout()
        await sleep(0)
      })
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

// UI review G3 K1/K2: the recovery card through the real providers, operated from the keyboard only. One always-mounted
// polite status region carries each result (a repeated identical failure is announced again, the busy label never);
// when a result removes the card's button, focus lands on the card itself (a non-interactive div), never on a button
// and never on <body>; a card that mounts after an interaction does not take focus from the view.
test("keyboard recovery: the result is announced and focus stays on the card when its button goes (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
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
  // Unmounted in finally too: a failed assertion must not leave the host provider (and its timers) running.
  let unmount: (() => Promise<void>) | null = null
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { StocksHostProvider, useGiwaStocksHost } = (await import("../stocks-host/StocksHostProvider")) as AnyModule
    const { StocksExecutionProvider, StocksOrderExecution } = (await import("./StocksExecutionProvider")) as AnyModule
    const { UserInteractionContext } = (await import("../stocks-investor/ui")) as AnyModule
    const { getAddress } = (await import("viem")) as AnyModule
    const { act, createElement: h, StrictMode, useRef } = React

    const A = getAddress("0x000000000000000000000000000000000000a0d2")
    const HASH = `0x${"6".repeat(64)}`
    harness.seedCash(A, 1_000_000_000n)
    const accepted = await harness.createOrder("BUY", harness.session(A))
    const order = accepted.order as AnyModule
    const store = createKnownHashStore()
    // A test-only binding the server's request does not match, so the last explicit check blocks it (no action left).
    assert.ok(store.remember({ claimId: "kept-keyboard", intentKey: "c".repeat(64), stage: "TRANSFER", transactionDigest: "e".repeat(64), side: "BUY", orderId: order.id, deploymentDigest: order.deploymentDigest, wallet: A, chainId: 91342, apiBase: harness.apiBase, origin: HARNESS_FRONTEND_ORIGIN, txHash: HASH }))
    const wallet = createFakeEip1193Wallet(harness.chain, { account: A })
    const source = { mode: "injected", provider: wallet }
    // The next N recovery inspects are lost before they reach the server.
    const lose = { inspects: 0 }
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (lose.inspects > 0 && (init?.method ?? "GET") === "GET" && /\/wallet-submissions\//.test(String(input))) {
        lose.inspects--
        throw new TypeError("network connection lost")
      }
      return harness.fetch(input, init)
    }) as typeof globalThis.fetch
    const clock = { now: () => Date.now(), monotonicNow: () => performance.now() }
    let host: AnyModule | null = null
    const element = document.createElement("div")
    document.body.append(element)
    const root = createRoot(element)
    unmount = async () => {
      unmount = null
      await act(async () => root.unmount())
      element.remove()
    }
    function Capture() {
      host = useGiwaStocksHost()
      return null
    }
    // Like the investor feature root: any key or pointer press inside marks the user interaction.
    function Feature() {
      const interacted = useRef(false)
      const mark = () => {
        interacted.current = true
      }
      return h(UserInteractionContext.Provider, { value: interacted }, h("section", { "data-testid": "feature", onKeyDownCapture: mark, onPointerDownCapture: mark }, h(Capture), h(StocksOrderExecution, { order: { ...order, side: "BUY", state: "BROKER_PENDING" }, observedAt: new Date().toISOString(), refreshing: false, onRefresh: () => undefined })))
    }
    await act(async () => {
      root.render(
        h(StrictMode, null,
          h(StocksHostProvider, { context: { walletAddress: A, chainId: 91342, frontendOrigin: harness.frontendOrigin, apiBase: harness.apiBase, walletEpoch: "injected:a:keyboard" }, dependencies: harness.signInDependencies(), walletSource: source },
            h(StocksExecutionProvider, { apiBase: harness.apiBase, fetch, clock, activeSource: () => source, knownHashes: store, origin: HARNESS_FRONTEND_ORIGIN }, h(Feature)))),
      )
      await sleep(0)
    })
    const card = () => element.querySelector<HTMLElement>('[data-testid="stocks-known-hash-recovery"]')
    const region = () => card()?.querySelector('[data-testid="stocks-known-hash-announcement"]') ?? null
    const button = () => card()?.querySelector<HTMLButtonElement>('button[data-action="record-known-hash"]') ?? null
    // Element identity is compared with assert.ok: a failing assert.equal would inspect whole jsdom element graphs.
    const focused = () => {
      const active = document.activeElement
      return active === null ? "nothing" : `${active.tagName}[${active.getAttribute("data-testid") ?? ""}] "${(active.textContent ?? "").slice(0, 40)}"`
    }
    const waitFor = async (predicate: () => boolean, label: string) => {
      for (let i = 0; i < 300 && !predicate(); i++) await act(async () => sleep(10))
      assert.ok(predicate(), `${label} (card ${card()?.dataset.state ?? "none"}: ${region()?.textContent ?? ""})`)
    }

    // An interaction happened (a key press inside the feature) and focus is on <body> when the card mounts after sign-in:
    // the card does not take focus on mount (the view's own heading keeps that rescue).
    element.querySelector("section")!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    assert.ok(document.activeElement === document.body, `focus on ${focused()}`)
    await act(async () => {
      await host!.signIn()
    })
    await waitFor(() => card() !== null, "recovery card after sign-in")
    await act(async () => sleep(20))
    assert.ok(document.activeElement === document.body, `a card that mounts does not take focus (focus on ${focused()})`)

    // The region is mounted, polite and empty before the first action.
    assert.ok(region(), "status region before the first action")
    assert.deepEqual([region()!.getAttribute("role"), region()!.getAttribute("aria-live"), region()!.getAttribute("aria-atomic"), region()!.textContent], ["status", "polite", "true", ""])
    const said: string[] = []
    const observer = new w.MutationObserver(() => said.push(region()?.textContent ?? ""))
    observer.observe(element, { subtree: true, childList: true, characterData: true })

    /** A browser turns Enter/Space on a focused button into a click; jsdom does not, so the click is dispatched. */
    const press = async (target: HTMLButtonElement, key: string) => {
      target.focus()
      assert.ok(document.activeElement === target, `focus on ${focused()}`)
      await act(async () => {
        target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
        target.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
        target.dispatchEvent(new w.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
        await sleep(0)
      })
    }
    const requestsBefore = harness.requests.length

    // 1. "Record this hash" with Enter; the inspect is lost: KEPT + FAILED is announced.
    assert.equal(button()?.textContent, "Record this hash")
    lose.inspects = 1
    await press(button()!, "Enter")
    await waitFor(() => button()?.textContent === "Check again" && !button()!.disabled, "Check again")
    const once = region()!.textContent ?? ""
    assert.ok(once.startsWith("Check finished. Your wallet returned this deposit transaction hash"), once)
    assert.ok(once.includes("so it may or may not have recorded the hash. This did not open your wallet."), once)
    assert.ok(card()!.contains(document.activeElement), "focus stays in the card while its button exists")

    // 2. "Check again" with Space; the same failure again is announced again (the region text changes).
    lose.inspects = 1
    await press(button()!, " ")
    await waitFor(() => button()?.textContent === "Check again" && !button()!.disabled && (region()!.textContent ?? "") !== "", "Check again, second result")
    const twice = region()!.textContent ?? ""
    assert.notEqual(twice, once, "a repeated identical result changes the region text")
    assert.equal(twice.trimEnd(), once.trimEnd())
    const submissions = () => harness.requests.slice(requestsBefore).filter((request) => /\/wallet-submissions\//.test(request.path))
    assert.deepEqual(submissions(), [], "the lost inspects never reached the server")

    // 3. "Check again" with Enter; the server's request does not match this test-only binding: BLOCKED, the button is
    // gone. Focus lands on the card itself (tabIndex -1), not on <body> and not on any button.
    await press(button()!, "Enter")
    await waitFor(() => card()?.dataset.state?.startsWith("BLOCKED_") === true, "blocked")
    await act(async () => sleep(20))
    assert.ok(button() === null, "no action left")
    assert.ok(document.activeElement === card(), `focus rescued onto the card (focus on ${focused()})`)
    assert.equal(document.activeElement?.tagName, "DIV")
    assert.equal(card()!.tabIndex, -1)
    assert.equal(card()!.querySelectorAll("button, a, [role=button]").length, 0)
    assert.equal((region()!.textContent ?? "").trimEnd(), "Check finished. The server's request for this order does not match this hash, so nothing was recorded.")
    assert.deepEqual(submissions().map((request) => request.method), ["GET"], "one inspect; the focus change adds no request")
    assert.equal(harness.requests.slice(requestsBefore).filter((request) => request.method !== "GET").length, 0, "no write of any kind")
    assert.equal(wallet.calls.length, 0, "no wallet call of any kind")
    observer.disconnect()
    assert.ok(said.every((text) => !text.includes("Checking with the server") && !text.includes(HASH)), JSON.stringify(said))

    await unmount()
  } finally {
    if (unmount) await unmount().catch(() => undefined)
    await harness.close()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
