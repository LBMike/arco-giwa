import { activeWalletSource } from "../contracts"
import type { ActiveWalletSource, WalletSourceView } from "./types"

/** Maps the wallet provider tree's context value; the epoch is its existing sessionEpoch. */
export function activeWalletSourceView(wallet: { source: ActiveWalletSource | null; address: string | null; chainId: number | null; sessionEpoch: string }): WalletSourceView {
  return Object.freeze({ source: wallet.source, address: wallet.address, chainId: wallet.chainId, epoch: wallet.sessionEpoch })
}

/** The module-level active source, for `captureWalletSource(view, { activeSource })`. Never throws. */
export function currentActiveWalletSource(): ActiveWalletSource | null {
  try { return activeWalletSource() } catch { return null }
}
