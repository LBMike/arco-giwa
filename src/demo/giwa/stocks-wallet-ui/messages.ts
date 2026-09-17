// Reason and next step for every stable code the wallet planner, controller or local availability
// check can report. Codes stay visible for support; provider messages never reach this screen.

import type { Side } from "../stocks-wallet/types"

/**
 * CHECK_AGAIN: an explicit read-only check may succeed later.
 * SIGN_IN / SWITCH_WALLET / SWITCH_NETWORK: the host must change something first.
 * NEW_QUOTE: this order can no longer be funded or escrowed.
 * SERVER_STATUS: the server's order state decides what happens.
 * RECOVERY: a recorded wallet request needs a server/operations check; nothing is retried here.
 * CONFIGURATION: execution stays disabled until the app is configured with reviewed inputs.
 */
export type NextStep = "CHECK_AGAIN" | "SIGN_IN" | "SWITCH_WALLET" | "SWITCH_NETWORK" | "NEW_QUOTE" | "SERVER_STATUS" | "RECOVERY" | "CONFIGURATION"

export type CodeDescription = Readonly<{ reason: string; next: string; step: NextStep }>

function transfer(side: Side): string {
  return side === "SELL" ? "escrow" : "deposit"
}

function payment(side: Side): string {
  return side === "SELL" ? "escrow the units" : "send test cash"
}

