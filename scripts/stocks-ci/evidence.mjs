// Pure acceptance checks. Exit status and independent OS cleanup checks belong
// to the runner; a scenario's PASS result alone is not sufficient evidence.
import assert from 'node:assert/strict';
import { OPERATOR_CONTROL_UI_CHECK_IDS } from '../stocks-local/operator-control-ui-checks.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positivePid = (value, label) => assert.ok(Number.isSafeInteger(value) && value > 1, `${label}: invalid owned PID`);
const flags = (record, names, label) => {
  for (const name of names) assert.equal(record[name], true, `${label}: ${name} must be true`);
};

export function parseTap(text) {
  assert.equal(typeof text, 'string', 'TAP output must be text');
  const summary = {};
  for (const line of text.split(/\r?\n/)) {
    // Nested node:test suites indent their own summaries. Only the final,
    // unindented reporter totals can establish that the whole command passed.
    const match = /^# (tests|pass|fail|skipped|todo) ([0-9]+)[ \t]*$/.exec(line);
    if (!match) continue;
    const [, key, digits] = match;
    assert.ok(!Object.hasOwn(summary, key), `Duplicate TAP summary: ${key}`);
    const value = Number(digits);
    assert.ok(Number.isSafeInteger(value), `Invalid TAP summary: ${key}`);
    summary[key] = value;
  }
  for (const key of ['tests', 'pass', 'fail', 'skipped', 'todo'])
    assert.ok(Object.hasOwn(summary, key), `Missing TAP summary: ${key}`);
  assert.ok(summary.tests > 0, 'TAP must execute at least one test');
  assert.equal(summary.pass, summary.tests, 'Every TAP test must pass');
  assert.equal(summary.fail, 0, 'TAP contains failures');
  assert.equal(summary.skipped, 0, 'TAP contains skipped tests');
  assert.equal(summary.todo, 0, 'TAP contains TODO tests');
  return summary;
}

export function jsonRecords(text) {
  assert.equal(typeof text, 'string', 'Runner output must be text');
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (object(value) && typeof value.kind === 'string' && value.kind.length > 0) records.push(value);
  }
  return records;
}

function exactlyOne(records, kind) {
  const matches = records.filter(record => record.kind === kind);
  assert.equal(matches.length, 1, `Expected exactly one ${kind} record`);
  return matches[0];
}

