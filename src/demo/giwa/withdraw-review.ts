import { isAddress, parseUnits } from "viem"
import type { HexAddress } from "./types"

// Deposit-vault withdrawTo is a two-step action in the admin console: the operator enters an
// explicit amount and recipient, reviews them, then confirms. An empty amount is an error —
// there is no implicit full-balance withdrawal. The server re-checks the recipient against
// the withdrawal allowlist (ADMIN_WITHDRAW_ALLOWLIST + the product's admin deposit address).

export type WithdrawReview = {
  readonly amountHuman: string
  readonly amountBase: bigint
  readonly to: HexAddress
}

export type WithdrawReviewResult =
  | { readonly ok: true; readonly review: WithdrawReview }
  | { readonly ok: false; readonly error: string }

export function prepareWithdrawReview(input: {
  amount: string
  to: string
  configuredAdminAddress: string | null | undefined
  decimals: number
}): WithdrawReviewResult {
  const amountHuman = input.amount.trim()
  if (!amountHuman) return { ok: false, error: "Enter the amount to withdraw" }
  if (!/^\d+(\.\d+)?$/.test(amountHuman)) return { ok: false, error: "Amount must be a positive number" }
  // parseUnits silently rounds extra fraction digits; refuse them so the reviewed amount is exact.
  const fraction = amountHuman.split(".")[1] ?? ""
  if (fraction.length > input.decimals) return { ok: false, error: `Amount allows at most ${input.decimals} decimals` }
  const amountBase = parseUnits(amountHuman, input.decimals)
  if (amountBase <= 0n) return { ok: false, error: "Amount must be greater than zero" }

  const to = (input.to.trim() || input.configuredAdminAddress?.trim() || "") as HexAddress
  if (!to) return { ok: false, error: "Enter a recipient on the withdrawal allowlist" }
  if (!isAddress(to, { strict: false })) return { ok: false, error: "Recipient must be a valid address" }
  return { ok: true, review: { amountHuman, amountBase, to } }
}
