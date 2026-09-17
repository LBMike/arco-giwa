import assert from "node:assert/strict"
import test from "node:test"
import { createWalletClient, custom } from "viem"
import { captureWalletSource } from "./capture"
import { fakeProvider, touchSpy, WALLET, windowEthereumSpy } from "./test-support"

// Negative control for plan finding 3. Dynamic's connector client nests viem custom() transports, and each client
// layer's request retries -32603. retryDelay is shortened only to keep the test fast; the retry count is viem's default.
test("a Dynamic-shaped nested viem client repeats eth_sendTransaction, so capture refuses it without touching it", async () => {
  const provider = fakeProvider({ eth_sendTransaction: () => { throw { code: -32603, message: "Internal JSON-RPC error." } } })
  const inner = createWalletClient({ transport: custom(provider, { retryDelay: 1 }) })
  const outer = createWalletClient({ transport: custom(inner, { retryDelay: 1 }) })
  const tx = { from: WALLET, to: WALLET, data: "0x00", value: "0x0" } as const
  const sends = () => provider.calls.filter(call => call.method === "eth_sendTransaction").length
  // client.transport.request is the next layer's request: here the inner client's retrying request.
  await assert.rejects(outer.transport.request({ method: "eth_sendTransaction", params: [tx] }))
  assert.ok(sends() > 1, `expected repeated sends, saw ${sends()}`)
  assert.equal(sends(), 4, "one retrying layer below transport.request: 1 + 3 retries")
  await assert.rejects(outer.request({ method: "eth_sendTransaction", params: [tx] }))
  assert.equal(sends(), 4 + 16, "client.request adds the outer layer's retries: 4 × 4")

  const before = provider.calls.length
  const { spy, restore } = windowEthereumSpy(fakeProvider())
  try {
    const { proxy, touched } = touchSpy(outer)
    const capture = captureWalletSource({ source: { mode: "dynamic", client: proxy }, address: WALLET, chainId: 91342, epoch: "dynamic:3" })
    assert.deepEqual(capture, { status: "UNAVAILABLE", code: "WALLET_SOURCE_UNSUPPORTED" })
    assert.deepEqual(touched, [])
    assert.equal(spy.reads, 0)
  } finally { restore() }
  assert.equal(provider.calls.length, before)
})
