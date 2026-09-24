import { address, type Manifest, type SqlClient } from '../stocks/contracts.js';
import type { Row } from '../stocks/repository.js';
import { deriveOrder, digest, type Side } from './contracts.js';
export function orderBinding(order: Row, orderSide: Side): string {
  return digest({ side: orderSide, orderId: order.id, orderKey: order.orderKey, actorId: order.actorId, wallet: address(order.wallet), symbol: order.symbol, quantity: String(order.quantity), cashAmount: String(order.cashAmount), deploymentId: order.deploymentId, deploymentDigest: order.deploymentDigest, quoteExpiresAt: new Date(order.quoteExpiresAt).toISOString() });
}
// Invoke ONLY immediately after a new authoritative order INSERT, in its transaction.
// Existing orders/retries/migrations must never infer absence of historical wallet activity.
export async function enrollWalletSubmission(db: SqlClient, manifest: Manifest, order: Row, orderSide: Side): Promise<void> {
  // The existing broader test-cash domain is preserved; this wallet protocol supports USDC only.
  if (manifest.cashSymbol !== 'ARCO_TEST_USDC') return;
  const plan = deriveOrder(manifest, order, orderSide);
  await db.query('INSERT INTO arco_evm."StocksWalletSubmissionEnrollment" (side,"orderId","intentKey","actorId",wallet,"deploymentDigest","orderBinding") VALUES($1,$2,$3,$4,$5,$6,$7)', [orderSide, order.id, plan.intentKey, order.actorId, address(order.wallet), order.deploymentDigest, orderBinding(order, orderSide)]);
}
