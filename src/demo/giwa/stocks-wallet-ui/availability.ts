// Which configuration or evidence is missing before an action may be offered. Synchronous and free of
// I/O: it reads only the host's synchronous context snapshot and clock, never a wallet, API or journal.
// A missing port, session, reviewed deployment or valid accepted order disables execution; nothing
// here supplies a default for any of them.

import { planOrder, StocksWalletError } from "../stocks-wallet/planner"
import type { ExecutionContext, Selection, WalletPorts } from "../stocks-wallet/types"
import type { StocksWalletAvailability } from "./types"

const REQUIRED_PORTS = ["context", "readWallet", "readOrder", "readCatalog", "readAllowance", "requestTransaction"] as const

function unavailable(code: string): StocksWalletAvailability {
  return Object.freeze({ status: "UNAVAILABLE", code })
}

export type AvailabilityInput = {
  /** False when the host has no wallet controller for this scope. */
  configured: boolean
  ports: Partial<WalletPorts> | null
  context: ExecutionContext | null
  selection: Selection | null
  now: number
}

export function executionAvailability({ configured, ports, context, selection, now }: AvailabilityInput): StocksWalletAvailability {
  if (!configured || !ports || REQUIRED_PORTS.some((name) => typeof ports[name] !== "function")) return unavailable("NOT_CONFIGURED")
  if (typeof ports.readExecutionPolicy !== "function") return unavailable("CURRENT_POLICY_REQUIRED")
  const gate = ports.submissions
  if (!gate || typeof gate.inspect !== "function" || typeof gate.claim !== "function" || typeof gate.record !== "function") return unavailable("DURABLE_SUBMISSION_GATE_REQUIRED")
  // Without trusted server reconciliation an approval can never be confirmed: fail closed up front.
  if (typeof gate.reconcile !== "function") return unavailable("TRUSTED_RECONCILIATION_REQUIRED")
  if (!context) return unavailable("NOT_CONFIGURED")
  if (!context.session) return unavailable("SESSION_REQUIRED")
  if (!selection) return unavailable("ORDER_REQUIRED")
  try {
    // Pure planner validation: session lifetime, reviewed deployment evidence, wallet/order scope,
    // payable state, order key, exact price formula and quote deadline.
    return Object.freeze({ status: "READY", plan: planOrder(selection, context, now) })
  } catch (error) {
    return unavailable(error instanceof StocksWalletError ? error.code : "INVALID_CONTEXT")
  }
}
