// Host contract for the GIWA Stocks wallet execution panel. Presentation only: the wallet controller
// in ../stocks-wallet owns every read, durable claim and wallet request.

import type { createStocksWalletController } from "../stocks-wallet/controller"
import type { Plan, Side } from "../stocks-wallet/types"

export type StocksWalletController = ReturnType<typeof createStocksWalletController>

/** The controller surface the panel adapter uses. `cancel` and `dispose` stay with the owning host. */
export type StocksWalletControllerApi = Pick<StocksWalletController, "select" | "refreshContext" | "getSnapshot" | "subscribe" | "prepare" | "approve" | "submit">

/**
 * Explicit user actions. The panel calls each one only when the user activates its enabled button:
 * never from render, an effect, a timer, polling or a state change.
 */
export type StocksWalletPanelActions = {
  /** Read-only execution check, also used to check a submitted approval or transaction record. Never opens the wallet. */
  prepare(): Promise<void> | void
  /** Exact approval for the accepted order. */
  approve(): Promise<void> | void
  /** Deposit (BUY) or escrow (SELL). Always its own click after the approval step. */
  submit(): Promise<void> | void
}

/**
 * The server's order row state, read by the host separately from the wallet flow (for example the
 * investor client's `getOrder`). This is the only source for the order result: a transaction hash
 * or a confirmed approval never means the order is complete or that holdings changed.
 */
export type StocksServerOrderStatus = Readonly<{ orderId: string; side: Side; state: string; observedAt: string | null }>

/**
 * Local, I/O-free precondition result. READY only means nothing is visibly missing; the controller
 * repeats every check with fresh authenticated reads before any wallet request.
 */
export type StocksWalletAvailability = Readonly<{ status: "READY"; plan: Plan }> | Readonly<{ status: "UNAVAILABLE"; code: string }>

/** Reviewed deployment identity shown in the summary. Only populated from a locally validated plan. */
export type StocksWalletNetwork = Readonly<{ networkInstance: string; deploymentId: string }>
