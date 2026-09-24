import type { HostSnapshot } from "./session"

// Structural contracts only: do not import another builder's unfinished modules.
export function investorSession(snapshot: HostSnapshot) {
  const session = snapshot.session
  return session
    ? { status: "verified" as const, walletAddress: session.walletAddress, chainId: session.chainId, token: session.accessToken }
    : { status: "signed-out" as const }
}
export function adminSession(snapshot: HostSnapshot) {
  return snapshot.session ? { id: snapshot.session.id, accessToken: snapshot.session.accessToken } : null
}
