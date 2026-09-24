// The explicit recovery of one kept hash, run once per user action.
//
// 1. A NEW submission gate pinned to the current session (the original gate and its expired session are never used).
// 2. inspect(original intentKey): the stored claim of the kept stage must exist with exactly the same claimId,
//    intentKey, stage and transactionDigest; a different stored hash is a conflict and is never overwritten.
// 3. record({...binding, status: SUBMITTED, txHash: original hash}) only when the server has no hash yet; when it
//    already has the same hash, the candidate is RECORDED from that inspect answer.
// 4. reconcile(binding + hash): only the server's trusted receipt check can report CONFIRMED or REVERTED.
//
// It never claims, never opens the wallet, reads no execution policy, evidence or order deadline, and never retries.
// After every await it stops unless the same owner is still shown (alive()), and then it neither reports nor stores.

import type { HostSession } from "../stocks-host/session"
import type { AttemptRecord, SubmissionGate } from "../stocks-wallet/types"
import { createSubmissionGate, type SubmissionClientOptions } from "../stocks-wallet-submissions/client"
import { SubmissionError } from "../stocks-wallet-submissions/validate"
import type { KnownHashCandidate, KnownHashStore } from "./store"

export type RecoveryResult =
  /** The server has the kept hash for the original claim; its receipt is not final yet (not verified). */
  | Readonly<{ kind: "RECORDED_PENDING" }>
  /** The server's trusted receipt check verified the transaction. Not order completion. */
  | Readonly<{ kind: "CONFIRMED" }>
  | Readonly<{ kind: "REVERTED" }>
  /** The server already has another hash for this claim. Nothing was recorded. */
  | Readonly<{ kind: "CONFLICT" }>
  /** The server has no claim for this stage. */
  | Readonly<{ kind: "NO_CLAIM" }>
  /** The stored claim is not the kept hash's claim. */
  | Readonly<{ kind: "BINDING_MISMATCH" }>
  /** The pinned session is no longer usable (expired before a request, or rejected with 401). */
  | Readonly<{ kind: "SESSION_REQUIRED" }>
  | Readonly<{ kind: "SESSION_REJECTED" }>
  /** No answer, a server error or an unreadable answer. The kept hash stays; the user may check again. */
  | Readonly<{ kind: "FAILED"; code: string }>
  /** Another action for this hash is already running. */
  | Readonly<{ kind: "BUSY" }>
  /** The owner on screen changed (or the hash is gone) during the run: nothing is reported or stored. */
  | Readonly<{ kind: "STOPPED" }>

export type RecoverKnownHashOptions = {
  candidate: KnownHashCandidate
  /** The current session, pinned for the whole run. */
  session: HostSession
  apiBase: string
  store: KnownHashStore
  /** True while the same owner (session, wallet, chain, API base, origin) is still shown. Checked after every await. */
  alive: () => boolean
  /** Receives only the pinned session's ID on a 401. */
  onSessionRejected: (capturedSessionId: string) => void
  fetch?: SubmissionClientOptions["fetch"]
  now?: () => number
  monotonicNow?: () => number
  timeoutMs?: number
  /** Test seam; the product always uses createSubmissionGate. */
  createGate?: (options: SubmissionClientOptions) => SubmissionGate
}

const result = <T extends RecoveryResult>(value: T): T => Object.freeze(value)

function failure(error: unknown): RecoveryResult {
  const code = error instanceof SubmissionError ? error.code : "REQUEST_FAILED"
  if (code === "SUBMISSION_AUTH_REQUIRED") return result({ kind: "SESSION_REQUIRED" })
  if (code === "SUBMISSION_AUTH_REJECTED") return result({ kind: "SESSION_REJECTED" })
  // The server answered with a hash other than the kept one.
  if (code === "SUBMISSION_HASH_MISMATCH") return result({ kind: "CONFLICT" })
  if (code === "SUBMISSION_SCOPE_MISMATCH") return result({ kind: "BINDING_MISMATCH" })
  // Includes SUBMISSION_HTTP_ERROR: the adapter does not tell a 409 conflict from other server errors, so an
  // explicit check again (inspect first) decides; nothing is retried here.
  return result({ kind: "FAILED", code })
}

const lower = (value: string | undefined) => (typeof value === "string" ? value.toLowerCase() : undefined)

