import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonRecords, parseTap, verifyBrowser, verifyLifecycle } from './evidence.mjs';

const tap = overrides => Object.entries({ tests: 79, pass: 79, fail: 0, skipped: 0, todo: 0, ...overrides })
  .map(([key, value]) => `# ${key} ${value}`).join('\n');
const lines = records => records.map(record => JSON.stringify(record)).join('\n');
function browserRecords() {
  return [
    { kind: 'LOCAL_BROWSER_READY', ownerPid: 101, chromePid: 102 },
    { kind: 'LOCAL_BROWSER_RESOURCES_STOPPED', chromePid: 102, chromeExited: true, bridgeClosed: true, apiClosed: true },
    { kind: 'LOCAL_BROWSER_OWNED_SERVICES_STOPPED', ownerPid: 101, nodeGroup: 103, postgresPid: 104,
      postgresPidFileAbsent: true, postgresSocketAbsent: true, nodeGroupAbsent: true },
  ];
}
function browserResult(scenario = '') {
  return { result: 'PASS', pageErrors: [], execution: scenario === 'known-hash-ui'
    ? 'LOCAL_CHROME_KNOWN_HASH_UI_PG_EVM_ONLY' : 'LOCAL_CHROME_PG_EVM_ONLY',
  ...(scenario === 'known-hash-ui' ? { recoveryViaProductButtons: true } : {}),
  ...(scenario === 'operator-diagnostics' ? { operatorDiagnostics: {
    result: 'PASS', pageErrors: [], knownFindings: [], cases: [{ name: 'actual record' }], checks: [{ name: 'read-only' }],
  } } : {}) };
}
function lifecycleRecords() {
  return [['ready-SIGINT', 130], ['held-SIGTERM', 143], ['failure', 1]].map(([mode, code]) => ({
    kind: 'LOCAL_BROWSER_LIFECYCLE_PASS', mode, code, killedBy: null,
    ownerPid: 201, chromePid: 202, nodeGroup: 203, postgresPid: 204,
    chromeExited: true, apiClosed: true, bridgeClosed: true, rpcClosed: true,
    nodeGroupAbsent: true, postgresPidFileAbsent: true, pgSocketAbsent: true,
  }));
}

test('TAP accepts only the unindented complete reporter totals, including CRLF', () => {
  const output = `TAP version 13\n    # tests 1\n    # pass 1\nok 1 - parent\n${tap()}\n# duration_ms 20\n`.replaceAll('\n', '\r\n');
  assert.deepEqual(parseTap(output), { tests: 79, pass: 79, fail: 0, skipped: 0, todo: 0 });
});

test('TAP rejects skipped, failed, TODO, empty, inconsistent and unsafe totals', () => {
  for (const override of [{ skipped: 1 }, { fail: 1 }, { todo: 1 }, { tests: 0, pass: 0 },
    { tests: 80 }, { tests: '9007199254740992', pass: '9007199254740992' }, { tests: -1 }, { pass: 'NaN' }])
    assert.throws(() => parseTap(tap(override)));
});

test('TAP rejects truncated/missing summaries, nested-only totals and concatenated test runs', () => {
  for (const field of ['tests', 'pass', 'fail', 'skipped', 'todo'])
    assert.throws(() => parseTap(tap().split('\n').filter(line => !line.startsWith(`# ${field} `)).join('\n')), /Missing TAP summary/);
  assert.throws(() => parseTap(`    ${tap().replaceAll('\n', '\n    ')}`), /Missing TAP summary/);
  assert.throws(() => parseTap(`${tap()}\n${tap()}`), /Duplicate TAP summary/);
});

test('JSON extraction ignores logging, partial JSON, arrays and pretty-printed result documents', () => {
  const record = { kind: 'LOCAL_BROWSER_READY', ownerPid: 101 };
  const output = ['noise', JSON.stringify(record), '[{"kind":"wrong"}]', 'null', '{"kind":2}',
    '{"result":"PASS"}', 'prefix {"kind":"wrong"}', JSON.stringify({ result: 'PASS', nested: { kind: 'wrong' } }, null, 2),
    '{"kind":"truncated"'].join('\n');
  assert.deepEqual(jsonRecords(output), [record]);
});

test('browser acceptance returns matching ready and cleanup records for independent OS checks', () => {
  for (const scenario of ['', 'known-hash-ui', 'operator-diagnostics']) {
    const [ready, resources, stopped] = browserRecords();
    assert.deepEqual(verifyBrowser({ stdout: lines([ready, resources, stopped]), result: browserResult(scenario), scenario }),
      { ready, resources, stopped });
  }
});

