import assert from "node:assert/strict"
import test from "node:test"
import { activeWalletSource, setDynamicWalletClient, setInjectedWalletSource } from "../contracts"
import { activeWalletSourceView, currentActiveWalletSource } from "./bridge"
import { captureWalletSource } from "./capture"
import { fakeProvider, WALLET, windowEthereumSpy } from "./test-support"

test("contracts accessor: injected window.ethereum identity, Dynamic client, restore", () => {
  const provider = fakeProvider()
  const { restore } = windowEthereumSpy(provider)
  try {
    setInjectedWalletSource()
    const injected = activeWalletSource()
    assert.equal(injected.mode, "injected")
    assert.equal(injected.mode === "injected" && injected.provider, provider)
    assert.equal(currentActiveWalletSource()?.mode, "injected")
    const client = { sendTransaction: async () => "0x" as const, writeContract: async () => "0x" as const }
    setDynamicWalletClient(client)
    assert.deepEqual(activeWalletSource(), { mode: "dynamic", client })
    assert.equal((activeWalletSource() as { client: unknown }).client, client)
    setDynamicWalletClient(null)
    assert.deepEqual(activeWalletSource(), { mode: "dynamic", client: null })
    setInjectedWalletSource()
    assert.equal((activeWalletSource() as { provider: unknown }).provider, provider)
    assert.equal(provider.calls.length, 0)
  } finally { restore(); setInjectedWalletSource() }
  assert.deepEqual(activeWalletSource(), { mode: "injected", provider: null }, "no window")
})

test("bridge view maps sessionEpoch, and the module source retires a capture on replacement or mode change", () => {
  const provider = fakeProvider()
  const { restore } = windowEthereumSpy(provider)
  try {
    setInjectedWalletSource()
    const source = { mode: "injected" as const, provider }
    const view = activeWalletSourceView({ source, address: WALLET, chainId: 91342, sessionEpoch: "injected:4" })
    assert.deepEqual(view, { source, address: WALLET, chainId: 91342, epoch: "injected:4" })
    const capture = captureWalletSource(view, { activeSource: currentActiveWalletSource })
    assert.equal(capture.status, "READY")
    const captured = (capture as Extract<typeof capture, { status: "READY" }>).source
    assert.equal(captured.isCurrent(), true)
    setDynamicWalletClient(null)
    assert.equal(captured.isCurrent(), false)
    setInjectedWalletSource()
    assert.equal(captured.isCurrent(), true)
    restore()
    windowEthereumSpy({ ...provider })
    assert.equal(captured.isCurrent(), false, "replaced window.ethereum object")
    assert.equal(provider.calls.length, 0)
  } finally { restore(); setInjectedWalletSource() }
})
