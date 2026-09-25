// The one-time approval of the customer presentation's one-click trade, like the Savings and Funds panels' "Approve":
// the wallet lets the verified Stocks deployment's funding vault take its tUSDC (Buy), or its redemption escrow take its
// NVDA (Sell), with an unlimited allowance given once. Both contracts only ever take from the wallet that calls them
// (depositForOrder / escrowForOrder pull from msg.sender), so the allowance lets nobody else move the wallet's tokens.
// Every trade is still its own wallet request. Nothing here quotes, orders, deposits or escrows.
import { useCallback, useEffect, useRef, useState } from "react"
import { getAddress, maxUint256, type Hex } from "viem"
import { approveVault, publicGiwaClient } from "../contracts"
import { walletSignatureFailure } from "../stocks-host/sign-in-errors"

/** The unlimited allowance Savings and Funds also give their vaults: one approval covers every later trade. */
export const UNLIMITED_ALLOWANCE = maxUint256

export type TokenApprovalState =
  | { status: "idle" }
  | { status: "wallet" }
  | { status: "pending"; hash: Hex }
  | { status: "confirmed"; hash: Hex }
  | { status: "error"; code: TokenApprovalCode }
export type TokenApprovalCode = "WALLET_REQUEST_REJECTED" | "WALLET_REQUEST_PENDING" | "APPROVAL_FAILED" | "APPROVAL_REVERTED" | "APPROVAL_RECEIPT_TIMEOUT"

const RECEIPT_POLL_MS = 1_000
const RECEIPT_ATTEMPTS = 90

export function approvalMessage(code: TokenApprovalCode, symbol: string): string {
  switch (code) {
    case "WALLET_REQUEST_REJECTED": return `The ${symbol} approval was declined in your wallet. Approve again to continue.`
    case "WALLET_REQUEST_PENDING": return "A wallet request is already open. Complete or cancel it in your wallet, then approve again."
    case "APPROVAL_REVERTED": return `The ${symbol} approval failed on GIWA. Check the wallet's test ETH for gas, then approve again.`
    case "APPROVAL_RECEIPT_TIMEOUT": return `The ${symbol} approval was sent but GIWA has not confirmed it yet. Refresh the balance in a moment; approve again only if it stays missing.`
    default: return "The wallet could not send the approval. Unlock your wallet and try again."
  }
}

/**
 * One approval at a time, from the user's own press. The receipt is read with eth_getTransactionReceipt (the local read
 * gateway, like any JSON-RPC relay, may refuse viem's parameterless block polling); GIWA's receipt is the confirmation.
 * `onConfirmed` re-reads the allowance.
 */
export function useStocksTokenApproval(onConfirmed: () => void) {
  const [state, setState] = useState<TokenApprovalState>({ status: "idle" })
  const mounted = useRef(true)
  const running = useRef(false)
  const done = useRef(onConfirmed)
  done.current = onConfirmed
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const approve = useCallback(async (input: { owner: string; token: string; spender: string }) => {
    if (running.current) return
    running.current = true
    try {
      setState({ status: "wallet" })
      let hash: Hex
      try {
        hash = await approveVault({ account: getAddress(input.owner), token: getAddress(input.token), vault: getAddress(input.spender), amount: UNLIMITED_ALLOWANCE })
      } catch (error) {
        const code = walletSignatureFailure(error).code
        if (mounted.current) setState({ status: "error", code: code === "WALLET_REQUEST_REJECTED" || code === "WALLET_REQUEST_PENDING" ? code : "APPROVAL_FAILED" })
        return
      }
      if (!mounted.current) return
      setState({ status: "pending", hash })
      for (let attempt = 0; attempt < RECEIPT_ATTEMPTS && mounted.current; attempt += 1) {
        const receipt = await publicGiwaClient.getTransactionReceipt({ hash }).catch(() => null)
        if (receipt) {
          if (!mounted.current) return
          if (receipt.status === "success") { setState({ status: "confirmed", hash }); done.current() }
          else setState({ status: "error", code: "APPROVAL_REVERTED" })
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, RECEIPT_POLL_MS))
      }
      if (mounted.current) setState({ status: "error", code: "APPROVAL_RECEIPT_TIMEOUT" })
    } finally {
      running.current = false
    }
  }, [])
  const reset = useCallback(() => setState({ status: "idle" }), [])
  return { state, approve, reset }
}
