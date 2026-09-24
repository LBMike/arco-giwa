import assert from "node:assert/strict"
import test from "node:test"
import { EthereumInjectedConnector, MetaMaskConnector } from "@dynamic-labs/ethereum"
import { selectedDynamicInjectedProvider } from "./dynamic-injected"
import { fakeProvider } from "./test-support"

test("Dynamic extension resolution uses the SDK selected installed provider, never its client or send wrapper", () => {
  for (const Connector of [EthereumInjectedConnector, MetaMaskConnector]) {
    const provider = fakeProvider()
    const connector = Object.create(Connector.prototype)
    Object.defineProperties(connector, {
      isInstalledOnBrowser: { value: () => true },
      ethProviderHelper: { value: { getInstalledProvider: () => provider } },
      findProvider: { value: () => assert.fail("SDK/mobile wrapper must not be used") },
      getWalletClient: { value: () => assert.fail("retrying client must not be used") },
    })
    assert.equal(selectedDynamicInjectedProvider({ connector }), provider)
    assert.equal(provider.calls.length, 0)
    assert.equal(provider.listenerCount(), 0)
  }
})

test("Dynamic extension resolution refuses embedded/mobile/duck-typed or unobservable providers", () => {
  assert.equal(selectedDynamicInjectedProvider(null), null)
  assert.equal(selectedDynamicInjectedProvider({ connector: { findProvider: () => assert.fail("unrecognized connector") } }), null)
  for (const [installed, provider] of [[false, fakeProvider()], [true, {}], [true, { request: () => Promise.resolve(null) }]] as const) {
    const connector = Object.create(EthereumInjectedConnector.prototype)
    Object.defineProperties(connector, {
      isInstalledOnBrowser: { value: () => installed },
      ethProviderHelper: { value: { getInstalledProvider: () => { assert.ok(installed); return provider } } },
    })
    assert.equal(selectedDynamicInjectedProvider({ connector }), null)
  }
  assert.equal(selectedDynamicInjectedProvider({ get connector() { throw Error("SDK unavailable") } }), null)
})
