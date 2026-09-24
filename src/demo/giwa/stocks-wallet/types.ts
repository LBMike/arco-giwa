import type { Address, Hex } from "viem"
import type { HostSession } from "../stocks-host/session"

export type ManifestV2 = {
  schemaVersion: 2; redemptionEscrow: Address; deploymentId: string; profile: "DEMO_TESTNET"; chainId: 91342
  networkInstance: string; checkpointNumber: string; checkpointHash: Hex; abiDigest: string; finalityPolicy: "FINALIZED"
  cashToken: Address; cashSymbol: "ARCO_TEST_USDC"; cashScale: 6; stockToken: Address; quantityScale: 9
  fundingVault: Address; mintController: Address; signerAddress: Address; codeHashes: Record<string, Hex>
  restrictedTransfers: true; nonUpgradeable: true
}
/** Trusted host attestation, NOT a catalog response or a browser self-verification flag. */
export type ReviewedDeployment = {
  status: "VERIFIED"; evidenceId: string; manifestDigest: string; manifest: ManifestV2
  verifiedAt: number; validUntil: number
}
export type ExecutionContext = {
  session: HostSession | null; walletAddress: string | null; chainId: number | null; walletEpoch: string
  apiBase: string; deployment: ReviewedDeployment | null
}
export type Side = "BUY" | "SELL"
export type Stage = "APPROVAL" | "TRANSFER"
/** Raw accepted create-order row. BUY rows carry no side field; SELL rows carry side "SELL". `side` here is always required. */
export type Selection = { side: Side; order: unknown }
export type Order = Readonly<{
  id: string; orderKey: Hex; quoteId: string; actorId: string; wallet: Address; symbol: "NVDA"
  quantity: string; cashAmount: string; deploymentId: string; deploymentDigest: string
  quoteExpiresAt: string; state: string; version: number; idempotencyKey: string
}>
export type Transaction = Readonly<{ chainId: 91342; from: Address; to: Address; data: Hex; value: "0" }>
export type Plan = Readonly<{
  side: Side; order: Order; manifestDigest: string; intentKey: string; token: Address; spender: Address
  amount: string; deadline: number; approval: Transaction; transfer: Transaction
}>
export type WalletIdentity = {
  address: string; chainId: number; connectionEpoch: string
  /** Trusted read through this active wallet source, not merely a matching numeric chain ID. */
  deploymentDigest: string; networkInstance: string; checkpointHash: Hex
}
export type AuthenticatedRead = {
  apiBase: string; token: string; sessionId: string; side: Side; orderId: string; deploymentDigest: string; signal: AbortSignal
}
/** Requires an authoritative fresh policy adapter; CHECK_PAUSE_AT_ORDER alone is insufficient. */
export type ExecutionPolicy = {
  allowed: true; deploymentDigest: string; orderId: string; side: Side; observedAt: number; validUntil: number
}
export type ReceiptEvidence = {
  transactionHash: Hex; transaction: Transaction; chainId: 91342; status: "success" | "reverted"
  canonical: true; blockHash: Hex; blockNumber: string
}
export type AttemptRecord = {
  claimId: string; intentKey: string; stage: Stage; transactionDigest: string
  status: "REQUEST_MAY_START" | "SUBMITTED" | "UNKNOWN" | "CONFIRMED" | "REVERTED"; txHash?: Hex
}
export type ReconcileRequest = Pick<AttemptRecord, "claimId" | "intentKey" | "stage" | "transactionDigest"> & { txHash: Hex }
/** Must be durable, atomic and shared across tabs/devices. No in-memory/localStorage default. */
export type SubmissionGate = {
  inspect(intentKey: string): Promise<{ approval: AttemptRecord | null; transfer: AttemptRecord | null }>
  claim(request: { intentKey: string; stage: Stage; transactionDigest: string; transaction: Transaction; orderId: string; deploymentDigest: string }): Promise<AttemptRecord | null>
  record(request: AttemptRecord): Promise<void>
  /** Only trusted server verification can produce terminal receipt states. */
  reconcile?(request: ReconcileRequest): Promise<AttemptRecord>
}
export type WalletPorts = {
  /** Current synchronous host snapshot; walletEpoch must change for A→B→A and source replacement. */
  context(): ExecutionContext
  readWallet(): Promise<WalletIdentity>
  readOrder(request: AuthenticatedRead): Promise<unknown>
  readCatalog(request: AuthenticatedRead): Promise<unknown>
  readExecutionPolicy(request: AuthenticatedRead): Promise<ExecutionPolicy>
  readAllowance(request: { token: Address; owner: Address; spender: Address; chainId: 91342; signal: AbortSignal }): Promise<string>
  requestTransaction(transaction: Transaction): Promise<unknown>
  /** Legacy wallet observation only; never authoritative for terminal journal status. */
  waitApprovalReceipt(request: { txHash: Hex; transaction: Transaction; signal: AbortSignal }): Promise<ReceiptEvidence | null>
  submissions: SubmissionGate
  invalidateSession?(capturedSessionId: string): void
  now?: () => number
  /**
   * Monotonic milliseconds (default `performance.now()`). Bounds each read and each execution policy's lifetime
   * independently of the wall clock, so a stalled or stepped-back wall clock cannot keep an expired policy alive.
   */
  monotonicNow?: () => number
}
export type WalletSnapshot = Readonly<{
  status: "IDLE" | "CHECKING" | "APPROVAL_REQUIRED" | "READY_TRANSFER" | "SIGNING" | "APPROVAL_SUBMITTED" | "SUBMITTED" | "UNKNOWN" | "BLOCKED"
  orderId: string | null; intentKey: string | null; stage: Stage | null; txHash: Hex | null; error: string | null
  plan: Plan | null
}>