export function verifyBrowser({ stdout, result, scenario = '' }) {
  const executions = {
    '': 'LOCAL_CHROME_PG_EVM_ONLY',
    'operator-diagnostics': 'LOCAL_CHROME_PG_EVM_ONLY',
    'operator-control-ui': 'LOCAL_CHROME_PG_EVM_ONLY',
    'known-hash': 'LOCAL_CHROME_KNOWN_HASH_RECOVERY_PG_EVM_ONLY',
    'known-hash-ui': 'LOCAL_CHROME_KNOWN_HASH_UI_PG_EVM_ONLY',
  };
  assert.ok(Object.hasOwn(executions, scenario), 'Unsupported browser scenario');
  const records = jsonRecords(stdout);
  const ready = exactlyOne(records, 'LOCAL_BROWSER_READY');
  const resources = exactlyOne(records, 'LOCAL_BROWSER_RESOURCES_STOPPED');
  const stopped = exactlyOne(records, 'LOCAL_BROWSER_OWNED_SERVICES_STOPPED');
  assert.ok(records.indexOf(ready) < records.indexOf(resources) && records.indexOf(resources) < records.indexOf(stopped),
    'Browser cleanup records must follow readiness in cleanup order');
  for (const [label, value] of [['ready.ownerPid', ready.ownerPid], ['ready.chromePid', ready.chromePid],
    ['stopped.nodeGroup', stopped.nodeGroup], ['stopped.postgresPid', stopped.postgresPid]]) positivePid(value, label);
  assert.equal(stopped.ownerPid, ready.ownerPid, 'Cleanup belongs to another runner');
  assert.equal(resources.chromePid, ready.chromePid, 'Cleanup belongs to another Chrome process');
  assert.equal(new Set([ready.ownerPid, ready.chromePid, stopped.nodeGroup, stopped.postgresPid]).size, 4,
    'Runner, Chrome, EVM and PostgreSQL must identify distinct processes');
  flags(resources, ['chromeExited', 'bridgeClosed', 'apiClosed'], 'Browser cleanup');
  flags(stopped, ['postgresPidFileAbsent', 'postgresSocketAbsent', 'nodeGroupAbsent'], 'Owned service cleanup');

  assert.ok(object(result), 'Browser result must be an object');
  assert.equal(result.result, 'PASS', 'Browser scenario did not pass');
  assert.equal(result.execution, executions[scenario], 'Browser result is for a different scenario');
  assert.deepEqual(result.pageErrors, [], 'Browser page errors must be empty');
  if (scenario === 'known-hash-ui') assert.equal(result.recoveryViaProductButtons, true, 'Product recovery buttons were not tested');
  if (scenario === 'operator-diagnostics') {
    const diagnostics = result.operatorDiagnostics;
    assert.ok(object(diagnostics), 'Operator diagnostics result is missing');
    assert.equal(diagnostics.result, 'PASS', 'Operator diagnostics did not pass');
    assert.deepEqual(diagnostics.pageErrors, [], 'Operator diagnostics page errors must be empty');
    assert.deepEqual(diagnostics.knownFindings, [], 'Operator diagnostics has unresolved findings');
    assert.ok(Array.isArray(diagnostics.cases) && diagnostics.cases.length > 0, 'Operator diagnostics cases are missing');
    assert.ok(Array.isArray(diagnostics.checks) && diagnostics.checks.length > 0, 'Operator diagnostics checks are missing');
  }
  if (scenario === 'operator-control-ui') verifyControlUi(result);
  return { ready, resources, stopped };
}

function namedCoverage(values, count, label) {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  assert.equal(values.length, count, `${label} has incomplete coverage`);
  assert.ok(values.every(value => typeof value === 'string' && value.trim().length > 0), `${label} needs named checks`);
  assert.equal(new Set(values).size, count, `${label} contains duplicate checks`);
}

