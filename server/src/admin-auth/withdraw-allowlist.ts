import { isAddress } from "viem"

export const INVALID_ADMIN_WITHDRAW_ALLOWLIST =
  "ADMIN_WITHDRAW_ALLOWLIST must be a comma-separated list of EVM addresses"

/**
 * ADMIN_WITHDRAW_ALLOWLIST: comma-separated treasury/multisig addresses that may receive a
 * deposit-vault withdrawTo, in addition to each product's configured adminDepositAddress.
 * Unset or blank means no env entries (only configured adminDepositAddress values qualify).
 * Returns lowercased, de-duplicated addresses. Never echoes the configured value on error.
 */
export function parseAdminWithdrawAllowlist(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return []
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean)
  const out = new Set<string>()
  for (const entry of entries) {
    if (!isAddress(entry, { strict: false })) throw new Error(INVALID_ADMIN_WITHDRAW_ALLOWLIST)
    if (/^0x0{40}$/i.test(entry)) throw new Error(INVALID_ADMIN_WITHDRAW_ALLOWLIST)
    out.add(entry.toLowerCase())
  }
  return [...out]
}

/**
 * The recipients allowed for one product's withdrawTo: the env allowlist plus that product's
 * configured adminDepositAddress (Vault Config). Empty means every recipient is refused.
 */
export function allowedWithdrawRecipients(
  envAllowlist: readonly string[] | undefined,
  adminDepositAddress: string | null | undefined,
): Set<string> {
  const allowed = new Set((envAllowlist ?? []).map((address) => address.toLowerCase()))
  if (adminDepositAddress && isAddress(adminDepositAddress, { strict: false })) {
    allowed.add(adminDepositAddress.toLowerCase())
  }
  return allowed
}
