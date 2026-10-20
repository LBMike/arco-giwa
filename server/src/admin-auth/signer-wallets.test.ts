import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { a, testManifest } from "../stocks/test-fixtures.js"
import { stocksSignerWallets } from "./signer-wallets.js"

test("stocksSignerWallets: the Stocks manifest's signer when the Stocks runtime is configured, none otherwise", async () => {
  assert.deepEqual(await stocksSignerWallets({}), [])
  assert.deepEqual(await stocksSignerWallets({ STOCKS_MODE: "DISABLED", STOCKS_CONFIG_PATH: "/nowhere.json" }), [])
  assert.deepEqual(await stocksSignerWallets({ STOCKS_MODE: "DEMO_TESTNET" }), [])
  await assert.rejects(stocksSignerWallets({ STOCKS_MODE: "DEMO_TESTNET", STOCKS_CONFIG_PATH: "/nowhere.json" }))

  const dir = mkdtempSync(join(tmpdir(), "signer-wallets-"))
  try {
    const manifest = testManifest()
    const path = join(dir, "stocks-runtime.json")
    writeFileSync(
      path,
      JSON.stringify({
        profile: "DEMO_TESTNET",
        manifest,
        rpcUrl: "https://rpc.example.test",
        signerUrl: "https://signer.example.test",
        contractPolicyVerified: true,
        paused: true,
        operators: [{ wallet: a(10), operatorId: "reader", permissions: ["stocks:read"] }],
      }),
    )
    assert.deepEqual(await stocksSignerWallets({ STOCKS_MODE: "DEMO_TESTNET", STOCKS_CONFIG_PATH: path }), [manifest.signerAddress.toLowerCase()])
    // Stocks off: the signer's nonce record still exists, so its wallet is still guarded.
    assert.deepEqual(await stocksSignerWallets({ STOCKS_MODE: "DISABLED", STOCKS_CONFIG_PATH: path }), [manifest.signerAddress.toLowerCase()])

    // A config the Stocks runtime would refuse fails here too (the server would not start either);
    // with Stocks off it only leaves the guard without a wallet.
    writeFileSync(path, JSON.stringify({ profile: "DEMO_TESTNET" }))
    await assert.rejects(stocksSignerWallets({ STOCKS_MODE: "DEMO_TESTNET", STOCKS_CONFIG_PATH: path }))
    assert.deepEqual(await stocksSignerWallets({ STOCKS_CONFIG_PATH: path }), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
