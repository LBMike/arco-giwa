import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { StocksHostProvider } from "./StocksHostProvider"
import { StocksSignIn } from "./StocksSignIn"
import type { HostContext, HostDependencies } from "./session"

// Runs without a DOM runtime; the provider.dom test covers sign-in, failure, host-unavailable and focus behaviour.
const A = "0x1111111111111111111111111111111111111111"
const ready: HostContext = { walletAddress: A, chainId: 91342, frontendOrigin: "https://app.example:8443", apiBase: "https://api.example" }
const dependencies: HostDependencies = { signMessage: async () => { throw new Error("server render never signs") }, fetch: (async () => { throw new Error("server render never fetches") }) as typeof fetch }
/** The provider's own layout effect (it creates the controller in the browser) is the only expected server warning. */
function render(context: HostContext, signingReady = true) {
  const original = console.error
  const unexpected: unknown[] = []
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) unexpected.push(args) }
  try { return renderToStaticMarkup(<StocksHostProvider context={context} dependencies={dependencies} signingReady={signingReady}><StocksSignIn /></StocksHostProvider>) }
  finally { console.error = original; assert.deepEqual(unexpected, []) }
}

test("every wallet state renders readable sign-in copy and a status that only script can focus", () => {
  const states: [string, string][] = [
    [render({ ...ready, walletAddress: null }), "Connect a wallet to sign in to Stocks."],
    [render({ ...ready, chainId: 1 }), "Switch your wallet to GIWA Sepolia to sign in to Stocks."],
    [render(ready, false), "Your wallet is not ready to sign a message."],
    [render(ready), "Sign in to view your Stocks account."],
  ]
  for (const [html, status] of states) {
    assert.ok(html.includes(`>${status}</p>`), status)
    assert.doesNotMatch(html, /color-arco-muted/, "the note must not use the low-contrast muted tone")
    assert.match(html, /<p class="mt-2 text-sm text-\[var\(--color-arco-text-soft\)\]">Signing in does not authorize a transaction\.<\/p>/)
    assert.match(html, /<p id="[^"]+" tabindex="-1" role="status" aria-live="polite" aria-atomic="true" class="text-sm focus-visible:outline [^"]*focus-visible:outline-\[var\(--color-arco-ink\)\]">/)
    assert.match(html, />Sign in to Stocks<\/button>/)
    assert.doesNotMatch(html, /Retry|Try again|not available on this page/)
  }
})

test("the sign-in section only ever moves focus to its status text, never to a button", () => {
  const source = readFileSync(new URL("./StocksSignIn.tsx", import.meta.url), "utf8")
  assert.deepEqual(source.match(/\.focus\(/g), [".focus("])
  assert.match(source, /statusRef\.current\?\.focus\(\{ preventScroll: true \}\)/)
  assert.doesNotMatch(source, /autoFocus/)
})
