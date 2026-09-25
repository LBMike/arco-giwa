import { address } from '../stocks/contracts.js';
import { validTradingControlText } from '../stocks-trading-control/validation.js';

export const VAULT_PERMISSIONS = ['vault:read', 'vault:write'] as const;
export type VaultPermission = (typeof VAULT_PERMISSIONS)[number];
export type AdminOperator = {
  readonly wallet: string;
  readonly operatorId: string;
  readonly permissions: readonly VaultPermission[];
};

export const INVALID_ADMIN_OPERATORS = 'INVALID_ADMIN_OPERATORS';

/** Fixed error: never echoes the configured directory back into logs or responses. */
export class AdminOperatorsError extends Error {
  readonly code = INVALID_ADMIN_OPERATORS;
  constructor() { super(INVALID_ADMIN_OPERATORS); }
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new AdminOperatorsError();
}

function isVaultPermission(value: unknown): value is VaultPermission {
  return (VAULT_PERMISSIONS as readonly unknown[]).includes(value);
}

/**
 * Vault operator directory (ADMIN_OPERATORS), validated at the same level as
 * parseStocksOperators: normalized wallets, unique wallets and operator ids, known
 * permissions only, no duplicate permissions. An empty directory is a valid deny-all
 * configuration. `vault:write` does not imply `vault:read` (same as stocks:control).
 */
export function parseAdminOperators(value: unknown): AdminOperator[] {
  check(Array.isArray(value));
  const wallets = new Set<string>(), ids = new Set<string>();
  const operators: AdminOperator[] = [];
  // Iterate over a copy so sparse slots are visited (as undefined) and rejected.
  for (const entry of [...value]) {
    check(entry !== null && typeof entry === 'object' && !Array.isArray(entry));
    const op = entry as Record<string, unknown>;
    check(typeof op.wallet === 'string' && validTradingControlText(op.operatorId, 128));
    const operatorId = op.operatorId as string;
    let wallet: string;
    try { wallet = address(op.wallet); } catch { throw new AdminOperatorsError(); }
    check(Array.isArray(op.permissions));
    const permissions: unknown[] = [...op.permissions];
    check(permissions.every(isVaultPermission) && new Set(permissions).size === permissions.length);
    check(!wallets.has(wallet) && !ids.has(operatorId));
    wallets.add(wallet); ids.add(operatorId);
    operators.push(Object.freeze({ wallet, operatorId, permissions: Object.freeze([...permissions]) as readonly VaultPermission[] }));
  }
  return operators;
}

/** ADMIN_OPERATORS as an environment value: unset or blank means deny all. */
export function parseAdminOperatorsEnv(raw: string | undefined): AdminOperator[] {
  if (raw === undefined || raw.trim() === '') return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AdminOperatorsError(); }
  return parseAdminOperators(value);
}
