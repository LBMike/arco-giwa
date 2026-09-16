import { walletClient } from "../contracts"
import { createWalletMessageSigner } from "./wallet-bridge"

/** Uses the same active wallet source as existing GIWA flows, on an explicit login action. */
export const signWithActiveGiwaWallet = createWalletMessageSigner(() => walletClient())
