import { getAddress, type Address, type Hex } from "viem"
import { parseSiweMessage } from "viem/siwe"
import type { MessageRequest } from "./session"

export type MessageWallet = {
  getAddresses?: () => Promise<readonly string[]>
  getChainId?: () => Promise<number>
  signMessage?: (request: { account: Address; message: string }) => Promise<Hex>
}

/** Accepts the existing active injected or Dynamic client. No account request or transaction. */
export function createWalletMessageSigner(getClient: () => MessageWallet) {
  return async (request: MessageRequest): Promise<string> => {
    const message = parseSiweMessage(request.message)
    if (request.chainId !== 91342 || message.chainId !== 91342 || !message.address || getAddress(message.address) !== getAddress(request.account)) throw new Error("SIGN_IN_WALLET_MISMATCH")
    const client = getClient()
    if (!client.getAddresses || !client.getChainId || !client.signMessage) throw new Error("SIGN_IN_WALLET_UNAVAILABLE")
    const assertWallet = async () => {
      const [addresses, chain] = await Promise.all([client.getAddresses!(), client.getChainId!()])
      if (chain !== request.chainId || !addresses[0] || getAddress(addresses[0]) !== getAddress(request.account)) throw new Error("SIGN_IN_WALLET_MISMATCH")
    }
    await assertWallet()
    const signature = await client.signMessage({ account: request.account, message: request.message })
    await assertWallet()
    return signature
  }
}
