// Wallet commands the app shell can offer to Stocks pages (connect, switch to GIWA Sepolia). Provided by GiwaStocksHost
// from the app's wallet; pages mounted without it (verification pages, harnesses) get null and show a hint instead.
import { createContext, useContext } from "react"

export type StocksWalletCommands = {
  connect?: () => void
  switchNetwork?: () => void
}

export const StocksWalletCommandsContext = createContext<StocksWalletCommands | null>(null)
export const useStocksWalletCommands = () => useContext(StocksWalletCommandsContext)
