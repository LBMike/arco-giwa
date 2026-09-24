import { getAddress, isAddress, type Address } from "viem"
import type { ActiveWalletSource, Eip1193Provider, WalletSourceCapture, WalletSourceUnavailableCode, WalletSourceView } from "./types"

/** Any of these retires the capture for good: a later A→B→A or chain round trip is still another connection. */
export const WALLET_SOURCE_EVENTS = ["accountsChanged", "chainChanged", "disconnect"] as const

function unavailable(code: WalletSourceUnavailableCode): WalletSourceCapture {
  return Object.freeze({ status: "UNAVAILABLE", code })
}

function connectedAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value) || /^0x0{40}$/i.test(value)) return null
  return getAddress(value)
}

function usableProvider(provider: Eip1193Provider | null): provider is Eip1193Provider {
  return Boolean(provider) && typeof provider === "object" && typeof provider!.request === "function"
}

function observable(provider: Eip1193Provider) {
  return typeof provider.on === "function" && typeof provider.removeListener === "function"
}

/**
 * Captures the raw provider of this render. Dynamic requires the explicitly resolved selected extension;
 * its retrying viem client is never called and `window.ethereum` is never used in its place.
 * Capture issues no wallet request.
 */
export function captureWalletSource(view: WalletSourceView, options: { activeSource?: () => ActiveWalletSource | null } = {}): WalletSourceCapture {
  const active = view.source
  if (!active) return unavailable("WALLET_SOURCE_MISSING")
  if (active.mode === "dynamic" && (!active.rawProvider || !active.client)) return unavailable("WALLET_SOURCE_UNSUPPORTED")
  const provider = active.mode === "injected" ? active.provider : active.rawProvider ?? null
  if (!usableProvider(provider)) return unavailable("WALLET_SOURCE_MISSING")
  // Without events a swap inside the same provider object could not be seen synchronously.
  if (!observable(provider)) return unavailable("WALLET_SOURCE_UNSUPPORTED")
  const account = connectedAddress(view.address)
  if (!account) return unavailable("WALLET_NOT_CONNECTED")
  if (typeof view.epoch !== "string" || view.epoch.length === 0) return unavailable("WALLET_EPOCH_REQUIRED")

  let stale = false
  let disposed = false
  const retire = () => { stale = true }
  for (const event of WALLET_SOURCE_EVENTS) provider.on!(event, retire)

  const stillActive = () => {
    if (!options.activeSource) return true
    try {
      const current = options.activeSource()
      return active.mode === "injected"
        ? current?.mode === "injected" && current.provider === provider
        : current?.mode === "dynamic" && current.rawProvider === provider && current.client === active.client
    } catch { return false }
  }

  return Object.freeze({
    status: "READY",
    source: Object.freeze({
      mode: active.mode,
      epoch: view.epoch,
      address: account,
      request: (args: { method: string; params?: readonly unknown[] }) => provider.request({ method: args.method, params: args.params }),
      isCurrent: () => !disposed && !stale && stillActive(),
      dispose() {
        if (disposed) return
        disposed = true
        for (const event of WALLET_SOURCE_EVENTS) provider.removeListener!(event, retire)
      },
    }),
  })
}
