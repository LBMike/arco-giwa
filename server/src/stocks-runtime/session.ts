import { createRequire } from 'node:module';
import type { FastifyRequest } from 'fastify';
import { address, type Actor, type Operator } from '../stocks/contracts.js';
import { parseStocksOperators, type NamedOperator } from './operators.js';
export type { NamedOperator } from './operators.js';

const require = createRequire(import.meta.url);
const { verify } = require('jsonwebtoken') as typeof import('jsonwebtoken');

// The existing SIWE endpoint issues a short-lived HS256 wallet session. A legacy
// shared operator token is deliberately not a Stocks operator identity.
export function stocksSessionResolvers(secret: string, domains: readonly string[], operators: readonly NamedOperator[]) {
  const allowedDomains = new Set(domains);
  const directory = new Map(parseStocksOperators(operators).map(op => [op.wallet, { operatorId: op.operatorId, permissions: op.permissions }]));
  async function resolveActor(request: FastifyRequest): Promise<Actor | null> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      const value = verify(header.slice(7), secret, { algorithms: ['HS256'] });
      if (typeof value !== 'object' || value.chainId !== 91342 || typeof value.domain !== 'string' || !allowedDomains.has(value.domain)) return null;
      const now = Math.floor(Date.now() / 1000);
      if (typeof value.iat !== 'number' || typeof value.exp !== 'number' || value.exp <= now || value.iat > now + 5 || value.exp - value.iat > 900 || now - value.iat > 900) return null;
      const wallet = address(String(value.sub));
      return { actorId: `evm:${wallet}`, wallet, chainId: 91342, scope: 'STOCKS_TESTNET', verified: true };
    } catch { return null; }
  }
  async function resolveOperator(request: FastifyRequest): Promise<Operator | null> {
    const actor = await resolveActor(request);
    const operator = actor ? directory.get(actor.wallet) : undefined;
    return operator ? { operatorId: operator.operatorId, permissions: [...operator.permissions] } : null;
  }
  return { resolveActor, resolveOperator };
}
