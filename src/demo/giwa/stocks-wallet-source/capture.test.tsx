import assert from "node:assert/strict"
import test from "node:test"
import { getAddress } from "viem"
import { captureWalletSource, WALLET_SOURCE_EVENTS } from "./capture"
import type { ActiveWalletSource, CapturedWalletSource, WalletSourceView } from "./types"
import { fakeProvider, touchSpy, WALLET, windowEthereumSpy, type FakeProvider } from "./test-support"

function view(provider: FakeProvider | null, change: Partial<WalletSourceView> = {}): WalletSourceView {
  return { source: { mode: "injected", provider }, address: WALLET.toLowerCase(), chainId: 91342, epoch: "injected:1", ...change }
}

function ready(provider: FakeProvider, options?: Parameters<typeof captureWalletSource>[1]): CapturedWalletSource {
  const capture = captureWalletSource(view(provider), options)
  assert.equal(capture.status, "READY")
  return (capture as Extract<typeof capture, { status: "READY" }>).source
}

test("injected source is captured without any wallet request; listeners are added and removed", () => {
  const provider = fakeProvider()
  const source = ready(provider)
  assert.equal(source.mode, "injected")
  assert.equal(source.address, getAddress(WALLET))
  assert.equal(source.epoch, "injected:1")
  assert.equal(provider.calls.length, 0)
  assert.equal(provider.listenerCount(), WALLET_SOURCE_EVENTS.length)
  assert.equal(source.isCurrent(), true)
  source.dispose()
  source.dispose()
  assert.equal(provider.listenerCount(), 0)
  assert.equal(source.isCurrent(), false)
  assert.equal(provider.calls.length, 0)
})

test("request passes method and params straight to the provider, synchronously", () => {
  const provider = fakeProvider({ eth_blockNumber: "0x1" })
  const source = ready(provider)
  const params = ["a", 1] as const
  void source.request({ method: "eth_blockNumber", params })
  assert.deepEqual(provider.calls, [{ method: "eth_blockNumber", params }])
  assert.equal(provider.calls[0]!.params, params)
})

test("Dynamic mode is unsupported with or without a client: nothing on the client or window.ethereum is touched", () => {
  const injected = fakeProvider()
  const { spy, restore } = windowEthereumSpy(injected)
  try {
    const { proxy, touched } = touchSpy({ request: () => Promise.resolve("0x164ce"), transport: { request: () => Promise.resolve(null) }, sendTransaction: () => Promise.resolve("0x") })
    for (const client of [proxy, null]) {
      const capture = captureWalletSource({ source: { mode: "dynamic", client }, address: WALLET, chainId: 91342, epoch: "dynamic:1" })
      assert.deepEqual(capture, { status: "UNAVAILABLE", code: "WALLET_SOURCE_UNSUPPORTED" })
    }
    assert.deepEqual(touched, [])
    assert.equal(spy.reads, 0)
    assert.equal(injected.calls.length, 0)
    assert.equal(injected.listenerCount(), 0)
  } finally { restore() }
})

test("missing source, provider, address and epoch are unavailable with their codes and no subscription", () => {
  const provider = fakeProvider()
  const cases: [WalletSourceView, string][] = [
    [{ ...view(provider), source: null }, "WALLET_SOURCE_MISSING"],
    [view(null), "WALLET_SOURCE_MISSING"],
    [view({ on() {}, removeListener() {} } as unknown as FakeProvider), "WALLET_SOURCE_MISSING"],
    [view({ request: provider.request } as unknown as FakeProvider), "WALLET_SOURCE_UNSUPPORTED"],
    [view(provider, { address: null }), "WALLET_NOT_CONNECTED"],
    [view(provider, { address: "0x1234" }), "WALLET_NOT_CONNECTED"],
    [view(provider, { address: `0x${"0".repeat(40)}` }), "WALLET_NOT_CONNECTED"],
    [view(provider, { epoch: "" }), "WALLET_EPOCH_REQUIRED"],
  ]
  for (const [input, code] of cases) assert.deepEqual(captureWalletSource(input), { status: "UNAVAILABLE", code }, code)
  assert.equal(provider.calls.length, 0)
  assert.equal(provider.listenerCount(), 0)
})

test("each provider event retires the capture for good", () => {
  for (const event of WALLET_SOURCE_EVENTS) {
    const provider = fakeProvider()
    const source = ready(provider)
    provider.emit(event, event === "chainChanged" ? "0x164ce" : [WALLET])
    assert.equal(source.isCurrent(), false, event)
    provider.emit(event, event === "chainChanged" ? "0x164ce" : [WALLET])
    assert.equal(source.isCurrent(), false, `${event} round trip`)
    assert.equal(provider.calls.length, 0)
  }
})

test("the module's active source must stay the identical injected provider object", () => {
  const provider = fakeProvider()
  let active: ActiveWalletSource | null = { mode: "injected", provider }
  const source = ready(provider, { activeSource: () => active })
  assert.equal(source.isCurrent(), true)
  active = { mode: "injected", provider: { ...provider } }
  assert.equal(source.isCurrent(), false, "same-shaped replacement object")
  active = { mode: "injected", provider }
  assert.equal(source.isCurrent(), true)
  active = { mode: "dynamic", client: provider }
  assert.equal(source.isCurrent(), false, "mode change")
  active = null
  assert.equal(source.isCurrent(), false, "no source")
  const throwing = ready(fakeProvider(), { activeSource: () => { throw new Error("boom") } })
  assert.equal(throwing.isCurrent(), false)
  assert.equal(provider.calls.length, 0)
})
