import { useState } from "react"

/** Render-time versioning: replacing a signer at the same address also retires SIWE. */
export function useWalletConnectionEpoch(parts: readonly unknown[]) {
  const [observed, setObserved] = useState(() => ({ parts, epoch: 0 }))
  if (parts.length !== observed.parts.length || parts.some((part, i) => !Object.is(part, observed.parts[i]))) {
    const next = { parts, epoch: observed.epoch + 1 }
    setObserved(next)
    return next.epoch
  }
  return observed.epoch
}

export function dynamicSigningReady(address: string | null, chainId: number | null, status: string, primaryAddress: string | undefined, client: {
  account?: { address?: string } | null
  chain?: { id?: number } | null
  signMessage?: unknown
} | null | undefined) {
  return Boolean(address && chainId === 91342 && status === "connected" && client?.chain?.id === chainId && client.account?.address?.toLowerCase() === address.toLowerCase() && (!primaryAddress || primaryAddress.toLowerCase() === address.toLowerCase()) && typeof client.signMessage === "function")
}
