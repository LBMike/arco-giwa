import { address, ensure, StocksError } from '../stocks/contracts.js';
import { validTradingControlText } from '../stocks-trading-control/validation.js';

export type NamedOperator = { wallet: string; operatorId: string; permissions: string[] };

// Shared by configuration loading, trusted runtime composition and sessions.
// Empty directories/permissions are valid deny-all configurations. Requiring
// a reader/controller belongs to the deployment workflow, not authentication.
export function parseStocksOperators(value: unknown): NamedOperator[] {
  const code = 'INVALID_STOCKS_OPERATORS';
  ensure(Array.isArray(value), code);
  const wallets = new Set<string>(), ids = new Set<string>();
  const operators: NamedOperator[] = [];
  for (const entry of value) {
    ensure(entry !== null && typeof entry === 'object' && !Array.isArray(entry), code);
    const op = entry as Record<string, unknown>;
    ensure(typeof op.wallet === 'string' && validTradingControlText(op.operatorId, 128), code);
    let wallet: string;
    try { wallet = address(op.wallet); } catch { throw new StocksError(code); }
    ensure(Array.isArray(op.permissions), code);
    // Iterate over a copy so sparse slots cannot bypass Array.every validation.
    const permissions: unknown[] = [...op.permissions];
    ensure(permissions.every(p => p === 'stocks:read' || p === 'stocks:control') && new Set(permissions).size === permissions.length, code);
    ensure(!wallets.has(wallet) && !ids.has(op.operatorId), code);
    wallets.add(wallet); ids.add(op.operatorId);
    operators.push({ wallet, operatorId: op.operatorId, permissions: permissions as string[] });
  }
  return operators;
}
