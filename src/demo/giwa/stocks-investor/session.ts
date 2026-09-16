// Host session intake. The server is the only authority on a token; these checks only refuse
// sessions that are obviously not the wallet/chain the host says is active, so a mis-wired host
// cannot show one wallet's Stocks data under another wallet's header.

import { GIWA_STOCKS_CHAIN_ID, type GiwaStocksHostWallet, type GiwaStocksSession, type HexAddress } from "./types"

export type SignedOutReason = "SIGNED_OUT" | "INVALID_SESSION" | "WALLET_MISMATCH" | "CHAIN_MISMATCH"

export type NormalizedSession =
  | { status: "signed-out"; reason: SignedOutReason }
  | { status: "verified"; wallet: HexAddress; chainId: typeof GIWA_STOCKS_CHAIN_ID; token: string }

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const segment = token.split(".")[1] ?? ""
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=")
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * `hostWallet === undefined` means the host does not report a wallet (no mismatch check).
 * A reported wallet that is disconnected, a different account or a different chain makes the
 * session unusable here, even if the token is still valid for its original wallet.
 */
export function normalizeSession(session: GiwaStocksSession, hostWallet?: GiwaStocksHostWallet | null): NormalizedSession {
  if (session.status !== "verified") return { status: "signed-out", reason: "SIGNED_OUT" }
  const address = typeof session.walletAddress === "string" ? session.walletAddress : ""
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || session.chainId !== GIWA_STOCKS_CHAIN_ID) {
    return { status: "signed-out", reason: "INVALID_SESSION" }
  }
  const token = typeof session.token === "string" ? session.token : ""
  if (token.length > 4096 || !JWT_SHAPE.test(token)) return { status: "signed-out", reason: "INVALID_SESSION" }
  const wallet = address.toLowerCase() as HexAddress
  // Not verification: the payload must merely describe the same wallet and chain.
  const payload = decodeJwtPayload(token)
  if (payload === null || typeof payload.sub !== "string" || payload.sub.toLowerCase() !== wallet || payload.chainId !== GIWA_STOCKS_CHAIN_ID) {
    return { status: "signed-out", reason: "INVALID_SESSION" }
  }
  if (hostWallet !== undefined) {
    if (hostWallet === null || typeof hostWallet.address !== "string" || hostWallet.address.toLowerCase() !== wallet) {
      return { status: "signed-out", reason: "WALLET_MISMATCH" }
    }
    if (hostWallet.chainId !== GIWA_STOCKS_CHAIN_ID) return { status: "signed-out", reason: "CHAIN_MISMATCH" }
  }
  return { status: "verified", wallet, chainId: GIWA_STOCKS_CHAIN_ID, token }
}

/** Everything that separates one view of Stocks data from another. A change starts a new generation. */
export function sessionIdentityKey(clientId: number | null, session: NormalizedSession, deploymentId: string | null): string {
  const who = session.status === "verified" ? `verified|${session.wallet}|${session.chainId}|${session.token}` : `signed-out|${session.reason}`
  return `${clientId ?? "none"}|${deploymentId ?? "no-deployment"}|${who}`
}

/**
 * The owner of an order attempt: the same actor on the same deployment of the same API (by base
 * URL, not by client object). A token refresh, a remount or a re-created client keeps the owner,
 * so the original request can still be retried unchanged; a different wallet, chain, deployment or
 * API never sees it.
 */
export function attemptOwnerKey(apiBaseUrl: string | null, session: NormalizedSession, deploymentId: string | null): string | null {
  if (apiBaseUrl === null || deploymentId === null || session.status !== "verified") return null
  return `${apiBaseUrl}|${deploymentId}|${session.wallet}|${session.chainId}`
}
