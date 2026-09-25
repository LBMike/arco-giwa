import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AdminOperator, VaultPermission } from './operators.js';

export type AdminPrincipal = {
  readonly operatorId: string;
  /** Null only for the legacy shared token, which has no wallet identity. */
  readonly wallet: string | null;
  readonly via: 'session' | 'legacy-token';
};

export type AdminDenial = { readonly ok: false; readonly status: 401 | 403; readonly code: string; readonly error: string };
export type VaultDecision = { readonly ok: true; readonly principal: AdminPrincipal } | AdminDenial;

/** Audit identity recorded for requests authorized by the legacy shared token. */
export const LEGACY_TOKEN_OPERATOR_ID = 'legacy-operator-token';

export const SESSION_REQUIRED: AdminDenial = Object.freeze({
  ok: false, status: 401, code: 'SESSION_REQUIRED', error: 'Operator session is missing or expired. Sign in again.',
});

/** GET/HEAD read; every other method (POST, PUT, PATCH, DELETE, anything new) writes. */
export function requiredVaultPermission(method: string): VaultPermission {
  return method === 'GET' || method === 'HEAD' ? 'vault:read' : 'vault:write';
}

export type AdminAuthorityOptions = {
  /** Verified SIWE session wallet (lowercase) or null; see siweSessionWallet. */
  readonly resolveSessionWallet: (request: FastifyRequest) => Promise<string | null>;
  readonly vaultOperators: readonly AdminOperator[];
  /** The legacy shared token. Pass it only when ADMIN_LEGACY_TOKEN_AUTH=1. */
  readonly legacyToken?: string | null;
};

export type AdminAuthority = {
  authorizeVault(request: FastifyRequest, required: VaultPermission): Promise<VaultDecision>;
  sessionWallet(request: FastifyRequest): Promise<string | null>;
  vaultOperator(wallet: string): { operatorId: string; permissions: VaultPermission[] } | null;
};

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createAdminAuthority(options: AdminAuthorityOptions): AdminAuthority {
  const directory = new Map(options.vaultOperators.map(op => [op.wallet, op] as const));
  const legacy = typeof options.legacyToken === 'string' && options.legacyToken.length > 0 ? sha256(options.legacyToken) : null;

  async function sessionWallet(request: FastifyRequest): Promise<string | null> {
    try { return await options.resolveSessionWallet(request); } catch { return null; }
  }

  function legacyTokenMatches(header: unknown): boolean {
    if (!legacy || typeof header !== 'string' || header.length === 0 || header.length > 4096) return false;
    // Equal-length digests: the comparison time does not depend on the token or its length.
    return timingSafeEqual(sha256(header), legacy);
  }

  async function authorizeVault(request: FastifyRequest, required: VaultPermission): Promise<VaultDecision> {
    // A presented session is authoritative: an expired or foreign session never falls back
    // to the shared token.
    if (request.headers.authorization !== undefined) {
      const wallet = await sessionWallet(request);
      if (!wallet) return SESSION_REQUIRED;
      const operator = directory.get(wallet);
      if (!operator) return { ok: false, status: 403, code: 'OPERATOR_FORBIDDEN', error: 'This wallet is not a vault operator.' };
      if (!operator.permissions.includes(required)) {
        return { ok: false, status: 403, code: 'PERMISSION_REQUIRED', error: `This operator lacks ${required}.` };
      }
      return { ok: true, principal: Object.freeze({ operatorId: operator.operatorId, wallet, via: 'session' }) };
    }
    if (legacyTokenMatches(request.headers['x-operator-token'])) {
      return { ok: true, principal: Object.freeze({ operatorId: LEGACY_TOKEN_OPERATOR_ID, wallet: null, via: 'legacy-token' }) };
    }
    return SESSION_REQUIRED;
  }

  function vaultOperator(wallet: string) {
    const operator = directory.get(wallet);
    return operator ? { operatorId: operator.operatorId, permissions: [...operator.permissions] } : null;
  }

  return { authorizeVault, sessionWallet, vaultOperator };
}
