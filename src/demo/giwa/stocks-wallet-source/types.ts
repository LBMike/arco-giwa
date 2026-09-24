import type { Address } from "viem"

export type WalletRpcArgs = Readonly<{ method: string; params?: readonly unknown[] }>
/** The raw EIP-1193 object. Its `request` is called directly: no viem transport, so no retry layer. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}
/** Render-time view of the wallet provider tree's active source. */
export type ActiveWalletSource = Readonly<{ mode: "injected"; provider: Eip1193Provider | null }> | Readonly<{ mode: "dynamic"; client: unknown; /** Only a selected, installed extension's raw provider; never the viem client. */ rawProvider?: Eip1193Provider | null }>
export type WalletSourceView = Readonly<{ source: ActiveWalletSource | null; address: string | null; chainId: number | null; epoch: string }>
export type CapturedWalletSource = Readonly<{
  mode: "injected" | "dynamic"; epoch: string
  /** Checksummed. */
  address: Address
  request(args: WalletRpcArgs): Promise<unknown>
  /** Synchronous: not disposed, no provider event seen and still the module's active source. */
  isCurrent(): boolean
  dispose(): void
}>
export type WalletSourceUnavailableCode = "WALLET_NOT_CONNECTED" | "WALLET_SOURCE_MISSING" | "WALLET_SOURCE_UNSUPPORTED" | "WALLET_EPOCH_REQUIRED"
export type WalletSourceCapture = Readonly<{ status: "READY"; source: CapturedWalletSource }> | Readonly<{ status: "UNAVAILABLE"; code: WalletSourceUnavailableCode }>
