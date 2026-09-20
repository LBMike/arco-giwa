import type { StocksInvestorController } from "./controller"
import type { StocksOrder, StocksSide } from "./types"

/** Everything a view may ask for. Views never call the client directly. */
export type StocksInvestorActions = {
  retryCatalog: () => void
  setSide: (side: StocksSide) => void
  /** The panel's own sign-in press: keep the side the user chose through that one sign-in. Requests nothing. */
  noteSignInIntent: () => void
  setQuantity: (input: string) => void
  requestQuote: () => void
  discardQuote: () => void
  placeOrder: () => void
  retryOrder: () => void
  checkOrder: () => void
  startNewOrder: () => void
  refreshAttemptOrder: () => void
  loadOrders: () => void
  selectOrder: (order: StocksOrder | null) => void
  refreshSelectedOrder: () => void
  loadPortfolio: () => void
}

export function actionsFor(controller: StocksInvestorController): StocksInvestorActions {
  return {
    retryCatalog: () => void controller.loadCatalog(),
    setSide: (side) => controller.setSide(side),
    noteSignInIntent: () => controller.noteSignInIntent(),
    setQuantity: (input) => controller.setQuantity(input),
    requestQuote: () => void controller.requestQuote(),
    discardQuote: () => controller.discardQuote(),
    placeOrder: () => void controller.placeOrder(),
    retryOrder: () => void controller.retryOrder(),
    checkOrder: () => void controller.checkOrder(),
    startNewOrder: () => controller.startNewOrder(),
    refreshAttemptOrder: () => void controller.refreshAttemptOrder(),
    loadOrders: () => void controller.loadOrders(),
    selectOrder: (order) => controller.selectOrder(order),
    refreshSelectedOrder: () => void controller.refreshSelectedOrder(),
    loadPortfolio: () => void controller.loadPortfolio(),
  }
}
