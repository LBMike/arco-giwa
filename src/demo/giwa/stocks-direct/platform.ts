// The browser's direct-trade ports: the connected wallet sends, GIWA's public RPC gives the receipt, and the server
// (through this page's API base) gives the status.
import { getAddress } from "viem"
import { publicGiwaClient, walletClient } from "../contracts"
import { STOCKS_ABI } from "../stocks-wallet/abi"
import { newDirectOrderKey, type DirectOrderKey } from "./key"
import { readDirectStatus } from "./status"
import { DirectTradeError, type DirectTradeInput, type DirectTradePorts, type TxHash } from "./trade"

type Simulator = { simulateContract(args: Record<string, unknown>): Promise<{ request: unknown }> }
type Writer = { writeContract(request: unknown): Promise<TxHash> }

/** The one call a direct trade makes: deposit the tUSDC (Buy) or escrow the NVDA (Sell), under the order key. */
export function directCall(input: DirectTradeInput, key: DirectOrderKey) {
  const account = getAddress(input.owner)
  return input.side === "BUY"
    ? { account, address: getAddress(input.contracts.fundingVault), abi: STOCKS_ABI, functionName: "depositForOrder" as const, args: [key, BigInt(input.amount)] as const }
    : { account, address: getAddress(input.contracts.redemptionEscrow), abi: STOCKS_ABI, functionName: "escrowForOrder" as const, args: [key, getAddress(input.contracts.stockToken), BigInt(input.amount)] as const }
}

export function platformDirectPorts(options: { apiBase: string; fetch?: (input: string, init: RequestInit) => Promise<Response> }): DirectTradePorts {
  return {
    async send(input, key) {
      const call = directCall(input, key)
      let simulation: { request: unknown }
      try {
        simulation = await (publicGiwaClient as unknown as Simulator).simulateContract({ ...call, args: [...call.args] })
      } catch {
        // GIWA would revert it (balance, approval, paused contract): nothing is asked of the wallet.
        throw new DirectTradeError("NOT_ACCEPTED")
      }
      return (walletClient() as unknown as Writer).writeContract(simulation.request)
    },
    async receipt(hash) {
      const receipt = await publicGiwaClient.getTransactionReceipt({ hash }).catch(() => null)
      return receipt === null ? null : receipt.status === "success" ? "success" : "reverted"
    },
    status: (key, side) => readDirectStatus({ apiBase: options.apiBase, key, side, fetch: options.fetch }),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    newKey: () => newDirectOrderKey(),
  }
}
