// admin-access.ts — pure allowlist helpers for the GIWA admin VISIBILITY gate.
//
// IMPORTANT: this is a VISIBILITY gate, NOT security. The real protection already
// exists — the server checks requireOperator (x-operator-token) on every admin
// endpoint, and signing requires the on-chain FEED_ADMIN_ROLE. These helpers only
// decide whether to SHOW the admin UI/nav to a connected wallet; they grant no access
// and a determined user can still call the API directly (which the server rejects).
//
// No React, no I/O — deterministic and unit-testable under `npm run test:frontend`.
import { getAddress, isAddress } from "viem"

/** Parse a comma-separated allowlist into a Set of lowercased, validated addresses. */
export function parseAdminAddresses(raw: string): Set<string> {
  const allow = new Set<string>()
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (!trimmed || !isAddress(trimmed)) continue
    allow.add(getAddress(trimmed).toLowerCase())
  }
  return allow
}

/**
 * True only when `address` is a valid address present in `allow`. Fail-closed: null,
 * malformed input, or an empty allowlist all return false.
 */
export function isAdminAddress(address: string | null, allow: Set<string>): boolean {
  if (!address || !isAddress(address)) return false
  return allow.has(getAddress(address).toLowerCase())
}
