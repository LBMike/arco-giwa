// Connected panel: the thin controller adapter plus the presentational panel, keyed by scope so no
// local UI state (in-flight gate, arming, focus) survives an account, session or order change. The
// polite status region lives outside that key, so a scope change is announced by the same region.

import { useStocksWalletPanel, type UseStocksWalletPanelOptions } from "./adapter"
import { derivePanelModel } from "./model"
import { StatusRegion, StocksWalletPanel, useStatusAnnouncement, type StocksWalletPanelProps } from "./StocksWalletPanel"

export type StocksWalletExecutionPanelProps = UseStocksWalletPanelOptions &
  Pick<StocksWalletPanelProps, "onRefreshServerOrder" | "serverOrderRefreshing" | "headingLevel" | "armDelayMs">

export function StocksWalletExecutionPanel({ controller, ports, selection, serverOrder = null, tickMs, refreshEvidence, evidenceFailure, unavailableCode, ...display }: StocksWalletExecutionPanelProps) {
  const { scopeKey, ...binding } = useStocksWalletPanel({ controller, ports, selection, serverOrder, tickMs, refreshEvidence, evidenceFailure, unavailableCode })
  const status = useStatusAnnouncement(derivePanelModel({ ...binding, serverOrder }).announcement)
  return (
    <div className="flex w-full flex-col">
      <StocksWalletPanel
        key={scopeKey}
        {...binding}
        {...display}
        serverOrder={serverOrder}
        announce={false}
        onActionSettled={(action) => {
          if (action === "prepare") status.checkFinished()
        }}
      />
      <StatusRegion text={status.text} />
    </div>
  )
}
