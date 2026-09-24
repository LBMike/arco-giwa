import { createHash } from 'node:crypto';
import { encodeFunctionData, getAddress, maxUint256, parseAbi, type Hex } from 'viem';
import { ABI, canonicalJson, ensure, operationKey, type Manifest } from '../stocks/contracts.js';
import type { Row } from '../stocks/repository.js';
export type Side = 'BUY' | 'SELL';
export type Stage = 'APPROVAL' | 'TRANSFER';
export type Transaction = { chainId: 91342; from: string; to: string; data: Hex; value: '0' };
export type AttemptRecord = { claimId: string; intentKey: string; stage: Stage; transactionDigest: string; status: 'REQUEST_MAY_START' | 'UNKNOWN' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED'; txHash?: string };
export function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function label(value: unknown): string { ensure(typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value), 'INVALID_SUBMISSION_INPUT'); return value; }
export function hashDigest(value: unknown): string { ensure(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'INVALID_SUBMISSION_INPUT'); return value; }
export function side(value: unknown): Side { ensure(value === 'BUY' || value === 'SELL', 'INVALID_SUBMISSION_INPUT'); return value; }
export function stage(value: unknown): Stage { ensure(value === 'APPROVAL' || value === 'TRANSFER', 'INVALID_SUBMISSION_INPUT'); return value; }
export function exact(value: unknown, keys: string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_SUBMISSION_INPUT');
  const record = value as Record<string, unknown>;
  ensure(Reflect.ownKeys(record).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(record, k)), 'INVALID_SUBMISSION_INPUT');
  return record;
}
function amount(value: unknown): bigint {
  ensure(typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value), 'INVALID_SUBMISSION_ORDER');
  const n = BigInt(value); ensure(n <= maxUint256, 'INVALID_SUBMISSION_ORDER'); return n;
}
const approvalAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
// No expiry/state check here: inspect must derive identity after expiry or completion.
export function deriveOrder(manifest: Manifest, order: Row, orderSide: Side) {
  ensure(manifest.cashSymbol === 'ARCO_TEST_USDC' && order.symbol === 'NVDA', 'INVALID_SUBMISSION_ORDER');
  label(order.id);
  ensure(order.orderKey === operationKey(`${orderSide === 'SELL' ? 'sell:' : ''}${manifest.networkInstance}:${order.id}`), 'ORDER_KEY_MISMATCH');
  const quantity = amount(String(order.quantity)), cash = amount(String(order.cashAmount));
  ensure(quantity <= 10n ** 30n && cash === (quantity * 120000000n + (orderSide === 'BUY' ? 999999999n : 0n)) / 1000000000n, 'ORDER_PRICE_MISMATCH');
  const token = getAddress(orderSide === 'BUY' ? manifest.cashToken : manifest.stockToken);
  const spender = getAddress(orderSide === 'BUY' ? manifest.fundingVault : manifest.redemptionEscrow);
  const value = orderSide === 'BUY' ? cash : quantity;
  const base = { chainId: 91342 as const, from: getAddress(order.wallet), value: '0' as const };
  const approval: Transaction = { ...base, to: token, data: encodeFunctionData({ abi: approvalAbi, functionName: 'approve', args: [spender, value] }) };
  const transfer: Transaction = { ...base, to: spender, data: orderSide === 'BUY'
    ? encodeFunctionData({ abi: ABI, functionName: 'depositForOrder', args: [order.orderKey, value] })
    : encodeFunctionData({ abi: ABI, functionName: 'escrowForOrder', args: [order.orderKey, token, value] }) };
  return { intentKey: digest([91342, spender.toLowerCase(), token.toLowerCase(), base.from.toLowerCase(), order.orderKey]), approval, transfer };
}
export function output(row: Row): AttemptRecord {
  return { claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest, status: row.status, ...(row.txHash ? { txHash: row.txHash } : {}) };
}
