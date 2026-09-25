import { getAddress, type Address, type Hex } from "viem"
import { parseSiweMessage } from "viem/siwe"
import type { MessageRequest } from "./session"
import { WalletSignInError, walletConnectFailure, walletSignatureFailure } from "./sign-in-errors"

export type MessageWallet = {
  getAddresses?: () => Promise<readonly string[]>
  /** eth_requestAccounts: the wallet's own "connect this site" prompt. Used only when the site has no account. */
  requestAddresses?: () => Promise<readonly string[]>
  getChainId?: () => Promise<number>
  signMessage?: (request: { account: Address; message: string }) => Promise<Hex>
}

/**
 * Accepts the existing active injected or Dynamic client. No transaction. The wallet module can keep showing an account
 * after the wallet itself stopped exposing it to this site (locked, or the site disconnected in the wallet); only then,
 * before the signature, the wallet is asked to connect the site again.
 */
export function createWalletMessageSigner(getClient: () => MessageWallet) {
  return async (request: MessageRequest): Promise<string> => {
    const message = parseSiweMessage(request.message)
    if (request.chainId !== 91342 || message.chainId !== 91342 || !message.address || getAddress(message.address) !== getAddress(request.account)) throw new WalletSignInError("SIGN_IN_WALLET_MISMATCH")
    let client: MessageWallet
    try { client = getClient() } catch { throw new WalletSignInError("SIGN_IN_WALLET_UNAVAILABLE") }
    if (!client.getAddresses || !client.getChainId || !client.signMessage) throw new WalletSignInError("SIGN_IN_WALLET_UNAVAILABLE")
    const assertWallet = async (reconnect: boolean) => {
      let addresses: readonly string[], chain: number
      try { [addresses, chain] = await Promise.all([client.getAddresses!(), client.getChainId!()]) }
      catch { throw new WalletSignInError("SIGN_IN_WALLET_UNAVAILABLE") }
      if (!Array.isArray(addresses)) throw new WalletSignInError("SIGN_IN_WALLET_UNAVAILABLE")
      if (!addresses[0] && reconnect && client.requestAddresses) {
        try { addresses = await client.requestAddresses() }
        catch (error) { throw walletConnectFailure(error) }
      }
      if (!Array.isArray(addresses) || !addresses[0]) throw new WalletSignInError("SIGN_IN_WALLET_DISCONNECTED")
      if (chain !== request.chainId || getAddress(addresses[0]) !== getAddress(request.account)) throw new WalletSignInError("SIGN_IN_WALLET_MISMATCH")
    }
    await assertWallet(true)
    let signature: Hex
    try { signature = await client.signMessage({ account: request.account, message: request.message }) }
    catch (error) { throw walletSignatureFailure(error) }
    await assertWallet(false)
    return signature
  }
}