function verifyControlUi(result) {
  assert.equal(result.actualRoutes, true, 'Control UI must use product routes');
  assert.equal(result.strictMode, true, 'Control UI must run in StrictMode');
  assert.ok(Array.isArray(result.scenarios), 'Investor regressions are missing');
  namedCoverage(result.scenarios.map(row => row?.name), 19, 'Investor regressions');
  const control = result.operatorControl;
  assert.ok(object(control), 'Operator control UI result is missing');
  assert.equal(control.result, 'PASS', 'Operator control UI did not pass');
  assert.deepEqual(control.pageErrors, [], 'Operator control UI page errors must be empty');
  assert.deepEqual(control.knownFindings, [], 'Operator control UI has unresolved findings');
  namedCoverage(control.checks, OPERATOR_CONTROL_UI_CHECK_IDS.length, 'Operator control UI checks');
  namedCoverage(control.checkIds, OPERATOR_CONTROL_UI_CHECK_IDS.length, 'Operator control UI check identities');
  assert.deepEqual([...control.checkIds].sort(), [...OPERATOR_CONTROL_UI_CHECK_IDS].sort(), 'Required operator control UI coverage is missing');
  assert.equal(control.walletSends, 0, 'Control UI must not send wallet transactions');
  assert.ok(Array.isArray(control.walletMethods) && control.walletMethods.includes('personal_sign'), 'Operator sign-in evidence is missing');
  assert.ok(control.walletMethods.every(method => ['personal_sign', 'eth_accounts', 'eth_chainId'].includes(method)), 'Unexpected control UI wallet operation');
  assert.ok(Array.isArray(control.controlPosts) && control.controlPosts.length === 10, 'Ten reviewed control attempts must be recorded');
  for (const command of control.controlPosts) {
    assert.ok(object(command), 'Control attempt must be an object');
    assert.deepEqual(Object.keys(command).sort(), ['expectedVersion', 'idempotencyKey', 'paused', 'reason'], 'Control command field mismatch');
    assert.equal(typeof command.paused, 'boolean');
    assert.ok(Number.isInteger(command.expectedVersion) && command.expectedVersion >= 0 && command.expectedVersion <= 2147483646);
    assert.ok(typeof command.idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(command.idempotencyKey));
    assert.ok(typeof command.reason === 'string' && command.reason.trim().length > 0 && command.reason.length <= 500);
  }
  const state = control.finalControl;
  assert.ok(object(state), 'Final control state is missing');
  assert.equal(state.paused, false, 'Control gate must be resumed for investor regression');
  assert.ok(Number.isInteger(state.version) && state.version > 0 && state.version <= 2147483647, 'Control revision is invalid');
  assert.ok(typeof state.deploymentDigest === 'string' && /^[0-9a-f]{64}$/.test(state.deploymentDigest), 'Control deployment is invalid');
  const snapshot = result.final?.snapshot;
  assert.ok(object(snapshot), 'Final independent snapshot is missing');
  for (const [field, value] of Object.entries({ holderStock: '1250000000', stockSupply: '1250000000', escrowStock: '0',
    holderCash: '1850000000', vaultCash: '150000000' })) assert.equal(snapshot.chain?.[field], value, `Final ${field} mismatch`);
  assert.equal(snapshot.reconciliation?.status, 'MATCHED_AT_CUTOFF', 'Reconciliation must match');
  assert.deepEqual(snapshot.reconciliation?.differences, [], 'Reconciliation differences remain');
  assert.equal(snapshot.reconciliation?.cutoff?.deploymentDigest, state.deploymentDigest, 'Reconciled deployment differs');
  assert.equal(snapshot.runtimeStatus?.deploymentDigest, state.deploymentDigest, 'Runtime deployment differs');
  assert.equal(snapshot.runtimeStatus?.newOrdersPaused, false, 'Runtime is still paused');
  assert.deepEqual(snapshot.runtimeStatus?.operatorControl, { status: 'RESUMED', version: state.version });
  assert.ok(Array.isArray(snapshot.claims) && snapshot.claims.length === 7, 'Seven durable claims are required');
  const claims = new Map(snapshot.claims.map(claim => [claim?.claimId, claim]));
  assert.equal(claims.size, 7, 'Durable claims must be distinct');
  const dispatch = result.dispatchEvidence;
  assert.equal(dispatch?.proof, 'REAL_PG_CLAIM_RESPONSE_BEFORE_SINGLE_EVM_SEND', 'Claim-before-send proof is missing');
  assert.ok(Array.isArray(dispatch.attempts) && dispatch.attempts.length === 7, 'Seven investor sends are required');
  assert.equal(new Set(dispatch.attempts.map(attempt => attempt?.claimId)).size, 7, 'Dispatch claims must be distinct');
  assert.equal(new Set(dispatch.attempts.map(attempt => attempt?.txHash)).size, 7, 'Investor sends must be distinct');
  for (const attempt of dispatch.attempts) {
    assert.ok(object(attempt), 'Dispatch attempt is missing');
    const claim = claims.get(attempt.claimId);
    assert.ok(object(claim), 'Dispatch has no matching durable claim');
    for (const field of ['claimId', 'orderId', 'side', 'stage']) {
      assert.ok(typeof attempt[field] === 'string' && attempt[field].length > 0, `Dispatch ${field} missing`);
      assert.equal(attempt[field], claim[field], `Dispatch ${field} differs from claim`);
    }
    assert.ok(['BUY', 'SELL'].includes(attempt.side) && ['APPROVAL', 'TRANSFER'].includes(attempt.stage));
    assert.ok(Number.isSafeInteger(attempt.claimResponseSeq) && attempt.claimResponseSeq > 0);
    assert.ok(Number.isSafeInteger(attempt.sendSeq) && attempt.claimResponseSeq < attempt.sendSeq, 'Send preceded the durable claim response');
    assert.ok(typeof attempt.txHash === 'string' && /^0x[0-9a-f]{64}$/.test(attempt.txHash));
  }
}

