// Connected panel: the thin controller adapter plus the presentational panel, keyed by scope so no
// local UI state (in-flight lock, arming, focus) survives an account, session or order change.

import { useStocksWalletPanel, type UseStocksWalletPanelOptions } from "./adapter"
import { StocksWalletPanel, type StocksWalletPanelProps } from "./StocksWalletPanel"

export type StocksWalletExecutionPanelProps = UseStocksWalletPanelOptions &
  Pick<StocksWalletPanelProps, "serverOrder" | "onRefreshServerOrder" | "serverOrderRefreshing" | "headingLevel" | "armDelayMs">

export function StocksWalletExecutionPanel({ controller, ports, selection, tickMs, ...display }: StocksWalletExecutionPanelProps) {
  const { scopeKey, ...binding } = useStocksWalletPanel({ controller, ports, selection, tickMs })
  return <StocksWalletPanel key={scopeKey} {...binding} {...display} />
}