export async function recoverKnownHash(options: RecoverKnownHashOptions): Promise<RecoveryResult> {
  const { candidate, session, store } = options
  if (!store.begin(candidate.claimId)) return result({ kind: "BUSY" })
  try {
    const live = () => {
      const entry = store.get(candidate.claimId)
      return entry !== null && entry.txHash === candidate.txHash && options.alive()
    }
    const state = store.get(candidate.claimId)?.state.kind
    // A verified or blocked hash offers nothing more; the owner on screen must still be the candidate's.
    if (!live() || (state !== "KEPT" && state !== "RECORDED")) return result({ kind: "STOPPED" })
    // Only the same owner can recover: the session wallet, chain and API base are the candidate's.
    if (lower(session.walletAddress) !== candidate.wallet || session.chainId !== candidate.chainId || options.apiBase !== candidate.apiBase) return result({ kind: "STOPPED" })
    const pinned = Object.freeze({ ...session })
    const binding = Object.freeze({ claimId: candidate.claimId, intentKey: candidate.intentKey, stage: candidate.stage, transactionDigest: candidate.transactionDigest })
    let gate: SubmissionGate
    try {
      gate = (options.createGate ?? createSubmissionGate)({
        session: pinned,
        side: candidate.side,
        orderId: candidate.orderId,
        deploymentDigest: candidate.deploymentDigest,
        apiBase: candidate.apiBase,
        walletAddress: pinned.walletAddress,
        fetch: options.fetch,
        now: options.now,
        monotonicNow: options.monotonicNow,
        timeoutMs: options.timeoutMs,
        // The gate passes its own captured (pinned) session ID; a newer session is never invalidated from here.
        onSessionRejected: (capturedSessionId: string) => {
          try {
            options.onSessionRejected(capturedSessionId)
          } catch {
            /* A failing notification never permits anything. */
          }
        },
      })
    } catch (error) {
      return failure(error)
    }

    function settleFailure(error: unknown): RecoveryResult {
      if (!live()) return result({ kind: "STOPPED" })
      const shown = failure(error)
      if (shown.kind === "CONFLICT" || shown.kind === "BINDING_MISMATCH") store.settle(candidate.claimId, candidate.txHash, { kind: "BLOCKED", reason: shown.kind })
      return shown
    }

    let stored: AttemptRecord | null
    try {
      const prior = await gate.inspect(candidate.intentKey)
      if (!live()) return result({ kind: "STOPPED" })
      stored = candidate.stage === "APPROVAL" ? prior.approval : prior.transfer
    } catch (error) {
      return settleFailure(error)
    }
    if (stored === null) {
      store.settle(candidate.claimId, candidate.txHash, { kind: "BLOCKED", reason: "NO_CLAIM" })
      return result({ kind: "NO_CLAIM" })
    }
    if (stored.claimId !== binding.claimId || stored.intentKey !== binding.intentKey || stored.stage !== binding.stage || stored.transactionDigest !== binding.transactionDigest) {
      store.settle(candidate.claimId, candidate.txHash, { kind: "BLOCKED", reason: "BINDING_MISMATCH" })
      return result({ kind: "BINDING_MISMATCH" })
    }
    if (stored.txHash !== undefined && stored.txHash !== candidate.txHash) {
      store.settle(candidate.claimId, candidate.txHash, { kind: "BLOCKED", reason: "CONFLICT" })
      return result({ kind: "CONFLICT" })
    }
    if (stored.status === "CONFIRMED" || stored.status === "REVERTED") {
      store.settle(candidate.claimId, candidate.txHash, { kind: "VERIFIED", status: stored.status })
      return result({ kind: stored.status })
    }
    // The server's answer already shows this hash on the claim: it is recorded, whatever the receipt check below
    // answers (a verified entry is never overwritten by settle). Nothing is recorded again.
    if (stored.txHash === candidate.txHash) store.settle(candidate.claimId, candidate.txHash, { kind: "RECORDED" })

    try {
      if (stored.txHash === undefined) {
        // Only the original hash, on the original claim binding. The server keeps its first hash for good.
        await gate.record({ ...binding, status: "SUBMITTED", txHash: candidate.txHash as `0x${string}` })
        if (!live()) return result({ kind: "STOPPED" })
        store.settle(candidate.claimId, candidate.txHash, { kind: "RECORDED" })
      }
      if (typeof gate.reconcile !== "function") return result({ kind: "FAILED", code: "TRUSTED_RECONCILIATION_REQUIRED" })
      const verified = await gate.reconcile({ ...binding, txHash: candidate.txHash as `0x${string}` })
      if (!live()) return result({ kind: "STOPPED" })
      if (verified.status === "CONFIRMED" || verified.status === "REVERTED") {
        store.settle(candidate.claimId, candidate.txHash, { kind: "VERIFIED", status: verified.status })
        return result({ kind: verified.status })
      }
      store.settle(candidate.claimId, candidate.txHash, { kind: "RECORDED" })
      return result({ kind: "RECORDED_PENDING" })
    } catch (error) {
      return settleFailure(error)
    }
  } finally {
    store.end(candidate.claimId)
  }
}
