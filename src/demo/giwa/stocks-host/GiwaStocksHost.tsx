import { useMemo, type ReactNode } from "react"
import { ARCO_API_BASE } from "../config"
import { useGiwaWallet } from "../wallet"
import { signWithActiveGiwaWallet } from "./active-wallet"
import { StocksHostProvider } from "./StocksHostProvider"
import { StocksWalletCommandsContext } from "./wallet-commands"

const dependencies = { signMessage: signWithActiveGiwaWallet }

/** Bridge BOTH existing wallet modes; connecting never automatically signs in. */
export function GiwaStocksHost({ children }: { children: ReactNode }) {
  const wallet = useGiwaWallet()
  // Explicit user actions only (the Stocks trade panel's Connect / Switch buttons); never run on render.
  const { connect, switchToGiwa } = wallet
  const commands = useMemo(() => ({ connect: () => void connect().catch(() => {}), switchNetwork: () => void switchToGiwa().catch(() => {}) }), [connect, switchToGiwa])
  return (
    <StocksWalletCommandsContext.Provider value={commands}>
    <StocksHostProvider
      context={{ walletAddress: wallet.connected ? wallet.address : null, chainId: wallet.chainId, frontendOrigin: window.location.origin, apiBase: ARCO_API_BASE, walletEpoch: wallet.sessionEpoch }}
      signingReady={wallet.signingReady}
      walletSource={wallet.source}
      dependencies={dependencies}
    >{children}</StocksHostProvider>
    </StocksWalletCommandsContext.Provider>
  )
}
