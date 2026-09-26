// The Savings / Funds transaction modal, rendered once per page from useGiwaProductOperation's flow. The product detail
// page has two panels (the desktop aside and the mobile sheet) but one flow, so one modal.

import { GiwaBrandMark } from "./components"
import { operationFlowView, type OperationFlow } from "./operation-flow"
import { TransactionFlowModal } from "./TransactionFlowModal"
import { explorerTx } from "./wallet"

export function GiwaOperationModal({ flow, onClose, onRetry }: { flow: OperationFlow | null; onClose: () => void; onRetry: () => void }) {
  if (flow === null || !flow.open) return null
  const view = operationFlowView(flow)
  const { pay, receive } = flow.review
  const mark = (src: string | null, label: string, size: number) => <GiwaBrandMark src={src ?? undefined} label={label} size={size} />
  return (
    <TransactionFlowModal
      open
      dismissible={flow.outcome !== null}
      title={view.title}
      pay={{ caption: view.payCaption, amount: pay.amount, symbol: pay.symbol, sub: pay.sub, icon: mark(pay.icon, pay.symbol, 40) }}
      receive={{ caption: view.receiveCaption, amount: receive.amount, symbol: receive.symbol, sub: receive.sub, icon: mark(receive.icon, receive.symbol, 40) }}
      steps={view.steps.map((step) => ({ ...step, icon: step.token === "pay" ? mark(pay.icon, pay.symbol, 28) : mark(receive.icon, receive.symbol, 28) }))}
      result={
        view.result === null
          ? null
          : {
              tone: view.result.tone,
              title: view.result.title,
              message: view.result.message,
              from: { ...view.result.from, icon: mark(pay.icon, pay.symbol, 16) },
              to: view.result.to === null ? null : { ...view.result.to, icon: mark(receive.icon, receive.symbol, 16) },
              explorerHref: explorerTx(view.result.hash),
            }
      }
      error={view.error}
      onClose={onClose}
      onRetry={view.error === null ? null : onRetry}
    />
  )
}
