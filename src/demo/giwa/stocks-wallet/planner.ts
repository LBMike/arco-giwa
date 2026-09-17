import { encodeFunctionData, getAddress, isAddress, sha256, toHex, type Address, type Hex } from "viem"
import { APPROVAL_ABI, STOCKS_ABI, STOCKS_ABI_DIGEST } from "./abi"
import type { ExecutionContext, Order, Plan, ReviewedDeployment, Selection, Transaction } from "./types"

export class StocksWalletError extends Error { constructor(readonly code: string) { super(code) } }
export function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new StocksWalletError(code) }
export function record(value: unknown): Record<string, unknown> { ensure(value && typeof value === "object" && !Array.isArray(value), "INVALID_RESPONSE"); return value as Record<string, unknown> }
export function address(value: unknown): Address { ensure(typeof value === "string" && isAddress(value) && !/^0x0{40}$/i.test(value), "INVALID_ADDRESS"); return getAddress(value) }
export function hash(value: unknown): Hex { ensure(typeof value === "string" && /^0x[\da-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value), "INVALID_HASH"); return value.toLowerCase() as Hex }
export function integer(value: unknown, allowZero = false): bigint {
  ensure(typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value), "INVALID_AMOUNT")
  const n = BigInt(value); ensure(n <= (1n << 256n) - 1n && (allowZero || n > 0n), "INVALID_AMOUNT"); return n
}
function label(value: unknown): string { ensure(typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value), "INVALID_ID"); return value }
/**
 * Same canonical JSON as the backend (docs/contracts/stocks-canonical-locale-v1.md): keys sorted with an explicit
 * en-US collation, so a browser whose default locale is, for example, Czech or Slovak produces the historical en-US
 * digests. This depends on the runtime's ICU collation data; it is not a version-independent canonical format.
 */
