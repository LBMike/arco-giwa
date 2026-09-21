import assert from "node:assert/strict"
import test from "node:test"
import { createRequire, registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { act, StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { parseSiweMessage } from "viem/siwe"
import { StocksHostProvider, useGiwaStocksHost, type StocksHostValue } from "./StocksHostProvider"
import { StocksSignIn } from "./StocksSignIn"
import type { HostContext, HostDependencies, HostSnapshot } from "./session"

// No dependency added: opt into the already-installed DOM runtime for this integration gate.
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
const SIG = `0x${"11".repeat(65)}`
const START = Date.UTC(2026, 8, 17)
const initial: HostContext = { walletAddress: A, chainId: 91342, frontendOrigin: "https://app.example:8443", apiBase: "https://api.example", walletEpoch: "injected:0" }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function fixture() {
  let now = START; let seq = 0
  const timers = new Map<number, () => void>()
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = []
  let intercept: ((url: string, normal: Response) => Promise<Response>) | undefined
  const dependencies: HostDependencies = {
    now: () => now,
    setTimer: cb => { timers.set(++seq, cb); return seq }, clearTimer: id => { timers.delete(id as number) },
    signMessage: async () => SIG,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, signal: init.signal })
      const body = JSON.parse(String(init.body))
      const message = body.message ? parseSiweMessage(body.message) : null
      const claims = { sub: message?.address, domain: message?.domain, chainId: 91342, iat: now / 1000, exp: now / 1000 + 900 }
      const token = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`
      const normal = url.endsWith("/nonce")
        ? Response.json({ walletAddress: body.walletAddress, domain: body.domain, nonce: "abcdefgh12345678", expiresAt: new Date(now + 60_000).toISOString() })
        : Response.json({ walletAddress: message?.address, chainId: 91342, expiresIn: 900, token })
      return intercept ? intercept(url, normal) : normal
    }) as typeof fetch,
  }
  return { dependencies, timers, calls, setTime(value: number) { now = value }, intercept(fn: typeof intercept) { intercept = fn } }
}

test("host DOM integration (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: initial.frontendOrigin, pretendToBeVisual: true })
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  async function mount(f = fixture(), strict = true) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    let host!: StocksHostValue
    const reads: { expected: string | null; actual: string | null; id: string | null }[] = []
    let context = initial
    function Probe() { host = useGiwaStocksHost(); reads.push({ expected: context.walletAddress, actual: host.snapshot.session?.walletAddress.toLowerCase() ?? null, id: host.snapshot.session?.id ?? null }); return <StocksSignIn /> }
    async function render(next = initial, signingReady = true, child?: ReactNode) {
      context = next
      const tree = <StocksHostProvider context={context} dependencies={f.dependencies} signingReady={signingReady}>{child ?? <Probe />}</StocksHostProvider>
      await act(async () => { root.render(strict ? <StrictMode>{tree}</StrictMode> : tree); await flush() })
    }
    await render()
    return { f, element, reads, get host() { return host }, render, async unmount() { await act(async () => root.unmount()); element.remove(); assert.equal(f.timers.size, 0) } }
  }

  await t.test("StrictMode creates a fresh usable controller; explicit button, logout and cleanup", async () => {
    const m = await mount()
    assert.equal(m.f.calls.length, 0)
    assert.equal(m.host.snapshot.session, null)
    await act(async () => { (m.element.querySelector("button") as HTMLButtonElement).click(); await flush() })
    assert.equal(m.f.calls.length, 2)
    assert.equal(m.host.snapshot.status, "authenticated")
    assert.ok(m.element.querySelector('[role="status"]')?.textContent?.includes("Signed in"))
    assert.ok(!m.element.textContent?.includes("e30."))
    await act(async () => m.host.logout())
    assert.equal(m.host.snapshot.session, null)
    assert.equal(m.f.timers.size, 0)
    await m.unmount()
  })

  await t.test("every render is fenced on wallet, chain, API, origin, signer epoch and readiness changes", async () => {
    const m = await mount()
    const changes = [{ walletAddress: B }, { chainId: 1 }, { apiBase: "https://other-api.example" }, { frontendOrigin: "https://other.example" }, { walletEpoch: "dynamic:1" }]
    for (const delta of changes) {
      await m.render(initial)
      await act(async () => { await m.host.signIn() })
      assert.ok(m.host.snapshot.session)
      const before = m.reads.length
      await m.render({ ...initial, ...delta })
      assert.ok(m.reads.slice(before).every(read => read.actual === null), JSON.stringify(delta))
      assert.equal(m.host.snapshot.session, null)
    }
    await m.render(initial)
    await act(async () => { await m.host.signIn() })
    const before = m.reads.length
    await m.render(initial, false)
    assert.ok(m.reads.slice(before).every(read => read.actual === null))
    assert.equal(m.host.canSignIn, false)
    await m.unmount()
  })

  for (const boundary of ["nonce", "verify"]) await t.test(`A→B→A fences a late ${boundary} success and 401`, async () => {
    for (const status of [200, 401]) {
      const f = fixture(); const pending = deferred<Response>(); let captured!: Response
      f.intercept(async (url, normal) => { if (url.endsWith(`/${boundary}`)) { captured = normal; return pending.promise } return normal })
      const m = await mount(f)
      let attempt!: Promise<void>
      await act(async () => { attempt = m.host.signIn(); await flush() })
      await m.render({ ...initial, walletAddress: B, walletEpoch: "injected:1" })
      await m.render({ ...initial, walletEpoch: "injected:2" })
      f.intercept(undefined)
      await act(async () => { await m.host.signIn() })
      const id = m.host.snapshot.session?.id
      assert.ok(id)
      await act(async () => { pending.resolve(status === 200 ? captured : new Response("private-provider-error", { status })); await attempt; await flush() })
      assert.equal(m.host.snapshot.session?.id, id)
      assert.ok(m.reads.every(read => !read.actual || read.actual === read.expected))
      assert.ok(!m.element.textContent?.includes("private-provider-error"))
      await m.unmount()
    }
  })

  await t.test("expiry read, visibility refresh and captured 401 cannot expose or replace sessions", async () => {
    const m = await mount()
    await act(async () => { await m.host.signIn() })
    const old = m.host.snapshot.session!
    await act(async () => { await m.host.signIn() })
    const next = m.host.snapshot.session!
    await act(async () => m.host.invalidate(old.id))
    assert.equal(m.host.snapshot.session?.id, next.id)
    m.f.setTime(next.expiresAt)
    const before = m.reads.length
    await m.render(initial)
    assert.ok(m.reads.slice(before).every(read => read.actual === null))
    await act(async () => { window.dispatchEvent(new dom.window.Event("pageshow")); document.dispatchEvent(new dom.window.Event("visibilitychange")) })
    assert.equal(m.f.timers.size, 0)
    assert.equal(m.f.calls.length, 4, "expiry must not silently sign in")
    await m.unmount()
  })

  await t.test("route navigation shares one login; owner remount/refresh loses it", async () => {
    const m = await mount()
    let host!: StocksHostValue; let navigate!: ReturnType<typeof useNavigate>
    function RouteProbe() { host = useGiwaStocksHost(); navigate = useNavigate(); return <span>{useLocation().pathname}</span> }
    const child = <MemoryRouter initialEntries={["/"]}><RouteProbe /></MemoryRouter>
    await m.render(initial, true, child)
    await act(async () => { await host.signIn() })
    const id = host.snapshot.session?.id
    await act(async () => navigate("/admin/operations"))
    assert.equal(host.snapshot.session?.id, id)
    await act(async () => navigate("/savings"))
    assert.equal(host.snapshot.session?.id, id)
    assert.equal(m.f.calls.length, 2)
    await m.unmount()
    const refreshed = await mount()
    assert.equal(refreshed.host.snapshot.session, null)
    assert.equal(refreshed.f.calls.length, 0)
    await refreshed.unmount()
  })

  await t.test("failure retry and invalid context remain accessible and expose no credentials", async () => {
    const f = fixture(); f.intercept(async () => { throw new Error("token=private") })
    const m = await mount(f)
    await act(async () => { await m.host.signIn() })
    assert.ok(m.element.textContent?.includes("Retry Stocks sign-in"))
    assert.ok(!m.element.textContent?.includes("private"))
    f.intercept(undefined)
    await act(async () => { await m.host.signIn() })
    assert.ok(m.host.snapshot.session)
    await m.render({ ...initial, apiBase: "https://private:secret@api.example" })
    assert.equal(m.host.snapshot.session, null)
    assert.ok(!m.element.textContent?.includes("secret"))
    await m.unmount()
  })

  const UNAVAILABLE_COPY = "Stocks sign-in is not available on this page. Reload the page; if this continues, contact operations."
  const section = (m: { element: HTMLElement }) => m.element.querySelector('section[aria-label="Stocks sign-in"]') as HTMLElement
  const statusText = (m: { element: HTMLElement }) => section(m).querySelector('[role="status"]')?.textContent
  const buttonNamed = (m: { element: HTMLElement }, name: string) => [...section(m).querySelectorAll("button")].find(b => b.textContent === name) ?? null
  /** Keyboard activation: focus, Enter keydown, then the click a browser derives from it (jsdom does not). */
  async function press(button: HTMLButtonElement | null, name: string) {
    assert.ok(button, `missing ${name}`)
    await act(async () => { button.focus(); button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); button.click(); await flush() })
  }
  // Booleans only: an assertion diff of a jsdom node would serialize the whole window.
  const focusedStatus = (m: { element: HTMLElement }) => {
    const active = document.activeElement
    return active !== null && section(m).contains(active) && active.tagName !== "BUTTON" && active.getAttribute("role") === "status"
  }

  await t.test("sign-in copy uses the readable soft tone and a host without a controller is not offered as a retry", async () => {
    const f = fixture(); f.intercept(async () => { throw new Error("token=private") })
    const m = await mount(f)
    assert.ok(!section(m).outerHTML.includes("color-arco-muted"), "no low-contrast muted text in the sign-in section")
    assert.ok([...section(m).querySelectorAll("p")].some(p => p.textContent === "Signing in does not authorize a transaction." && p.className.includes("text-[var(--color-arco-text-soft)]")))
    await act(async () => { await m.host.signIn() })
    assert.equal(statusText(m), "Stocks sign-in could not be completed. Try again.", "a real failure keeps its retry copy")
    assert.ok(buttonNamed(m, "Retry Stocks sign-in") !== null)
    f.intercept(undefined)
    await m.render({ ...initial, apiBase: "https://private:secret@api.example" })
    assert.equal(m.host.walletStatus, "ready")
    assert.equal(m.host.snapshot.status, "error")
    assert.equal(m.host.canSignIn, false)
    assert.equal(statusText(m), UNAVAILABLE_COPY)
    assert.ok(!section(m).textContent?.includes("Try again"))
    assert.ok(!section(m).textContent?.includes("Retry"))
    const button = buttonNamed(m, "Sign in to Stocks")
    assert.ok(button !== null); assert.equal(button.disabled, true)
    const calls = f.calls.length
    await act(async () => { button.click(); await flush() })
    assert.equal(f.calls.length, calls, "the unavailable host sends nothing")
    assert.ok(!section(m).outerHTML.includes("color-arco-muted"))
    await m.render(initial)
    assert.equal(statusText(m), "Sign in to view your Stocks account.")
    await m.unmount()
  })

  await t.test("after a keyboard sign-in, retry, cancel or sign-out the status text keeps focus; a button is never focused", async () => {
    const f = fixture()
    const m = await mount(f)
    await press(buttonNamed(m, "Sign in to Stocks"), "Sign in to Stocks")
    assert.equal(m.host.snapshot.status, "authenticated")
    assert.equal(f.calls.length, 2)
    assert.ok(focusedStatus(m), `after sign-in focus is on ${document.activeElement?.tagName}`)
    await press(buttonNamed(m, "Sign out of Stocks"), "Sign out of Stocks")
    assert.equal(m.host.snapshot.session, null)
    assert.ok(focusedStatus(m), `after sign-out focus is on ${document.activeElement?.tagName}`)
    assert.equal(f.calls.length, 2, "moving focus starts no sign-in")

    const pending = deferred<Response>(); f.intercept(async () => pending.promise)
    await press(buttonNamed(m, "Sign in to Stocks"), "Sign in to Stocks")
    assert.equal(m.host.snapshot.status, "signing-in")
    // The pressed button stays but turns into the disabled "Signing in…"; its stranded focus goes to the status text, from
    // where the next Tab reaches "Cancel sign-in".
    assert.ok(focusedStatus(m), `while the signature is pending focus is on ${document.activeElement?.tagName} ${document.activeElement?.textContent}`)
    await press(buttonNamed(m, "Cancel sign-in"), "Cancel sign-in")
    assert.equal(m.host.snapshot.status, "signed-out")
    assert.ok(focusedStatus(m), `after cancel focus is on ${document.activeElement?.tagName}`)
    pending.resolve(new Response("{}", { status: 500 })); await act(async () => { await flush() })

    f.intercept(async () => { throw new Error("offline") })
    await press(buttonNamed(m, "Sign in to Stocks"), "Sign in to Stocks")
    assert.equal(m.host.snapshot.status, "error")
    f.intercept(undefined)
    await press(buttonNamed(m, "Retry Stocks sign-in"), "Retry Stocks sign-in")
    assert.equal(m.host.snapshot.status, "authenticated")
    assert.ok(focusedStatus(m), `after retry focus is on ${document.activeElement?.tagName}`)
    const status = section(m).querySelector('[role="status"]') as HTMLElement
    assert.equal(status.getAttribute("tabindex"), "-1", "reachable by script only, not a Tab stop")
    assert.match(status.className, /focus-visible:outline-\[var\(--color-arco-ink\)\]/)
    await m.unmount()
  })

  await t.test("focus is not moved on first render, without user interaction, or after the user worked elsewhere", async () => {
    const f = fixture()
    const outside = document.createElement("button"); outside.textContent = "Elsewhere"; document.body.append(outside)
    try {
      const m = await mount(f)
      assert.ok(document.activeElement === document.body, "first render")
      await act(async () => { await m.host.signIn() })
      assert.equal(m.host.snapshot.status, "authenticated")
      assert.ok(document.activeElement === document.body, "programmatic sign-in")
      await act(async () => m.host.logout())
      assert.ok(document.activeElement === document.body, "programmatic sign-out")
      await press(buttonNamed(m, "Sign in to Stocks"), "Sign in to Stocks")
      assert.ok(focusedStatus(m))
      await act(async () => { outside.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); outside.focus(); outside.blur() })
      assert.ok(document.activeElement === document.body)
      await act(async () => m.host.logout())
      assert.equal(m.host.snapshot.session, null)
      assert.ok(document.activeElement === document.body, "the user left the section before the state changed")
      await m.unmount()
    } finally { outside.remove() }
  })

  await t.test("pending owner unmount aborts HTTP and removes timers/listeners", async () => {
    const f = fixture(); const pending = deferred<Response>(); f.intercept(() => pending.promise)
    const m = await mount(f)
    let promise!: Promise<void>
    await act(async () => { promise = m.host.signIn(); await flush() })
    assert.equal(f.calls.length, 1)
    await m.unmount()
    assert.equal(f.calls[0]!.signal?.aborted, true)
    await promise
    pending.resolve(Response.json({})); await flush()
    assert.equal(f.calls.length, 1)
    window.dispatchEvent(new dom.window.Event("pageshow"))
    assert.equal(f.timers.size, 0)
  })
  await t.test("actual injected and Dynamic providers propagate connection lifetimes without live SDK/RPC", async () => {
    // Mock only vendor hook inputs and contract transport; execute production wallet/provider code.
    class FixtureInjectedConnector {
      provider = { request: async () => { assert.fail("render must not request the wallet") }, on() {}, removeListener() {} }
      isInstalledOnBrowser() { return true }
      get ethProviderHelper() { return { getInstalledProvider: () => this.provider } }
    }
    const connector = new FixtureInjectedConnector()
    const sdk = { Connector: FixtureInjectedConnector, dynamic: { handleLogOut: async () => {}, network: 91342, primaryWallet: { id: "wallet-a", address: A, connector } as { id: string; address: string; connector?: FixtureInjectedConnector }, sdkHasLoaded: true, setShowAuthFlow: () => {} }, account: { address: A, chainId: 91342, status: "connected" }, client: {} as Record<string, unknown> }
    Object.assign(globalThis, { __giwaWalletTest: sdk })
    const vendor = `export const EthereumInjectedConnector=globalThis.__giwaWalletTest.Connector; export const useDynamicContext=()=>globalThis.__giwaWalletTest.dynamic; export const useAccount=()=>globalThis.__giwaWalletTest.account; export const useSwitchChain=()=>({switchChainAsync:async()=>{}}); export const useWalletClient=()=>({data:globalThis.__giwaWalletTest.client});`
    const contract = `export const publicGiwaClient={getBalance:async()=>1000000000000000000n}; export const setDynamicWalletClient=()=>{}; export const setInjectedWalletSource=()=>{};`
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.includes("/stocks-wallet-source/dynamic-injected.ts") && specifier === "@dynamic-labs/ethereum") return { url: `data:text/javascript,${encodeURIComponent(vendor)}`, shortCircuit: true }
      if (context.parentURL?.includes("/giwa/wallet.tsx")) {
        if (["@dynamic-labs/sdk-react-core", "wagmi"].includes(specifier)) return { url: `data:text/javascript,${encodeURIComponent(vendor)}`, shortCircuit: true }
        if (specifier === "./contracts") return { url: `data:text/javascript,${encodeURIComponent(contract)}`, shortCircuit: true }
      }
      return next(specifier, context)
    } })
    try {
      const { GiwaWalletProvider, DynamicGiwaWalletProvider, useGiwaWallet } = await import("../wallet")
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
      let requestGate: Promise<string[]> | undefined
      let chain = "0x164ce"
      const emit = (event: string, value: unknown) => listeners.get(event)?.forEach(listener => listener(value))
      const injected = {
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return chain
          if (method === "eth_requestAccounts") { if (requestGate) return requestGate; emit("accountsChanged", [A]); return [A] }
          throw new Error(`Unexpected wallet method: ${method}`)
        },
        on(event: string, fn: (...args: unknown[]) => void) { const set = listeners.get(event) ?? new Set(); set.add(fn); listeners.set(event, set) },
        removeListener(event: string, fn: (...args: unknown[]) => void) { listeners.get(event)?.delete(fn) },
      }
      Object.defineProperty(window, "ethereum", { configurable: true, value: injected })
      const f = fixture(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element)
      let wallet!: ReturnType<typeof useGiwaWallet>; let host!: StocksHostValue
      function ReadHost() { host = useGiwaStocksHost(); return <StocksSignIn /> }
      function Bridge() {
        wallet = useGiwaWallet()
        return <StocksHostProvider context={{ ...initial, walletAddress: wallet.connected ? wallet.address : null, chainId: wallet.chainId, walletEpoch: wallet.sessionEpoch }} dependencies={f.dependencies} signingReady={wallet.signingReady}><ReadHost /></StocksHostProvider>
      }
      await act(async () => { root.render(<StrictMode><GiwaWalletProvider><Bridge /></GiwaWalletProvider></StrictMode>); await flush() })
      assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 3, "StrictMode must remove first setup listeners")
      await act(async () => { await wallet.connect(); await flush() })
      assert.equal(wallet.address?.toLowerCase(), A)
      assert.equal(wallet.chainId, 91342)
      assert.equal(wallet.signingReady, true)
      await act(async () => { await host.signIn() })
      assert.ok(host.snapshot.session)
      const initialSourceEpoch = wallet.sessionEpoch
      Object.defineProperty(window, "ethereum", { configurable: true, value: { ...injected } })
      await act(async () => { root.render(<StrictMode><GiwaWalletProvider><Bridge /></GiwaWalletProvider></StrictMode>); await flush() })
      assert.notEqual(wallet.sessionEpoch, initialSourceEpoch)
      assert.equal(host.snapshot.session, null, "injected source replacement retires the session on render")
      assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 3)
      await act(async () => { await host.signIn() })
      const epoch = wallet.sessionEpoch
      await act(async () => { emit("accountsChanged", [B]); emit("accountsChanged", [A]); await flush() })
      assert.notEqual(wallet.sessionEpoch, epoch, "batched A→B→A still retires session")
      assert.equal(host.snapshot.session, null)
      await act(async () => { await host.signIn() })
      chain = "0x1"
      await act(async () => { emit("chainChanged", chain); await flush() })
      assert.equal(host.snapshot.session, null); assert.equal(host.canSignIn, false)
      chain = "0x164ce"
      await act(async () => { emit("chainChanged", chain); await flush() })
      await act(async () => { wallet.disconnect(); await flush() })
      const chainDuringConnect = deferred<string[]>(); requestGate = chainDuringConnect.promise
      let changingConnection!: Promise<void>
      await act(async () => { changingConnection = wallet.connect(); await flush(); emit("chainChanged", chain); await flush() })
      await act(async () => { chainDuringConnect.resolve([A]); await changingConnection; await flush() })
      assert.equal(wallet.connected, true, "a newer chain event must not discard a valid connected account")
      assert.equal(wallet.chainId, 91342)
      const pending = deferred<string[]>(); requestGate = pending.promise
      let connect!: Promise<void>
      await act(async () => { connect = wallet.connect(); await flush(); wallet.disconnect(); await flush() })
      await act(async () => { pending.resolve([A]); await connect; await flush() })
      assert.equal(wallet.connected, false, "late connect cannot undo logout")
      await act(async () => root.unmount())
      assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 0)
      assert.equal(f.timers.size, 0)
      element.remove()

      const dynamicElement = document.createElement("div"); document.body.append(dynamicElement); const dynamicRoot = createRoot(dynamicElement)
      const client = (address: string) => ({ account: { address }, chain: { id: 91342 }, signMessage: async () => SIG })
      sdk.client = client(A)
      const renderDynamic = async () => act(async () => { dynamicRoot.render(<StrictMode><DynamicGiwaWalletProvider><Bridge /></DynamicGiwaWalletProvider></StrictMode>); await flush() })
      await renderDynamic()
      assert.equal(wallet.signingReady, true)
      assert.equal(wallet.source?.mode === "dynamic" && wallet.source.rawProvider, connector.provider)
      await act(async () => { await host.signIn() }); assert.ok(host.snapshot.session)
      const rawEpoch = wallet.sessionEpoch
      connector.provider = { ...connector.provider }
      await renderDynamic()
      assert.notEqual(wallet.sessionEpoch, rawEpoch); assert.equal(host.snapshot.session, null)
      assert.equal(wallet.source?.mode === "dynamic" && wallet.source.rawProvider, connector.provider)
      await act(async () => { await host.signIn() }); assert.ok(host.snapshot.session)
      const firstEpoch = wallet.sessionEpoch
      sdk.client = client(A) // same address, new signer source
      await renderDynamic()
      assert.notEqual(wallet.sessionEpoch, firstEpoch); assert.equal(host.snapshot.session, null)
      await act(async () => { await host.signIn() })
      sdk.dynamic.primaryWallet = { id: "wallet-b", address: B } // SDK changed before Wagmi caught up
      await renderDynamic()
      assert.equal(wallet.signingReady, false); assert.equal(host.snapshot.session, null)
      assert.equal(wallet.source?.mode === "dynamic" && wallet.source.rawProvider, null)
      sdk.account = { address: B, chainId: 91342, status: "connected" }; sdk.client = client(B)
      await renderDynamic(); assert.equal(wallet.signingReady, true)
      await act(async () => { await host.signIn() }); assert.equal((host.snapshot as HostSnapshot).session?.walletAddress.toLowerCase(), B)
      await act(async () => { wallet.disconnect(); await flush() })
      assert.equal(wallet.connected, false); assert.equal(host.snapshot.session, null)
      assert.equal(wallet.source?.mode === "dynamic" && wallet.source.rawProvider, null)
      await act(async () => dynamicRoot.unmount()); dynamicElement.remove()
      assert.equal(f.timers.size, 0)
    } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, "__giwaWalletTest") }
  })

})

test("application owns a single provider above route branches and leaves legacy admin guard intact", () => {
  const main = readFileSync(new URL("../../../main.tsx", import.meta.url), "utf8")
  const layout = readFileSync(new URL("../GiwaPreprodApp.tsx", import.meta.url), "utf8")
  const providers = readFileSync(new URL("../providers.tsx", import.meta.url), "utf8")
  assert.match(main, /<GiwaPreprodProviders><RouterProvider router=\{router\} \/><\/GiwaPreprodProviders>/)
  assert.doesNotMatch(layout, /GiwaPreprodProviders/)
  assert.match(main, /<RequireGiwaAdmin><GiwaAdminLayout \/><\/RequireGiwaAdmin>/)
  assert.match(providers, /<DynamicGiwaWalletProvider><GiwaStocksHost>/)
  assert.match(providers, /<GiwaWalletProvider><GiwaStocksHost>/)
})
