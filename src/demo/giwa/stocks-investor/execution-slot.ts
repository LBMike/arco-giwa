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
}>

/** Returns null for orders it has nothing to offer for. */
export type OrderExecutionSlot = (input: OrderExecutionInput) => ReactNode

export const OrderExecutionSlotContext = createContext<OrderExecutionSlot | null>(null)
