export type JsonObject = Record<string, unknown>

export type RegistryAssetInput = {
  symbol: string
  name: string
  decimals: number
  tokenAddress: string
  faucetAddress?: string | null
  deploymentBlock?: bigint | number | null
  metadata?: JsonObject | null
}

export type RegistryProductInput = {
  productId: string
  symbol: string
  name: string
  productTokenAddress: string
  paymentAssetSymbol: string
  paymentAssetAddress: string
  depositVaultAddress: string
  redemptionVaultAddress: string
  priceFeedAddress: string
  deploymentBlock?: bigint | number | null
  activationFlags?: JsonObject | null
  metadata?: JsonObject | null
}

export type RegistrySyncInput = {
  chainId: number
  network: string
  name: string
  publicRpcUrl?: string | null
  explorerUrl?: string | null
  blockscoutApiUrl?: string | null
  nativeCurrency?: JsonObject | null
  releaseId: string
  assets: RegistryAssetInput[]
  products: RegistryProductInput[]
}

export type IndexedEventInput = {
  chainId: number
  contractAddress: string
  blockNumber: bigint | number
  blockHash: string
  txHash: string
  logIndex: number
  eventName: string
  args: JsonObject
  removed?: boolean
  // Block wall-clock time (from eth_getBlockByNumber at index time); optional so non-indexer
  // callers/tests need not supply it.
  blockTimestamp?: Date | null
}

export type AuthNonceInput = {
  walletAddress: string
  domain: string
  nonce: string
  ttlSeconds: number
  now?: Date
}

export type ConsumeNonceInput = {
  walletAddress: string
  domain: string
  nonce: string
  now?: Date
}

export type WalletAttestationInput = {
  walletAddress: string
  domain: string
  statement?: string | null
  signature: string
  issuedAt: Date
  expiresAt?: Date | null
}

export type IndexerCursorInput = {
  chainId: number
  name: string
  fromBlock: bigint | number
  lastBlock: bigint | number
  lastBlockHash?: string | null
  confirmations: number
  lagBlocks: number
}

export type RedemptionRequestIndexInput = {
  chainId: number
  requestId: string
  walletAddress: string
  productId: string
  productTokenAddress: string
  redemptionVaultAddress: string
  sharesIn: string
  lockedAssetsOut: string
  requestedTxHash: string
  requestedAtBlock: bigint | number
  metadata?: JsonObject | null
}

export type FaucetStatus = {
  walletAddress: string
  chainId: number
  available: boolean
  reason: string | null
}
