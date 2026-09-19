// Presentational card for one kept hash on the order it belongs to. It shows only the owner's own order stage and
// hash, offers exactly one explicit action per state, and never claims that a receipt completes the order.

import { BUTTON_SECONDARY, Notice, TEXT_SECONDARY } from "../stocks-investor/ui"
import type { KnownHashEntry } from "./store"
import type { RecoveryResult } from "./recover"

export type KnownHashRecoveryCardProps = {
  entry: KnownHashEntry
  /** The result of this card's last explicit action, if it is still on screen. */
  lastResult: RecoveryResult | null
  onRecover: () => void
}

function stepWord(entry: KnownHashEntry): string {
  if (entry.stage === "APPROVAL") return "approval"
  return entry.side === "SELL" ? "escrow" : "deposit"
}

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/**
 * The transaction behind a kept hash was already sent by the wallet: never this step again, whatever this card shows.
 * Only the card's own step: an approval card never tells the user not to send the deposit or escrow the order still needs.
 */
const neverAgain = (step: string) => `The ${step} transaction behind this hash was already sent. Do not send this ${step} again from this or any other app or wallet.`
const operations = (step: string) => `Do not send this ${step} again from this or any other app or wallet. Contact operations to confirm what happened.`

type Copy = Readonly<{ tone: "action" | "warning" | "info" | "success" | "error"; paragraphs: readonly string[]; action: string | null }>

function copyFor(entry: KnownHashEntry, last: RecoveryResult | null): Copy {
  const step = stepWord(entry)
  const state = entry.state
  if (state.kind === "VERIFIED") {
    if (state.status === "REVERTED") return { tone: "error", action: null, paragraphs: [`The server found that this ${step} transaction reverted. This page did not send it again.`, "Do not repeat it from another app or wallet. Contact operations if the order stays unresolved."] }
    return {
      tone: "success",
      action: null,
      paragraphs: entry.stage === "APPROVAL"
        ? ["The server verified this approval's receipt for the order's request.", "An approval does not fund or complete the order. The order status shows the result, and the separate deposit or escrow step still follows the order's own rules and deadline."]
        : [`The server verified this ${step}'s receipt for the order's request.`, "This is not the order result. Only the order status shows the result."],
    }
  }
  if (state.kind === "BLOCKED") {
    return state.reason === "CONFLICT"
      ? { tone: "error", action: null, paragraphs: ["The server already has a different transaction hash for this request, so this hash was not recorded.", operations(step)] }
      : { tone: "error", action: null, paragraphs: ["The server's request for this order does not match this hash, so nothing was recorded.", operations(step)] }
  }
  const paragraphs: string[] = []
  if (state.kind === "RECORDED") paragraphs.push(`The server has recorded this ${step} hash for the order's request. Its receipt is not verified yet, so the transaction is not confirmed.`)
  else paragraphs.push(`Your wallet returned this ${step} transaction hash, but it could not be recorded on the server at the time (for example because the Stocks session had ended), so the server may not have it.`, "Recording it sends nothing from your wallet. It adds this hash to the request the server already has for this order, then asks the server to check its receipt.")
  // Until recorded, the order's own check reads the server's claim without a hash and may show the result as unknown.
  if (state.kind === "KEPT") paragraphs.push("Until this hash is recorded, the order's own check may show the result as unknown.")
  // About this recovery action only: it never opens the wallet.
  // - KEPT: the record request itself may or may not have reached the server, so both outcomes stay possible.
  // - RECORDED: the server already has the hash (the store moves to RECORDED only from a server answer); only the
  //   receipt check failed, so the hash stays recorded and only the receipt is still unknown.
  if (last?.kind === "FAILED") {
    paragraphs.push(state.kind === "RECORDED"
      ? `The receipt check could not be completed: the server's answer did not arrive or was an error. The ${step} hash stays recorded on the server, and this check did not open your wallet. Check the receipt again to see whether it is verified.`
      : "The server's answer did not arrive or was an error, so it may or may not have recorded the hash. This did not open your wallet. Check again to see what the server has.")
  }
  if (last?.kind === "SESSION_REQUIRED" || last?.kind === "SESSION_REJECTED") paragraphs.push("Your Stocks session can no longer be used for this. Sign in again with the same wallet to continue.")
  paragraphs.push(neverAgain(step))
  paragraphs.push("This hash is kept only in this tab's memory. Reloading or closing the page loses it.")
  const sessionEnded = last?.kind === "SESSION_REQUIRED" || last?.kind === "SESSION_REJECTED"
  const action = sessionEnded ? null : state.kind === "RECORDED" ? "Check the receipt again" : last?.kind === "FAILED" ? "Check again" : "Record this hash"
  return { tone: state.kind === "RECORDED" ? "info" : "action", action, paragraphs }
}

export function KnownHashRecoveryCard({ entry, lastResult, onRecover }: KnownHashRecoveryCardProps) {
  const copy = copyFor(entry, lastResult)
  const title = `${capitalized(stepWord(entry))} hash kept in this tab`
  return (
    <div className="w-full" data-testid="stocks-known-hash-recovery" data-state={entry.state.kind === "VERIFIED" ? `VERIFIED_${entry.state.status}` : entry.state.kind === "BLOCKED" ? `BLOCKED_${entry.state.reason}` : entry.state.kind} data-claim-stage={entry.stage}>
      <Notice tone={copy.tone} title={title} announce={lastResult ? "polite" : undefined}>
        <p>{copy.paragraphs[0]}</p>
        <p className={`mt-2 break-all font-mono text-xs ${TEXT_SECONDARY}`}>
          Transaction hash: <span data-testid="stocks-known-hash-value">{entry.txHash}</span>
        </p>
        {copy.paragraphs.slice(1).map((paragraph) => (
          <p key={paragraph} className="mt-2">
            {paragraph}
          </p>
        ))}
        {copy.action ? (
          <button type="button" className={`${BUTTON_SECONDARY} mt-3`} data-action="record-known-hash" disabled={entry.busy} aria-busy={entry.busy || undefined} onClick={onRecover}>
            {entry.busy ? "Checking with the server…" : copy.action}
          </button>
        ) : null}
      </Notice>
    </div>
  )
}
