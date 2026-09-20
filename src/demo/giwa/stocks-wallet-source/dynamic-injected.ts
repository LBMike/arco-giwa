import { EthereumInjectedConnector } from "@dynamic-labs/ethereum"
import type { Eip1193Provider } from "./types"

/** Resolve only the extension selected by Dynamic. Never unwrap a viem client,
 * use the MetaMask mobile SDK request wrapper, or fall back to window.ethereum.
 * Login continues through Dynamic; Stocks sends directly to this raw provider.
 */
export function selectedDynamicInjectedProvider(wallet: { connector?: unknown } | null | undefined): Eip1193Provider | null {
  try {
    const connector = wallet?.connector
    if (!(connector instanceof EthereumInjectedConnector) || !connector.isInstalledOnBrowser()) return null
    const provider = connector.ethProviderHelper?.getInstalledProvider()
    if (!provider || typeof provider.request !== "function" || typeof provider.on !== "function" || typeof provider.removeListener !== "function") return null
    return provider as Eip1193Provider
  } catch { return null }
}