export function verifyLifecycle(stdout) {
  const expected = { 'ready-SIGINT': 130, 'held-SIGTERM': 143, failure: 1 };
  const records = jsonRecords(stdout).filter(record => record.kind === 'LOCAL_BROWSER_LIFECYCLE_PASS');
  assert.equal(records.length, 3, 'Expected three lifecycle PASS records');
  for (const record of records) assert.ok(Object.hasOwn(expected, record.mode), 'Unknown lifecycle mode');
  return Object.entries(expected).map(([mode, code]) => {
    const matches = records.filter(record => record.mode === mode);
    assert.equal(matches.length, 1, `Expected exactly one lifecycle result: ${mode}`);
    const record = matches[0];
    assert.equal(record.code, code, `${mode}: unexpected exit code`);
    assert.equal(record.killedBy, null, `${mode}: runner must finish its own cleanup`);
    const pids = ['ownerPid', 'chromePid', 'nodeGroup', 'postgresPid'];
    for (const key of pids) positivePid(record[key], `${mode}.${key}`);
    assert.equal(new Set(pids.map(key => record[key])).size, pids.length, `${mode}: process identities must be distinct`);
    flags(record, ['chromeExited', 'apiClosed', 'bridgeClosed', 'rpcClosed', 'nodeGroupAbsent',
      'postgresPidFileAbsent', 'pgSocketAbsent'], mode);
    return record;
  });
}

export function verifyOperatorControl(stdout) {
  const records = jsonRecords(stdout);
  const result = exactlyOne(records, 'LOCAL_STACK_RESULT');
  const stopped = exactlyOne(records, 'LOCAL_STACK_OWNED_SERVICES_STOPPED');
  assert.ok(records.indexOf(result) < records.indexOf(stopped), 'Stack cleanup must follow the complete result');
  const pids = ['ownerPid', 'nodeGroup', 'postgresPid'];
  for (const key of pids) positivePid(stopped[key], `Stack cleanup.${key}`);
  assert.equal(new Set(pids.map(key => stopped[key])).size, pids.length, 'Stack process identities must be distinct');
  flags(stopped, ['postgresPidFileAbsent', 'postgresSocketAbsent', 'nodeGroupAbsent'], 'Stack cleanup');

  assert.equal(result.result, 'PASS', 'Local stack did not pass');
  assert.equal(result.execution, 'LOCAL_EVM_TEST_HARNESS_ONLY', 'Result must come from the real local stack');
  assert.equal(result.chainId, 91342, 'Local chain identity is wrong');
  const coverage = (values, count, label) => {
    assert.ok(Array.isArray(values), `${label} must be an array`);
    assert.equal(values.length, count, `${label} has incomplete coverage`);
    assert.ok(values.every(value => typeof value === 'string' && value.trim().length > 0), `${label} requires named checks`);
    assert.equal(new Set(values).size, count, `${label} cannot repeat the same check`);
  };
  coverage(result.scenarios, 19, 'Local stack scenarios');
  const control = result.operatorControl;
  assert.ok(object(control), 'Operator control result is missing');
  assert.equal(control.result, 'PASS', 'Operator control did not pass');
  coverage(control.checks, 8, 'Operator control checks');
  assert.ok(Number.isInteger(control.lastVersion) && control.lastVersion > 0 && control.lastVersion <= 2147483647,
    'Operator control revision is invalid');
  assert.equal(control.additionalSignerOperations, 2, 'Operator roundtrip must create exactly two signer operations');
  assert.deepEqual(result.final, {
    stockWalletUnits: '3000000000', stockEscrowUnits: '0', stockSupplyUnits: '3000000000',
    cashVaultUnits: '360000000', reconciliation: 'MATCHED_AT_CUTOFF', durableSignerOperations: 14,
  }, 'Independent final economic results do not match');
  // Actual exit status, OS PID/group absence and temp removal are still checked
  // by the caller. A self-reported cleanup record cannot prove these alone.
  return { result, stopped };
}
