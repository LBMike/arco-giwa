import type { GiwaRedemption, GiwaReserveRecall } from "./types"

// ArcoUSD Reserve recalls in Vault Management (docs/specs/arcousd-v1.md §5). A recall is the
// Reserve redeeming its own MMF shares, so it shows up among the user withdrawals. It is paid the
// same way, but then needs one Reserve step the console must not let anyone miss:
//   paid by direct transfer → Acknowledge (else the Reserve counts the amount twice);
//   fulfilled in the vault  → Claim (moves the funds from the vault into the Reserve).

export function isReserveRecall(row: Pick<GiwaRedemption, "kind">): boolean {
  return row.kind === "arcousd-recall"
}

/** Recalls of one product the operator must act on or look at (actions, warnings, read errors). */
export function recallsNeedingAttention(recalls: readonly GiwaReserveRecall[], productId: string): GiwaReserveRecall[] {
  return recalls.filter(
    (recall) =>
      recall.productId === productId &&
      (recall.action !== null || recall.warning !== null || recall.error !== null || recall.state === "unknown"),
  )
}

/** Header badge for a vault card: an action outranks a mere "look at this". */
export function recallBadge(attention: readonly GiwaReserveRecall[]): string | null {
  if (attention.some((recall) => recall.action !== null)) return "ArcoUSD recall: action needed"
  if (attention.length > 0) return "ArcoUSD recall: check state"
  return null
}

/** Per-recall action state key: a later, different action on the same request starts fresh. */
export function recallActionKey(recall: Pick<GiwaReserveRecall, "requestId" | "action">): string {
  return `${recall.requestId}:${recall.action ?? "none"}`
}

/** Why recall states cannot be trusted right now (registry invalid, API failure), if so. */
export function recallsUnavailableReason(
  data: { status: string; error?: string } | undefined,
  queryError: unknown,
): string | null {
  // A server without the route (older API): no recalls to show, not an error.
  if ((queryError as { status?: unknown } | null)?.status === 404) return null
  if (queryError) return `Could not load ArcoUSD recalls: ${queryError instanceof Error ? queryError.message : String(queryError)}`
  if (data?.status === "unavailable") return `ArcoUSD recall state unavailable: ${data.error ?? "unknown reason"}`
  return null
}

export function recallActionLabel(action: GiwaReserveRecall["action"]): string | null {
  if (action === "acknowledge") return "Acknowledge"
  if (action === "claim") return "Claim"
  return null
}

export function recallStateLabel(recall: Pick<GiwaReserveRecall, "state">): string {
  switch (recall.state) {
    case "requested":
      return "Not paid yet"
    case "settling":
      return "Payout in flight"
    case "awaiting-acknowledgement":
      return "Paid · awaiting acknowledgement"
    case "claimable":
      return "Fulfilled · ready to claim"
    case "done":
      return "Done"
    default:
      return "State unavailable"
  }
}
