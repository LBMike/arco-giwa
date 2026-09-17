// Public surface of the GIWA Stocks wallet execution panel. Fixtures and the verification page are
// deliberately not exported.
export { StocksWalletExecutionPanel, type StocksWalletExecutionPanelProps } from "./StocksWalletExecutionPanel"
export { StocksWalletPanel, StatusRegion, useStatusAnnouncement, DEFAULT_ARM_DELAY_MS, type StocksWalletPanelProps } from "./StocksWalletPanel"
export { armKeyFor, createActivationGate, startActivation, type ActivationGate, type Arming } from "./activation"
export { useStocksWalletPanel, stocksWalletPanelActions, type ExpectedScope, type StocksWalletPanelBinding, type UseStocksWalletPanelOptions } from "./adapter"
export { executionAvailability, type AvailabilityInput } from "./availability"
export { bindSnapshot, derivePanelModel, IDLE_SNAPSHOT, serverOrderAwaitsTransfer, type PanelAction, type PanelButton, type PanelInput, type PanelKind, type PanelModel } from "./model"
export { describeCode, type CodeDescription, type NextStep } from "./messages"
export type {
  StocksServerOrderStatus,
  StocksWalletAvailability,
  StocksWalletController,
  StocksWalletControllerApi,
  StocksWalletNetwork,
  StocksWalletPanelActions,
} from "./types"
