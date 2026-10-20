import { readStocksPublicJson } from "../stocks-runtime/public-config.js"
import { parseStocksRuntimeConfig } from "../stocks-runtime/runtime.js"

// Wallets whose nonce a running service owns. The hosted Stocks signer keeps its own record of the
// next nonce of its wallet and refuses to sign once the chain moves past it (stocks-signer/readiness.ts),
// so any other transaction from that wallet stops Stocks until the journal is re-seeded
// (docs/operations/app-arco-financial-release.md). The admin console must never build a transaction
// for such a wallet to sign, and tells its operator when they are signed in with one.

/**
 * The Stocks signer's wallet (lowercase) from the Stocks config (STOCKS_CONFIG_PATH), [] without one.
 * Read even while Stocks is off: the signer's nonce record outlives a pause, so a transaction from its
 * wallet would still stop the next Stocks start. With Stocks on, a config the runtime would refuse
 * fails here too; with Stocks off, an unreadable config only leaves the guard without a wallet.
 */
export async function stocksSignerWallets(env: NodeJS.ProcessEnv, localCustomer = false): Promise<string[]> {
  if (!env.STOCKS_CONFIG_PATH) return []
  try {
    const config = parseStocksRuntimeConfig(await readStocksPublicJson(env.STOCKS_CONFIG_PATH), localCustomer)
    return [config.manifest.signerAddress.toLowerCase()]
  } catch (error) {
    if (env.STOCKS_MODE === "DEMO_TESTNET") throw error
    console.error(JSON.stringify({ service: "arco-giwa-api", signerWallets: "config-unreadable" }))
    return []
  }
}

/** Shown to the operator, and returned by the transaction builders, for a signer wallet. */
export const SIGNER_WALLET_ERROR =
  "This wallet is the Stocks signer. A transaction from it moves the nonce the signer keeps and stops Stocks until its journal is re-seeded. Sign in with another operator wallet."
export const SIGNER_WALLET_CODE = "SIGNER_WALLET"

/** The legacy shared token names no wallet: these transactions are built only for a signed-in wallet. */
export const SESSION_WALLET_ERROR = "Sign in with an operator wallet: this transaction is built for that wallet to sign"
export const SESSION_WALLET_CODE = "SESSION_WALLET_REQUIRED"
