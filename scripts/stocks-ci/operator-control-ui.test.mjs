import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBrowser } from './evidence.mjs';

const digest = 'a'.repeat(64);
const ids = ['initial-paused', 'single-submit-other-gate', 'lost-response-replay', 'operator-cas', 'role-denials',
  'other-operator-uncertainty', 'same-operator-other-key', 'history-pages-viewports', 'deployment-history-isolation', 'unavailable-routes'];
const stdout = [
  { kind: 'LOCAL_BROWSER_READY', ownerPid: 101, chromePid: 102 },
  { kind: 'LOCAL_BROWSER_RESOURCES_STOPPED', chromePid: 102, chromeExited: true, bridgeClosed: true, apiClosed: true },
  { kind: 'LOCAL_BROWSER_OWNED_SERVICES_STOPPED', ownerPid: 101, nodeGroup: 103, postgresPid: 104,
    postgresPidFileAbsent: true, postgresSocketAbsent: true, nodeGroupAbsent: true },
].map(row => JSON.stringify(row)).join('\n');
function fixture() {
  const claims = Array.from({ length: 7 }, (_, n) => ({ claimId: `claim-${n}`, orderId: `order-${n}`, side: n < 3 ? 'BUY' : 'SELL', stage: n % 2 ? 'TRANSFER' : 'APPROVAL' }));
  return {
    result: 'PASS', execution: 'LOCAL_CHROME_PG_EVM_ONLY', actualRoutes: true, strictMode: true, pageErrors: [],
    scenarios: Array.from({ length: 19 }, (_, n) => ({ name: `Investor case ${n}` })),
    operatorControl: {
      result: 'PASS', checks: ids.map(id => `Completed ${id}`), checkIds: [...ids], pageErrors: [], knownFindings: [],
      walletSends: 0, walletMethods: ['personal_sign'],
      controlPosts: Array.from({ length: 10 }, (_, n) => ({ paused: n % 2 === 0, expectedVersion: n,
        idempotencyKey: `test-key-${n}`, reason: `Reason ${n}` })),
      finalControl: { deploymentDigest: digest, paused: false, version: 30 },
    },
    dispatchEvidence: { proof: 'REAL_PG_CLAIM_RESPONSE_BEFORE_SINGLE_EVM_SEND', attempts: claims.map((claim, n) => ({
      ...claim, claimResponseSeq: n * 3 + 1, sendSeq: n * 3 + 2, txHash: `0x${String(n + 1).padStart(64, '0')}`,
    })) },
    final: { snapshot: { claims,
      chain: { holderStock: '1250000000', stockSupply: '1250000000', escrowStock: '0', holderCash: '1850000000', vaultCash: '150000000' },
      reconciliation: { status: 'MATCHED_AT_CUTOFF', differences: [], cutoff: { deploymentDigest: digest } },
      runtimeStatus: { deploymentDigest: digest, newOrdersPaused: false, operatorControl: { status: 'RESUMED', version: 30 } },
    } },
  };
}
const verify = result => verifyBrowser({ stdout, result, scenario: 'operator-control-ui' });

test('operator-control UI accepts all required checks, real-route evidence, seven claims and final economic results', () => {
  assert.equal(verify(fixture()).ready.ownerPid, 101);
});

test('investor regressions may repeat an action title for distinct orders or balances', () => {
  const r = fixture();
  r.scenarios[0] = { name: 'Browser portfolio matches chain', quantity: '2' };
  r.scenarios[1] = { name: 'Browser portfolio matches chain', quantity: '1.5' };
  assert.equal(verify(r).ready.ownerPid, 101);
});

test('operator-control UI rejects a plain investor report and incomplete or duplicate case identities', () => {
  for (const mutate of [
    r => { delete r.operatorControl; },
    r => { delete r.operatorControl.checkIds; },
    r => { r.operatorControl.checkIds.pop(); },
    r => { r.operatorControl.checkIds[9] = r.operatorControl.checkIds[0]; },
    r => { r.operatorControl.checkIds[9] = 'arbitrary-check'; },
    r => { r.operatorControl.checks.pop(); },
    r => { r.operatorControl.checks[9] = r.operatorControl.checks[0]; },
    r => { r.operatorControl.checks[9] = ' '; },
    r => { r.scenarios.pop(); },
    r => { r.scenarios[18] = r.scenarios[0]; },
    r => { r.scenarios[18] = { name: '' }; },
  ]) { const r = fixture(); mutate(r); assert.throws(() => verify(r)); }
});

