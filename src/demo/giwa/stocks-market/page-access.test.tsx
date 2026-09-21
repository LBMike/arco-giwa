// The /stocks page's trade-panel access: after a wallet switch the host is signed out with no error of its own, and the page
// reports WALLET_CHANGED (never an address). The DOM part is gated like the other market DOM suites: set
// GIWA_MARKET_DOM_RUNTIME to an existing jsdom package.json.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test, { type TestContext } from "node:test"
import { walletChangedSinceSignIn } from "./page-access"

const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"

test("walletChangedSinceSignIn: only signed out without an error, with a different wallet connected than the last signed-in one", () => {
  const base = { status: "signed-out", error: null, connected: B, lastAuthenticated: A } as const
  assert.equal(walletChangedSinceSignIn(base), true)
  assert.equal(walletChangedSinceSignIn({ ...base, connected: B.toUpperCase().replace("0X", "0x") }), true)
  assert.equal(walletChangedSinceSignIn({ ...base, connected: A.toUpperCase().replace("0X", "0x") }), false, "same wallet, any casing (e.g. an explicit sign-out)")
  assert.equal(walletChangedSinceSignIn({ ...base, lastAuthenticated: null }), false, "nothing signed in during this visit (a full reload forgets)")
  assert.equal(walletChangedSinceSignIn({ ...base, connected: null }), false, "disconnected is the wallet step's, not a wallet change")
  assert.equal(walletChangedSinceSignIn({ ...base, error: "SESSION_EXPIRED" }), false, "the host's own error wins")
  for (const status of ["signing-in", "authenticated", "error"] as const) assert.equal(walletChangedSinceSignIn({ ...base, status }), false, status)
})

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

test("useStocksPageAccess: A signed in, then B connected → WALLET_CHANGED without an address; B signs in → cleared; a reload forgets A (set GIWA_MARKET_DOM_RUNTIME)", { skip: !runtime }, async (t: TestContext) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid/stocks", pretendToBeVisual: true })
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { parseSiweMessage } = (await import("viem/siwe")) as AnyModule
  const { StocksHostProvider, useGiwaStocksHost } = (await import("../stocks-host/StocksHostProvider")) as AnyModule
  const { useStocksPageAccess } = (await import("./page-access")) as AnyModule
  const { act, createElement: h, StrictMode } = React
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
  const now = Date.UTC(2026, 8, 20)
  // Offline SIWE: a nonce and a verify answer per sign-in.
  const dependencies = {
    now: () => now,
    signMessage: async () => `0x${"11".repeat(65)}`,
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (url.endsWith("/nonce")) return Response.json({ walletAddress: body.walletAddress, domain: body.domain, nonce: "abcdefgh12345678", expiresAt: new Date(now + 60_000).toISOString() })
      const message = parseSiweMessage(body.message)
      const token = `e30.${Buffer.from(JSON.stringify({ sub: message.address, domain: message.domain, chainId: 91342, iat: now / 1000, exp: now / 1000 + 900 })).toString("base64url")}.fixture`
      return Response.json({ walletAddress: message.address, chainId: 91342, expiresIn: 900, token })
    },
  }
  let access: Record<string, unknown> = {}
  let host: AnyModule = {}
  function Probe() { host = useGiwaStocksHost(); access = useStocksPageAccess(); return null }
  const element = document.createElement("div"); document.body.append(element)
  let root = createRoot(element)
  const render = async (address: string | null) => {
    const context = { walletAddress: address, chainId: 91342, frontendOrigin: "https://fixture.invalid", apiBase: "https://api.fixture" }
    await act(async () => { root.render(h(StrictMode, null, h(StocksHostProvider, { context, dependencies }, h(Probe)))); await flush() })
  }
  const signIn = async () => { await act(async () => { await host.signIn(); await flush() }) }
  // No address (in any casing) and no session token is handed to the trade panel.
  const leaks = () => JSON.stringify(Object.values(access).filter(value => typeof value !== "function")).toLowerCase()
  try {
    await render(A)
    assert.deepEqual([access.host, access.hostError], ["signed-out", null], "nothing signed in yet")
    await signIn()
    assert.deepEqual([access.host, access.hostError], ["authenticated", null])

    await render(B)
    assert.deepEqual([access.wallet, access.host, access.hostError], ["ready", "signed-out", "WALLET_CHANGED"], "another wallet after A's sign-in")
    for (const secret of [A, B, "e30."]) assert.equal(leaks().includes(secret.toLowerCase()), false, `no ${secret} in the access`)

    await render(null)
    assert.deepEqual([access.wallet, access.hostError], ["disconnected", null], "disconnected: the wallet step, not a wallet change")
    await render(B)
    assert.equal(access.hostError, "WALLET_CHANGED", "reconnecting B still differs from the last signed-in wallet")
    await signIn()
    assert.deepEqual([access.host, access.hostError], ["authenticated", null], "B signed in: cleared")
    await act(async () => { host.logout(); await flush() })
    assert.deepEqual([access.host, access.hostError], ["signed-out", null], "an explicit sign-out with the same wallet is no wallet change")
    await render(A)
    assert.equal(access.hostError, "WALLET_CHANGED", "the last signed-in wallet is now B")

    // A full reload (a fresh page mount) forgets the earlier sign-in.
    await act(async () => root.unmount())
    root = createRoot(element)
    await render(B)
    assert.deepEqual([access.host, access.hostError], ["signed-out", null])
  } finally { await act(async () => root.unmount()); element.remove() }
})
