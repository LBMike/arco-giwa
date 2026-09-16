import type { ReactNode } from "react"
import { ARCO_API_BASE } from "../config"
import { useGiwaWallet } from "../wallet"
import { signWithActiveGiwaWallet } from "./active-wallet"
import { StocksHostProvider } from "./StocksHostProvider"

const dependencies = { signMessage: signWithActiveGiwaWallet }

/** Bridge BOTH existing wallet modes; connecting never automatically signs in. */
export function GiwaStocksHost({ children }: { children: ReactNode }) {
  const wallet = useGiwaWallet()
  return (
    <StocksHostProvider
      context={{ walletAddress: wallet.connected ? wallet.address : null, chainId: wallet.chainId, frontendOrigin: window.location.origin, apiBase: ARCO_API_BASE, walletEpoch: wallet.sessionEpoch }}
      signingReady={wallet.signingReady}
      dependencies={dependencies}
    >{children}</StocksHostProvider>
  )
}