test('top-level PASS cannot hide UI findings, page failures, missing status or simulated routes', () => {
  for (const [field, value] of [['result', 'PASS_WITH_KNOWN_P2'], ['knownFindings', [{ id: 'remaining' }]],
    ['knownFindings', undefined], ['pageErrors', ['runtime-error']], ['pageErrors', undefined]]) {
    const r = fixture(); r.operatorControl[field] = value; assert.throws(() => verify(r));
  }
  for (const field of ['actualRoutes', 'strictMode']) {
    for (const value of [false, undefined]) { const r = fixture(); r[field] = value; assert.throws(() => verify(r)); }
  }
});

test('operator-control UI refuses wallet transaction calls and incomplete command evidence', () => {
  for (const [field, value] of [['walletSends', 1], ['walletSends', undefined], ['walletSends', '0'],
    ['walletMethods', []], ['walletMethods', ['eth_sendTransaction']], ['walletMethods', ['eth_signTransaction']],
    ['walletMethods', ['personal_sign', 'wallet_sendCalls']], ['walletMethods', undefined], ['controlPosts', []]]) {
    const r = fixture(); r.operatorControl[field] = value; assert.throws(() => verify(r));
  }
  for (const mutate of [p => { p.operatorId = 'spoofed'; }, p => { delete p.reason; }, p => { p.paused = 'false'; },
    p => { p.expectedVersion = -1; }, p => { p.expectedVersion = 1.5; }, p => { p.expectedVersion = 2147483647; },
    p => { p.idempotencyKey = ''; }, p => { p.reason = ''; }]) {
    const r = fixture(); mutate(r.operatorControl.controlPosts[0]); assert.throws(() => verify(r));
  }
});

test('operator-control UI requires resumed final state on the original reconciled deployment', () => {
  for (const mutate of [r => { delete r.operatorControl.finalControl; }, r => { r.operatorControl.finalControl.paused = true; },
    r => { r.operatorControl.finalControl.version = 0; }, r => { r.operatorControl.finalControl.version = '30'; },
    r => { r.operatorControl.finalControl.deploymentDigest = 'b'.repeat(64); },
    r => { r.final.snapshot.runtimeStatus.newOrdersPaused = true; },
    r => { r.final.snapshot.runtimeStatus.operatorControl.version = 29; },
    r => { r.final.snapshot.runtimeStatus.operatorControl.status = 'PAUSED'; },
    r => { r.final.snapshot.reconciliation.cutoff.deploymentDigest = 'b'.repeat(64); }]) {
    const r = fixture(); mutate(r); assert.throws(() => verify(r));
  }
});

test('operator-control UI rejects missing balances, reconciliation differences and mismatched dispatch proofs', () => {
  for (const field of Object.keys(fixture().final.snapshot.chain)) {
    for (const value of [undefined, '999']) { const r = fixture(); r.final.snapshot.chain[field] = value; assert.throws(() => verify(r)); }
  }
  for (const mutate of [r => { r.final.snapshot.reconciliation.status = 'UNAVAILABLE'; },
    r => { r.final.snapshot.reconciliation.differences = ['mismatch']; },
    r => { r.final.snapshot.claims.pop(); }, r => { r.final.snapshot.claims[1] = r.final.snapshot.claims[0]; },
    r => { delete r.dispatchEvidence; }, r => { r.dispatchEvidence.proof = 'simulated'; },
    r => { r.dispatchEvidence.attempts.pop(); }, r => { r.dispatchEvidence.attempts[1] = r.dispatchEvidence.attempts[0]; },
    r => { r.dispatchEvidence.attempts[0].claimResponseSeq = r.dispatchEvidence.attempts[0].sendSeq; },
    r => { r.dispatchEvidence.attempts[0].sendSeq = -1; },
    r => { r.dispatchEvidence.attempts[0].claimId = 'foreign-claim'; },
    r => { r.dispatchEvidence.attempts[0].orderId = 'foreign-order'; },
    r => { r.dispatchEvidence.attempts[0].stage = 'different-stage'; },
    r => { r.dispatchEvidence.attempts[0].txHash = r.dispatchEvidence.attempts[1].txHash; }]) {
    const r = fixture(); mutate(r); assert.throws(() => verify(r));
  }
});

test('operator-control UI still requires matching ordered service shutdown records', () => {
  assert.throws(() => verifyBrowser({ stdout: stdout.replace('"chromeExited":true', '"chromeExited":false'), result: fixture(), scenario: 'operator-control-ui' }));
  assert.throws(() => verifyBrowser({ stdout: stdout.split('\n').slice(0, 2).join('\n'), result: fixture(), scenario: 'operator-control-ui' }));
});
