// Wraps an owner's original submission gate so that a transaction hash its original wallet request returned is kept
// when that original gate cannot record it (its session expired or was rejected, or the request failed).
//
// Every call goes to the original gate unchanged and its own promise is returned: an expired session's refusal, a
// 401 or a timeout reaches the controller exactly as before. Nothing here authenticates, records, retries or adopts
// another session. A kept hash is only ever recorded later by the user's explicit recovery action (recover.ts).

import type { AttemptRecord, Side, Stage, SubmissionGate } from "../stocks-wallet/types"
import type { KnownHashStore } from "./store"

/** The original owner's fixed scope: order, deployment, wallet, chain, API base and frontend origin. */
export type KnownHashCaptureScope = Readonly<{
  side: Side
  orderId: string
  deploymentDigest: string
  wallet: string
  chainId: number
  apiBase: string
  origin: string
}>

type Binding = Readonly<{ claimId: string; intentKey: string; stage: Stage; transactionDigest: string }>

function bindingOf(value: unknown): Binding | null {
  if (value === null || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (typeof row.claimId !== "string" || typeof row.intentKey !== "string" || typeof row.transactionDigest !== "string") return null
  if (row.stage !== "APPROVAL" && row.stage !== "TRANSFER") return null
  return Object.freeze({ claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest })
}

const sameBinding = (a: Binding, b: Binding) => a.claimId === b.claimId && a.intentKey === b.intentKey && a.stage === b.stage && a.transactionDigest === b.transactionDigest

export function captureKnownHashes(gate: SubmissionGate, scope: KnownHashCaptureScope, store: KnownHashStore): SubmissionGate {
  const fixed = Object.freeze({ ...scope })
  /** Claims this original gate actually won (REQUEST_MAY_START for this order and deployment), by stage. */
  const won = new Map<Stage, Binding>()

  function candidateFor(input: AttemptRecord): Record<string, unknown> | null {
    // Only a SUBMITTED outcome carries a hash the wallet returned; UNKNOWN (no answer, an error or an invalid
    // answer) is never a candidate, and neither is a record for a claim this gate did not win.
    if (input === null || typeof input !== "object" || input.status !== "SUBMITTED" || typeof input.txHash !== "string") return null
    const binding = bindingOf(input)
    const claimed = binding ? won.get(binding.stage) : undefined
    if (!binding || !claimed || !sameBinding(binding, claimed)) return null
    return { ...binding, side: fixed.side, orderId: fixed.orderId, deploymentDigest: fixed.deploymentDigest, wallet: fixed.wallet, chainId: fixed.chainId, apiBase: fixed.apiBase, origin: fixed.origin, txHash: input.txHash }
  }

  const wrapped: SubmissionGate = {
    inspect: (intentKey: string) => gate.inspect(intentKey),
    claim(input: Parameters<SubmissionGate["claim"]>[0]) {
      const pending = gate.claim(input)
      pending.then(
        (result) => {
          const binding = bindingOf(result)
          if (result && binding && result.status === "REQUEST_MAY_START" && !result.txHash && input.orderId === fixed.orderId && input.deploymentDigest === fixed.deploymentDigest && input.stage === binding.stage && input.intentKey === binding.intentKey && input.transactionDigest === binding.transactionDigest && !won.has(binding.stage)) {
            won.set(binding.stage, binding)
          }
        },
        () => undefined,
      )
      return pending
    },
    record(input: AttemptRecord) {
      let candidate: Record<string, unknown> | null = null
      try {
        candidate = candidateFor(input)
      } catch {
        candidate = null // Capture never changes what the original gate does.
      }
      const pending = gate.record(input)
      if (candidate !== null) {
        const kept = candidate
        // Kept only when the ORIGINAL gate could not record it. A completed original record leaves nothing to recover.
        pending.then(
          () => undefined,
          () => {
            try {
              store.remember(kept)
            } catch {
              /* The original failure is what the controller sees either way. */
            }
          },
        )
      }
      return pending
    },
  }
  if (typeof gate.reconcile === "function") wrapped.reconcile = (input) => gate.reconcile!(input)
  return Object.freeze(wrapped)
}