export function canonical(value: unknown): string {
  const order = (node: unknown): unknown => Array.isArray(node) ? node.map(order) : node !== null && typeof node === "object" ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([key, child]) => [key, order(child)])) : node
  return JSON.stringify(order(value))
}
export function digest(value: unknown): string { return sha256(toHex(canonical(value))).slice(2) }
export function freeze<T>(value: T): T {
  const copy = structuredClone(value)
  const deep = (node: unknown) => { if (node && typeof node === "object") { Object.values(node).forEach(deep); Object.freeze(node) } }
  deep(copy); return copy
}
export function validateDeployment(deployment: ReviewedDeployment | null, now: number) {
  ensure(deployment?.status === "VERIFIED", "DEPLOYMENT_NOT_REVIEWED")
  label(deployment.evidenceId)
  ensure(Number.isFinite(now) && Number.isFinite(deployment.verifiedAt) && Number.isFinite(deployment.validUntil) && deployment.verifiedAt <= now && now < deployment.validUntil, "DEPLOYMENT_EVIDENCE_EXPIRED")
  const m = deployment.manifest
  ensure(m?.schemaVersion === 2 && m.chainId === 91342 && m.profile === "DEMO_TESTNET" && m.cashSymbol === "ARCO_TEST_USDC" && m.cashScale === 6 && m.quantityScale === 9, "INVALID_DEPLOYMENT")
  ensure(m.abiDigest === STOCKS_ABI_DIGEST && m.finalityPolicy === "FINALIZED" && m.restrictedTransfers === true && m.nonUpgradeable === true, "UNSUPPORTED_DEPLOYMENT")
  ensure(/^[a-zA-Z0-9:_-]{8,128}$/.test(m.deploymentId) && /^[a-zA-Z0-9:_-]{8,128}$/.test(m.networkInstance), "INVALID_DEPLOYMENT_ID"); integer(m.checkpointNumber, true); hash(m.checkpointHash); address(m.signerAddress)
  const contracts = [m.cashToken, m.stockToken, m.fundingVault, m.mintController, m.redemptionEscrow].map(a => address(a).toLowerCase())
  ensure(new Set(contracts).size === 5, "OVERLAPPING_CONTRACTS")
  contracts.forEach(a => hash(m.codeHashes?.[a]))
  ensure(/^[\da-f]{64}$/.test(deployment.manifestDigest) && digest(m) === deployment.manifestDigest, "MANIFEST_DIGEST_MISMATCH")
  return deployment
}
export function validateContext(context: ExecutionContext, now: number) {
  const session = context.session
  ensure(session && session.chainId === 91342 && context.chainId === 91342 && Number.isFinite(session.createdAt) && Number.isFinite(session.expiresAt) && session.createdAt <= now && now < session.expiresAt, "SESSION_REQUIRED")
  ensure(typeof session.id === "string" && session.id.length > 0 && typeof session.accessToken === "string" && session.accessToken.length > 0, "SESSION_REQUIRED")
  ensure(typeof context.walletEpoch === "string" && context.walletEpoch.length > 0, "WALLET_EPOCH_REQUIRED")
  ensure(address(context.walletAddress).toLowerCase() === address(session.walletAddress).toLowerCase(), "WALLET_MISMATCH")
  const url = new URL(context.apiBase)
  // An empty "?" or "#" leaves url.search/url.hash empty but would turn every API path into a query or fragment.
  ensure(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.href.includes("?") && !url.href.includes("#"), "INVALID_API_BASE")
  return { session, deployment: validateDeployment(context.deployment, now) }
}
export function parseOrder(selection: Selection): Order {
  ensure(selection?.side === "BUY" || selection?.side === "SELL", "INVALID_SIDE")
  const row = record(selection.order)
  ensure(row.side === undefined || row.side === selection.side, "ORDER_SIDE_MISMATCH")
  ensure(row.symbol === "NVDA" && Number.isSafeInteger(row.version) && Number(row.version) >= 0, "INVALID_ORDER")
  integer(row.quantity); integer(row.cashAmount)
  ensure(typeof row.deploymentDigest === "string" && /^[\da-f]{64}$/.test(row.deploymentDigest), "INVALID_ORDER")
  ensure(typeof row.quoteExpiresAt === "string" && /^\d{4}-\d\d-\d\dT/.test(row.quoteExpiresAt) && Number.isFinite(Date.parse(row.quoteExpiresAt)), "INVALID_DEADLINE")
  ensure(typeof row.state === "string", "INVALID_ORDER")
  return freeze({ id: label(row.id), orderKey: hash(row.orderKey), quoteId: label(row.quoteId), actorId: label(row.actorId), wallet: address(row.wallet), symbol: "NVDA", quantity: String(row.quantity), cashAmount: String(row.cashAmount), deploymentId: label(row.deploymentId), deploymentDigest: row.deploymentDigest, quoteExpiresAt: row.quoteExpiresAt, state: row.state, version: Number(row.version), idempotencyKey: label(row.idempotencyKey) })
}
export function planOrder(selection: Selection, context: ExecutionContext, now: number): Plan {
  const { session, deployment } = validateContext(context, now)
  const order = parseOrder(selection)
  const m = deployment.manifest
  ensure(order.wallet.toLowerCase() === session.walletAddress.toLowerCase() && order.deploymentId === m.deploymentId && order.deploymentDigest === deployment.manifestDigest, "ORDER_SCOPE_MISMATCH")
  ensure(order.state === (selection.side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW"), "ORDER_NOT_PAYABLE")
  ensure(order.orderKey === sha256(toHex(`${selection.side === "SELL" ? "sell:" : ""}${m.networkInstance}:${order.id}`)), "ORDER_KEY_MISMATCH")
  const deadline = Date.parse(order.quoteExpiresAt); ensure(now < deadline, "ORDER_EXPIRED")
  const quantity = integer(order.quantity), cash = integer(order.cashAmount)
  ensure(quantity <= 10n ** 30n && cash === (quantity * 120000000n + (selection.side === "BUY" ? 999999999n : 0n)) / 1000000000n, "ORDER_PRICE_MISMATCH")
  const token = address(selection.side === "BUY" ? m.cashToken : m.stockToken)
  const spender = address(selection.side === "BUY" ? m.fundingVault : m.redemptionEscrow)
  const amount = selection.side === "BUY" ? order.cashAmount : order.quantity
  const base = { chainId: 91342 as const, from: order.wallet, value: "0" as const }
  const approval: Transaction = { ...base, to: token, data: encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [spender, BigInt(amount)] }) }
  const transfer: Transaction = { ...base, to: spender, data: selection.side === "BUY" ? encodeFunctionData({ abi: STOCKS_ABI, functionName: "depositForOrder", args: [order.orderKey, BigInt(amount)] }) : encodeFunctionData({ abi: STOCKS_ABI, functionName: "escrowForOrder", args: [order.orderKey, token, BigInt(amount)] }) }
  // Physical target/token/wallet/order identity survives manifest aliases and controller recreation.
  const intentKey = digest([91342, spender.toLowerCase(), token.toLowerCase(), order.wallet.toLowerCase(), order.orderKey])
  return freeze({ side: selection.side, order, manifestDigest: deployment.manifestDigest, intentKey, token, spender, amount, deadline, approval, transfer })
}
export function assertTransaction(actual: Transaction, expected: Transaction) {
  ensure(Object.keys(actual).sort().join() === "chainId,data,from,to,value" && actual.chainId === 91342 && actual.value === "0" && address(actual.from).toLowerCase() === expected.from.toLowerCase() && address(actual.to).toLowerCase() === expected.to.toLowerCase() && actual.data === expected.data, "TRANSACTION_MISMATCH")
}
