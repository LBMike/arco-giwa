import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createShortSessionFixture } from './short-session.mjs';
const holder = `0x${'1'.repeat(40)}`;
const secret = 'TEST_ONLY_SHORT_SESSION_UNIT';

test('one successful verified local holder login receives a genuinely shorter signed JWT; ordinary logins are unchanged', t => {
  const previous = process.env.STOCKS_LOCAL_STACK_ONLY;
  process.env.STOCKS_LOCAL_STACK_ONLY = '1';
  t.after(() => { if (previous === undefined) delete process.env.STOCKS_LOCAL_STACK_ONLY; else process.env.STOCKS_LOCAL_STACK_ONLY = previous; });
  const fixture = createShortSessionFixture({ secret, holder });
  const token = jwt.sign({ sub: holder, chainId: 91342, domain: '127.0.0.1:12345' }, secret, { expiresIn: 900 });
  const original = JSON.stringify({ token, expiresIn: 900, walletAddress: holder, chainId: 91342 });
  assert.equal(fixture.restrict('/api/v1/auth/verify', 200, original), original);
  fixture.arm(); assert.throws(() => fixture.arm(), /ALREADY_ARMED/);
  assert.equal(fixture.restrict('/api/v1/auth/verify', 401, '{}'), '{}');
  assert.equal(fixture.restrict('/different', 200, original), original);
  assert.throws(() => fixture.restrict('/api/v1/auth/verify', 200, JSON.stringify({ ...JSON.parse(original), token: token + 'x' })));
  const shorter = JSON.parse(fixture.restrict('/api/v1/auth/verify', 200, original));
  const claims = jwt.verify(shorter.token, secret);
  assert.equal(claims.exp - claims.iat, 30); assert.equal(shorter.expiresIn, 30);
  assert.equal(claims.sub, holder); assert.equal(claims.domain, '127.0.0.1:12345');
  assert.throws(() => jwt.verify(shorter.token, secret, { clockTimestamp: claims.exp }), /expired/);
  assert.equal(fixture.restrict('/api/v1/auth/verify', 200, original), original);
});
