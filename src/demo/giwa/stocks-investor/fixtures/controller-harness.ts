// TEST-ONLY harness: the real HTTP client and controller over the explicit fake server.

import { createGiwaStocksHttpClient } from "../client"
import { createStocksInvestorController, type OrderAttempt, type StocksInvestorContext } from "../controller"
import type { GiwaStocksHostWallet, GiwaStocksSession, HexAddress } from "../types"
import { createFakeStocksServer } from "./fake-stocks-server"

export const WALLET_A = `0x${"a1".repeat(20)}` as HexAddress
export const WALLET_B = `0x${"b2".repeat(20)}` as HexAddress

export async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

export function createHarness(options: { deploymentId?: string } = {}) {
  const server = createFakeStocksServer({ deploymentId: options.deploymentId })
  // Each harness is its own "page": a fresh in-memory attempt registry.
  const registry = new Map<string, OrderAttempt>()
  const client = createGiwaStocksHttpClient({ baseUrl: "http://fixture.invalid", fetch: (input, init) => server.fetch(input, init) })
  let deviceNow = 1_000_000
  let keys = 0
  const rejected: string[] = []
  const makeController = () =>
    createStocksInvestorController({
      now: () => deviceNow,
      newIdempotencyKey: () => `test-key-${String(++keys).padStart(4, "0")}`,
      attemptRegistry: registry,
    })
  const controller = makeController()
  const tokens = new Map<string, string>()
  function session(wallet: HexAddress, fresh = false): GiwaStocksSession {
    if (fresh || !tokens.has(wallet)) tokens.set(wallet, server.controls.issueToken(wallet))
    return { status: "verified", walletAddress: wallet, chainId: 91342, token: tokens.get(wallet) as string }
  }
  const context = (value: GiwaStocksSession, hostWallet?: GiwaStocksHostWallet | null): StocksInvestorContext => ({
    client,
    session: value,
    hostWallet,
    onSessionRejected: (event) => rejected.push(event.walletAddress),
  })
  return {
    server,
    controls: server.controls,
    client,
    controller,
    registry,
    makeController,
    context,
    rejected,
    session,
    tokenOf: (wallet: HexAddress) => tokens.get(wallet) ?? null,
    async enter(wallet: HexAddress | null, hostWallet?: GiwaStocksHostWallet | null) {
      controller.setContext(context(wallet === null ? { status: "signed-out" } : session(wallet), hostWallet))
      await flush()
    },
    enterNow(wallet: HexAddress | null) {
      controller.setContext(context(wallet === null ? { status: "signed-out" } : session(wallet)))
    },
    enterWith(value: GiwaStocksSession, hostWallet?: GiwaStocksHostWallet | null) {
      controller.setContext(context(value, hostWallet))
    },
    advanceDevice(ms: number) {
      deviceNow += ms
    },
    requests: (method: string, suffix: string) => server.controls.requests.filter((request) => request.method === method && request.path.endsWith(suffix)),
    async quote(quantity: string, side: "BUY" | "SELL" = "BUY") {
      controller.setSide(side)
      controller.setQuantity(quantity)
      await controller.requestQuote()
      await flush()
    },
  }
}
