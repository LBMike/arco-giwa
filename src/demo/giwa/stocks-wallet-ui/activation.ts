// Activation rules for the panel's action buttons, kept free of React so they are covered by the
// default (DOM-less) frontend suite: one action at a time, enabled buttons only, and a wallet-opening
// step only after it has been armed for the exact step on screen.

import type { PanelAction, PanelButton, PanelModel } from "./model"
import type { StocksWalletPanelActions } from "./types"

/**
 * Names the exact wallet-opening step on screen (status, action and intent/order). Null when nothing
 * may arm: no enabled wallet-opening button, an action in flight, or no actions. A different step, a
 * pending action or a new scope therefore never inherits an earlier arming.
 */
export function armKeyFor(model: PanelModel, pending: PanelAction | null, hasActions: boolean): string | null {
  const button = model.buttons.find((candidate) => candidate.opensWallet && candidate.enabled)
  if (!button || pending !== null || !hasActions) return null
  return `${model.kind}|${button.action}|${model.snapshot.intentKey ?? model.order?.orderId ?? ""}`
}

export type Arming = { key: string | null; armed: string | null }

export type ActivationGate = {
  pending(): PanelAction | null
  /** Synchronous: a second activation before React re-renders is refused. */
  begin(button: PanelButton, arming: Arming, actions: StocksWalletPanelActions | null): boolean
  end(): void
}

export function createActivationGate(): ActivationGate {
  let pending: PanelAction | null = null
  return {
    pending: () => pending,
    begin(button, arming, actions) {
      if (actions === null || !button.enabled || pending !== null) return false
      if (button.opensWallet && (arming.key === null || arming.armed !== arming.key)) return false
      pending = button.action
      return true
    },
    end() {
      pending = null
    },
  }
}

/**
 * Runs one explicit activation through the gate. Null when refused. The returned promise settles when
 * the action does; action errors are swallowed because the controller publishes every outcome.
 */
export function startActivation(gate: ActivationGate, button: PanelButton, arming: Arming, actions: StocksWalletPanelActions | null): Promise<void> | null {
  if (!gate.begin(button, arming, actions)) return null
  let result: unknown
  try {
    result = actions![button.action]()
  } catch {
    result = undefined
  }
  return Promise.resolve(result)
    .catch(() => undefined)
    .then(() => gate.end())
}
