type WalletSignInCode = "SIGN_IN_WALLET_MISMATCH" | "SIGN_IN_WALLET_UNAVAILABLE" | "SIGN_IN_WALLET_DISCONNECTED" | "WALLET_REQUEST_REJECTED" | "WALLET_REQUEST_PENDING" | "WALLET_SIGNATURE_FAILED"

/** Only these locally classified codes may cross the wallet/session boundary. */
export class WalletSignInError extends Error {
  constructor(readonly code: WalletSignInCode) { super(code) }
}

/** viem may wrap EIP-1193 errors. Never retain or display their messages/data. */
export function walletSignatureFailure(error: unknown): WalletSignInError {
  let current = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current)
    const value = current as { code?: unknown; cause?: unknown }
    if (value.code === 4001) return new WalletSignInError("WALLET_REQUEST_REJECTED")
    if (value.code === -32002) return new WalletSignInError("WALLET_REQUEST_PENDING")
    current = value.cause
  }
  return new WalletSignInError("WALLET_SIGNATURE_FAILED")
}

/** The wallet's answer to "connect this site again": declined, already open, or no account. Never its message. */
export function walletConnectFailure(error: unknown): WalletSignInError {
  const failure = walletSignatureFailure(error)
  return failure.code === "WALLET_SIGNATURE_FAILED" ? new WalletSignInError("SIGN_IN_WALLET_DISCONNECTED") : failure
}

export function signInFailureMessage(code: string | null): string {
  switch (code) {
    case "SIGN_IN_WALLET_MISMATCH": return "The signing wallet or network changed. Select the connected account on GIWA Sepolia, then sign in again."
    case "SIGN_IN_WALLET_UNAVAILABLE": return "The connected wallet is not responding. Unlock your wallet and reconnect, then sign in again."
    case "SIGN_IN_WALLET_DISCONNECTED": return "Your wallet is not connected to this site. Approve the connection request in your wallet, then try again."
    case "WALLET_REQUEST_REJECTED": return "The wallet sign-in request was declined. Try again and approve the sign-in message in your wallet."
    case "WALLET_REQUEST_PENDING": return "A wallet request is already open. Complete or cancel it in your wallet, then try again."
    case "WALLET_SIGNATURE_FAILED": return "The wallet could not return a sign-in signature. Unlock your wallet and reconnect, then try again."
    case "INVALID_SIGNATURE": return "The wallet returned an unsupported sign-in signature. Reconnect the wallet and try again."
    case "NONCE_EXPIRED": return "The sign-in request expired while waiting for your wallet. Start a new sign-in request."
    case "AUTH_TIMEOUT": return "The sign-in server took too long to respond. Check the local server, then try again."
    case "AUTH_UNAVAILABLE": return "The sign-in server is unavailable. Check the local server, then try again."
    case "AUTH_REJECTED": return "The server did not accept this sign-in request. Check the wallet account and start a new sign-in request."
    case "INVALID_AUTH_RESPONSE": return "The server returned an invalid sign-in session. Reload the page and try again."
    case "INVALID_AUTH_CONTEXT": return "This page cannot start Stocks sign-in. Reload the Stocks page and reconnect your wallet."
    default: return "Stocks sign-in could not be completed. Try again."
  }
}