export function describeCode(code: string, side: Side | null): CodeDescription {
  const s: Side = side ?? "BUY"
  switch (code) {
    case "NOT_CONFIGURED":
      return { reason: "Wallet execution is not configured in this app.", next: "Nothing can be signed from this screen until the app is configured.", step: "CONFIGURATION" }
    case "CURRENT_POLICY_REQUIRED":
      return { reason: "No current execution policy is available for this order.", next: "Execution stays disabled until a trusted execution policy is configured.", step: "CONFIGURATION" }
    case "DURABLE_SUBMISSION_GATE_REQUIRED":
      return { reason: "The durable wallet submission journal is not configured.", next: "Execution stays disabled: without it a request could be sent twice.", step: "CONFIGURATION" }
    case "TRUSTED_RECONCILIATION_REQUIRED":
      return { reason: "Trusted server verification of wallet transactions is not configured.", next: "Execution stays disabled until the server can confirm submitted transactions.", step: "CONFIGURATION" }
    case "DEPLOYMENT_NOT_REVIEWED":
    case "DEPLOYMENT_EVIDENCE_EXPIRED":
    case "INVALID_DEPLOYMENT":
    case "UNSUPPORTED_DEPLOYMENT":
    case "INVALID_DEPLOYMENT_ID":
    case "OVERLAPPING_CONTRACTS":
    case "MANIFEST_DIGEST_MISMATCH":
      return { reason: "There is no current review evidence for this Stocks deployment.", next: "Execution stays disabled until a reviewed deployment is configured.", step: "CONFIGURATION" }
    case "SESSION_REQUIRED":
    case "SESSION_REJECTED":
    case "WALLET_EPOCH_REQUIRED":
      return { reason: "The Stocks sign-in session is missing, expired or was not accepted.", next: "Sign in again with the wallet that placed this order.", step: "SIGN_IN" }
    case "CONTEXT_EXPIRED":
      return {
        reason: "The sign-in session or the deployment review expired.",
        next: `Sign in again, then check the order. A wallet request that was already sent stays recorded; the check shows it again while the order still waits for the ${transfer(s)}, otherwise see the order result.`,
        step: "SIGN_IN",
      }
    case "WALLET_MISMATCH":
    case "WALLET_CHANGED":
    case "ORDER_SCOPE_MISMATCH":
      return { reason: "The connected wallet is not the wallet that placed this order.", next: "Switch back to the ordering wallet and sign in with it.", step: "SWITCH_WALLET" }
    case "WALLET_NETWORK_INSTANCE_MISMATCH":
      return { reason: "The wallet is connected to a different network than the reviewed GIWA Sepolia deployment.", next: "Switch the wallet to GIWA Sepolia (chain 91342), then check again.", step: "SWITCH_NETWORK" }
    case "ORDER_EXPIRED":
    case "INVALID_DEADLINE":
      return { reason: "The quote deadline for this order has passed.", next: `Do not ${payment(s)} for this order. Get a new quote from the order screen.`, step: "NEW_QUOTE" }
    case "ORDER_NOT_PAYABLE":
      return { reason: `This order no longer waits for ${s === "SELL" ? "an escrow" : "a deposit"}.`, next: "Its status comes from the server; see the order result below.", step: "SERVER_STATUS" }
    case "EXECUTION_NOT_ALLOWED":
      return { reason: "Execution is not allowed for this order right now, for example because trading is paused.", next: "Check again later.", step: "CHECK_AGAIN" }
    case "EXECUTION_AUTHORITY_CHANGED":
      // Published only for an attempt this controller already reserved or sent: never "nothing was sent".
      return {
        reason: "The deployment review or the sign-in session expired or was renewed while this step was in progress, so it did not continue.",
        next: "Check again with current review evidence. What is already recorded for this order is kept and nothing is sent again.",
        step: "CHECK_AGAIN",
      }
    case "CONTEXT_CHANGED":
      return { reason: "The wallet, network, session or order changed during the check.", next: "Check again.", step: "CHECK_AGAIN" }
    case "ORDER_CHANGED":
    case "ORDER_PROFILE_MISMATCH":
    case "CATALOG_MISMATCH":
    case "CAPABILITY_UNAVAILABLE":
      return { reason: "The server's current order or catalog did not match the accepted order.", next: "Check again. If it persists, see the order result below.", step: "CHECK_AGAIN" }
    case "STALE_RESPONSE":
    case "READ_TIMEOUT":
    case "REQUEST_FAILED":
    case "INVALID_RESPONSE":
    case "EXECUTION_POLICY_EXPIRED":
      // No "nothing was sent" claim: the same code can follow an earlier, already recorded wallet request.
      return { reason: "A required check could not be completed in time.", next: "Check again.", step: "CHECK_AGAIN" }
    case "ALLOWANCE_CHANGED":
    case "ALLOWANCE_NOT_CONFIRMED":
      return { reason: "The token allowance changed after it was checked.", next: "Check again.", step: "CHECK_AGAIN" }
    case "ORDER_REQUIRED":
    case "PREPARE_REQUIRED":
      return { reason: "This step needs a current check first.", next: "Check the order.", step: "CHECK_AGAIN" }
    case "APPROVAL_REVERTED":
      return {
        reason: "The approval transaction reverted on chain.",
        next: `No ${transfer(s)} was sent. This screen does not retry it; contact operations with the transaction hash.`,
        step: "RECOVERY",
      }
    case "TRANSFER_REVERTED":
      return {
        reason: `The ${transfer(s)} transaction reverted on chain, so it did not ${s === "SELL" ? "escrow units for" : "fund"} this order.`,
        next: "This screen does not send it again. The order result below comes from the server; contact operations with the transaction hash.",
        step: "RECOVERY",
      }
    case "RECOVERY_REQUIRED":
    case "WALLET_OUTCOME_UNKNOWN":
    case "SUBMISSION_ALREADY_CLAIMED":
    case "SUBMISSION_HISTORY_MISSING":
    case "SUBMISSION_HISTORY_MISMATCH":
    case "SUBMISSION_TERMINAL_MISMATCH":
    case "SUBMISSION_RECORD_MISMATCH":
    case "ALLOWANCE_RECOVERY_REQUIRED":
    case "CLIENT_TERMINAL_REPORT_FORBIDDEN":
      return {
        reason: "An earlier wallet request for this order needs a server check.",
        next: "Nothing is sent again from this screen. Do not repeat it from another app or wallet; contact operations if it stays unresolved.",
        step: "RECOVERY",
      }
    case "RECEIPT_PENDING":
      return { reason: "The server has not confirmed the transaction yet.", next: "Check again in a moment.", step: "CHECK_AGAIN" }
    default:
      return { reason: "The order or configuration failed validation.", next: "Execution stays disabled for this order.", step: "CONFIGURATION" }
  }
}
