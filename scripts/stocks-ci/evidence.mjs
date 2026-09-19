// Pure acceptance checks. Exit status and independent OS cleanup checks belong
// to the runner; a scenario's PASS result alone is not sufficient evidence.
import assert from 'node:assert/strict';

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
  return { ready, resources, stopped };
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
