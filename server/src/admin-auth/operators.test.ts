import test from 'node:test';
import assert from 'node:assert/strict';
import { a } from '../stocks/test-fixtures.js';
import { validateServerEnv } from '../config/env.js';
import { INVALID_ADMIN_OPERATORS, parseAdminOperators, parseAdminOperatorsEnv } from './operators.js';

const operator = () => ({ wallet: a(10), operatorId: 'vault-reader', permissions: ['vault:read'] });
const invalidDirectories: unknown[] = [undefined, null, {}, 'vault:read', [null], [[]], [1], new Array(1),
  ...['', ' reader', 'reader ', 'a\n', 'a\u0000b', 'a\u0085b', '\ud800', '\udc00', 'a'.repeat(129), 1].map(operatorId => [{ ...operator(), operatorId }]),
  ...['bad-wallet', a(0), 12, undefined].map(wallet => [{ ...operator(), wallet }]),
  ...[undefined, null, 'vault:read', {}, [null], ['vault:admin'], ['stocks:read'], ['Vault:read'], ['vault:read', 'vault:read'], new Array(1)]
    .map(permissions => [{ ...operator(), permissions }]),
  // Same wallet twice (also when only the case differs), and the same operator id twice.
  [operator(), { ...operator(), operatorId: 'other' }],
  [operator(), { ...operator(), wallet: a(10).toUpperCase().replace('0X', '0x'), operatorId: 'other' }],
  [operator(), { ...operator(), wallet: a(11) }],
];

test('ADMIN_OPERATORS rejects malformed directories with one fixed error', () => {
  for (const directory of invalidDirectories) {
    assert.throws(() => parseAdminOperators(directory), { message: INVALID_ADMIN_OPERATORS, code: INVALID_ADMIN_OPERATORS });
  }
});

test('ADMIN_OPERATORS accepts deny-all, read-only, write-only and read+write entries and normalizes wallets', () => {
  assert.deepEqual(parseAdminOperators([]), []);
  for (const permissions of [[], ['vault:read'], ['vault:write'], ['vault:read', 'vault:write']]) {
    assert.deepEqual(parseAdminOperators([{ ...operator(), operatorId: '운영자😀', permissions }]), [{ wallet: a(10), operatorId: '운영자😀', permissions }]);
  }
  const upper = parseAdminOperators([{ ...operator(), wallet: a(10).toUpperCase().replace('0X', '0x') }]);
  assert.equal(upper[0].wallet, a(10));
  assert.equal(parseAdminOperators([{ ...operator(), operatorId: 'a'.repeat(128) }])[0].operatorId.length, 128);
});

test('parsed directory entries cannot be mutated through the input or the result', () => {
  const input = [operator()];
  const parsed = parseAdminOperators(input);
  input[0].permissions.push('vault:write'); input[0].operatorId = 'changed';
  assert.deepEqual(parsed, [{ wallet: a(10), operatorId: 'vault-reader', permissions: ['vault:read'] }]);
  assert.throws(() => { (parsed[0].permissions as string[]).push('vault:write'); });
  assert.throws(() => { (parsed[0] as { operatorId: string }).operatorId = 'x'; });
});

test('ADMIN_OPERATORS environment value: unset or blank is deny-all, anything else must be a valid JSON directory', () => {
  assert.deepEqual(parseAdminOperatorsEnv(undefined), []);
  assert.deepEqual(parseAdminOperatorsEnv(''), []);
  assert.deepEqual(parseAdminOperatorsEnv('  '), []);
  assert.deepEqual(parseAdminOperatorsEnv('[]'), []);
  assert.deepEqual(parseAdminOperatorsEnv(JSON.stringify([operator()])), [operator()]);
  for (const raw of ['{', 'null', '{}', '"x"', JSON.stringify([{ ...operator(), permissions: ['vault:delete'] }])]) {
    assert.throws(() => parseAdminOperatorsEnv(raw), { code: INVALID_ADMIN_OPERATORS });
  }
});

const baseEnv = {
  DATABASE_URL: 'postgresql://localhost/test', DIRECT_URL: 'postgresql://localhost/test',
  INDEXER_RPC_URL: 'https://rpc.example.test', AUTH_JWT_SECRET: 'TEST_ONLY_SECRET',
};

test('server env: the legacy token is optional, off by default, and required only when ADMIN_LEGACY_TOKEN_AUTH=1', () => {
  const plain = validateServerEnv({ ...baseEnv });
  assert.equal(plain.adminLegacyTokenAuth, false);
  assert.equal(plain.adminOperatorToken, '');
  assert.deepEqual(plain.adminOperators, []);
  assert.equal(validateServerEnv({ ...baseEnv, ADMIN_LEGACY_TOKEN_AUTH: '0', ADMIN_OPERATOR_TOKEN: 'x' }).adminLegacyTokenAuth, false);
  const legacy = validateServerEnv({ ...baseEnv, ADMIN_LEGACY_TOKEN_AUTH: '1', ADMIN_OPERATOR_TOKEN: 'TEST_ONLY_LEGACY' });
  assert.equal(legacy.adminLegacyTokenAuth, true);
  assert.equal(legacy.adminOperatorToken, 'TEST_ONLY_LEGACY');
  assert.throws(() => validateServerEnv({ ...baseEnv, ADMIN_LEGACY_TOKEN_AUTH: '1' }), /ADMIN_OPERATOR_TOKEN is required/);
  for (const flag of ['true', 'yes', ' 1', 'on']) {
    assert.throws(() => validateServerEnv({ ...baseEnv, ADMIN_LEGACY_TOKEN_AUTH: flag, ADMIN_OPERATOR_TOKEN: 'x' }), /ADMIN_LEGACY_TOKEN_AUTH/);
  }
});

test('server env: ADMIN_OPERATORS is parsed at startup and a bad value fails without echoing it', () => {
  const env = validateServerEnv({ ...baseEnv, ADMIN_OPERATORS: JSON.stringify([{ wallet: a(12), operatorId: 'ops', permissions: ['vault:read', 'vault:write'] }]) });
  assert.deepEqual(env.adminOperators, [{ wallet: a(12), operatorId: 'ops', permissions: ['vault:read', 'vault:write'] }]);
  const secretLooking = JSON.stringify([{ wallet: a(12), operatorId: 'SHOULD_NOT_BE_ECHOED', permissions: ['vault:root'] }]);
  assert.throws(() => validateServerEnv({ ...baseEnv, ADMIN_OPERATORS: secretLooking }), (error: Error) => {
    assert.match(error.message, /^ADMIN_OPERATORS must be/);
    assert.doesNotMatch(error.message, /SHOULD_NOT_BE_ECHOED|vault:root/);
    return true;
  });
});
