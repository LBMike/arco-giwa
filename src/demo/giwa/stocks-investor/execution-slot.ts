// Host-provided wallet steps for an accepted order. The investor module renders the slot next to the order
// status and never creates wallet, transport or journal objects itself.

import { createContext, type ReactNode } from "react"

import type { StocksOrder } from "./types"

export type OrderExecutionInput = Readonly<{
  /** The latest server row on screen. The host pins the first row it saw; later rows are server status only. */
  order: StocksOrder
  observedAt: string | null
  refreshing: boolean
  onRefresh: () => void
  /**
   * The customer presentation's one-click trade: a compact wallet step instead of the full panel. `autoStart` is true only
   * for the order the user's own Buy or Sell press has just placed; the host then starts that order's one wallet request
   * (deposit or escrow) once, after its own fresh checks. Absent: the full step-by-step panel.
   */
  instant?: Readonly<{ autoStart: boolean }>
}>

/** Returns null for orders it has nothing to offer for. */
export type OrderExecutionSlot = (input: OrderExecutionInput) => ReactNode

export const OrderExecutionSlotContext = createContext<OrderExecutionSlot | null>(null)
