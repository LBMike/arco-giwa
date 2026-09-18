// Owner scope of kept hashes (no DOM): the signed-in session wallet must be the shown wallet on chain 91342, with an
// API base and an origin. The real host already drops the session on a wallet change; this check does not rely on it.
import assert from "node:assert/strict"
import test from "node:test"

import type { HostSession } from "../stocks-host/session"
import type { ExecutionHostView } from "./registry"
import { knownHashOwnerScope } from "./StocksExecutionProvider"

const A = "0x000000000000000000000000000000000000A11C"
const B = "0x000000000000000000000000000000000000B0B0"
const session: HostSession = Object.freeze({ id: "s-1", walletAddress: A, chainId: 91342, accessToken: "t", createdAt: 0, expiresAt: Number.MAX_SAFE_INTEGER })
const view = (overrides: Partial<ExecutionHostView> & { address?: string | null; chainId?: number | null } = {}): ExecutionHostView => ({
  session: overrides.session === undefined ? session : overrides.session,
  wallet: { source: null, address: overrides.address === undefined ? A : overrides.address, chainId: overrides.chainId === undefined ? 91342 : overrides.chainId, epoch: "e" },
  apiBase: overrides.apiBase === undefined ? "https://api.example.test" : overrides.apiBase,
})

test("the kept-hash owner is the signed-in session wallet shown on chain 91342 with an API base and origin", () => {
  assert.deepEqual(knownHashOwnerScope(view(), "https://app.example.test"), { wallet: A.toLowerCase(), chainId: 91342, apiBase: "https://api.example.test", origin: "https://app.example.test" })
  assert.equal(knownHashOwnerScope(view({ address: B }), "https://app.example.test"), null, "another shown wallet than the session's")
  assert.equal(knownHashOwnerScope(view({ address: A.toLowerCase() }), "https://app.example.test")?.wallet, A.toLowerCase(), "address case does not matter")
  assert.equal(knownHashOwnerScope(view({ chainId: 1 }), "https://app.example.test"), null)
  assert.equal(knownHashOwnerScope(view({ session: { ...session, chainId: 1 as 91342 } }), "https://app.example.test"), null)
  assert.equal(knownHashOwnerScope(view({ session: null }), "https://app.example.test"), null)
  assert.equal(knownHashOwnerScope(view({ address: null }), "https://app.example.test"), null)
  assert.equal(knownHashOwnerScope(view({ apiBase: null }), "https://app.example.test"), null)
  assert.equal(knownHashOwnerScope(view(), null), null)
})
