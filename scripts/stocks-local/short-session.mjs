// Test-only restriction after a successful real SIWE verification. Never imported
// by production auth: the normal server still issues its unchanged 900-second JWT.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export function createShortSessionFixture({ secret, holder }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  let armed = false;
  return {
    arm() { assert.ok(!armed, 'LOCAL_SHORT_SESSION_ALREADY_ARMED'); armed = true; },
    restrict(path, status, payload) {
      if (!armed || path !== '/api/v1/auth/verify' || status !== 200) return payload;
      const body = JSON.parse(payload);
      const claims = jwt.verify(body.token, secret, { algorithms: ['HS256'] });
      assert.equal(body.walletAddress.toLowerCase(), holder.toLowerCase());
      assert.equal(claims.sub.toLowerCase(), holder.toLowerCase());
      assert.equal(claims.chainId, 91342);
      const now = Math.floor(Date.now() / 1000);
      assert.ok(claims.exp >= now + 30, 'LOCAL_SHORT_SESSION_MUST_ONLY_RESTRICT');
      const token = jwt.sign({ ...claims, iat: now, exp: now + 30, jti: randomUUID() }, secret, { algorithm: 'HS256' });
      armed = false;
      return JSON.stringify({ ...body, token, expiresIn: 30 });
    },
  };
}