test('browser PASS does not excuse absent, duplicate, reordered or false cleanup evidence', () => {
  for (const omitted of [0, 1, 2]) {
    const records = browserRecords(); records.splice(omitted, 1);
    assert.throws(() => verifyBrowser({ stdout: lines(records), result: browserResult() }));
  }
  for (const duplicated of [0, 1, 2]) {
    const records = browserRecords(); records.push(records[duplicated]);
    assert.throws(() => verifyBrowser({ stdout: lines(records), result: browserResult() }));
  }
  for (const [index, fields] of [[1, ['chromeExited', 'bridgeClosed', 'apiClosed']],
    [2, ['postgresPidFileAbsent', 'postgresSocketAbsent', 'nodeGroupAbsent']]]) {
    for (const field of fields) {
      const records = browserRecords(); records[index][field] = false;
      assert.throws(() => verifyBrowser({ stdout: lines(records), result: browserResult() }));
    }
  }
  assert.throws(() => verifyBrowser({ stdout: lines(browserRecords().reverse()), result: browserResult() }));
});

test('browser rejects foreign cleanup PIDs and invalid owned process identities', () => {
  for (const [index, field, value] of [[1, 'chromePid', 999], [2, 'ownerPid', 999],
    [0, 'ownerPid', 0], [0, 'chromePid', '102'], [2, 'nodeGroup', 1], [2, 'postgresPid', 103]]) {
    const records = browserRecords(); records[index][field] = value;
    assert.throws(() => verifyBrowser({ stdout: lines(records), result: browserResult() }));
  }
});

test('browser rejects missing/failed results, page errors and mismatched requested scenarios', () => {
  for (const result of [undefined, {}, { ...browserResult(), result: 'FAIL' }, { ...browserResult(), pageErrors: ['error'] },
    { ...browserResult(), pageErrors: undefined }])
    assert.throws(() => verifyBrowser({ stdout: lines(browserRecords()), result }));
  assert.throws(() => verifyBrowser({ stdout: lines(browserRecords()), result: browserResult(), scenario: 'known-hash-ui' }));
  assert.throws(() => verifyBrowser({ stdout: lines(browserRecords()), result: browserResult(), scenario: 'typo' }));
  const result = browserResult('known-hash-ui'); result.recoveryViaProductButtons = false;
  assert.throws(() => verifyBrowser({ stdout: lines(browserRecords()), result, scenario: 'known-hash-ui' }));
});

test('top-level PASS cannot hide operator findings, nested failure, page errors or missing coverage', () => {
  for (const [field, value] of [['result', 'PASS_WITH_KNOWN_P3'], ['knownFindings', [{ id: 'unresolved' }]],
    ['knownFindings', undefined], ['pageErrors', ['error']], ['cases', []], ['checks', []]]) {
    const result = browserResult('operator-diagnostics'); result.operatorDiagnostics[field] = value;
    assert.throws(() => verifyBrowser({ stdout: lines(browserRecords()), result, scenario: 'operator-diagnostics' }));
  }
  assert.throws(() => verifyBrowser({ stdout: lines(browserRecords()), result: browserResult(), scenario: 'operator-diagnostics' }));
});

test('lifecycle accepts each expected self-cleaned signal/failure exit exactly once', () => {
  const records = lifecycleRecords();
  assert.deepEqual(verifyLifecycle(lines(records)), records);
});

test('lifecycle rejects missing/duplicate modes, unexpected exits and default signal termination', () => {
  const valid = lifecycleRecords();
  for (const records of [valid.slice(1), [...valid, valid[0]], [valid[0], valid[0], valid[2]]])
    assert.throws(() => verifyLifecycle(lines(records)));
  for (const [field, value] of [['mode', 'unknown'], ['code', 0], ['killedBy', 'SIGTERM']]) {
    const records = lifecycleRecords(); records[1][field] = value;
    assert.throws(() => verifyLifecycle(lines(records)));
  }
});

test('lifecycle rejects unconfirmed cleanup and invalid or overlapping process identities', () => {
  for (const field of ['chromeExited', 'apiClosed', 'bridgeClosed', 'rpcClosed', 'nodeGroupAbsent',
    'postgresPidFileAbsent', 'pgSocketAbsent']) {
    const records = lifecycleRecords(); records[2][field] = false;
    assert.throws(() => verifyLifecycle(lines(records)));
  }
  for (const [field, value] of [['ownerPid', 1], ['chromePid', -3], ['nodeGroup', '203'], ['postgresPid', 201]]) {
    const records = lifecycleRecords(); records[0][field] = value;
    assert.throws(() => verifyLifecycle(lines(records)));
  }
});
