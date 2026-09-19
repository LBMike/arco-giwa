// Real /admin/stocks route, signed local SIWE operator, PostgreSQL and EVM.
// Fixtures are prepared separately; all subsequent UI reads must be side-effect free.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareOperatorDiagnosticsFixtures } from './operator-diagnostics-fixtures.mjs';

export async function runOperatorDiagnosticsScenario({ host, stack, wallet, browser, evidence }) {
  assert.equal(stack.operatorDiagnostics, true);
  const fixtures = await prepareOperatorDiagnosticsFixtures(stack);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const report = { cases: [], checks: [], http: [], pageErrors: [], knownFindings: [], screenshots: [],
    fixtureSends: fixtures.fixtureSends, limitations: fixtures.limitations };
  const attempts = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === stack.apiBase || (url.origin === host.origin && url.pathname === '/__local/wallet'))
      attempts.push({ origin: url.origin, path: url.pathname, method: request.method(), hasBody: request.postData() !== null });
  });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === stack.apiBase) report.http.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });
  const panel = () => page.getByTestId('stocks-admin-diagnostics');
  const refresh = () => page.getByRole('button', { name: 'Refresh wallet submissions', exact: true });
  const pathOf = row => `/api/v1/admin/stocks/wallet-submissions/${row.side}/${row.orderId}`;
  function passed(name, details = {}) {
    report.checks.push({ name, ...details });
    console.log(`STOCKS_LOCAL_DIAGNOSTICS_STEP ${JSON.stringify({ name, ...details })}`);
  }
  async function wait(read, label) {
    const deadline = performance.now() + 15000;
    for (;;) { if (await read()) return; assert.ok(performance.now() < deadline, label); await delay(50); }
  }
  async function control(name) {
    await page.locator(`[data-local-action="${name}"]`).click();
    await wait(async () => !await page.locator('[data-local-action="refresh"]').isDisabled(), name);
    assert.doesNotMatch(await page.getByTestId('local-test-message').innerText(), /FAILED/);
  }
  async function signIn() {
    await page.getByRole('region', { name: 'Stocks sign-in', exact: true })
      .getByRole('button', { name: /^(Sign in to Stocks|Retry Stocks sign-in)$/ }).click();
    await page.getByRole('region', { name: 'Stocks sign-in', exact: true })
      .getByRole('button', { name: 'Sign out of Stocks', exact: true }).waitFor();
  }
  async function ready() { await wait(async () => await panel().getAttribute('data-phase') === 'ready', 'Diagnostics ready'); }
  async function select(row) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === pathOf(row));
    await page.getByRole('button', { name: `Show detail for ${row.side} order ${row.orderId}`, exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200); assert.equal(result.headers()['cache-control'], 'no-store');
    const body = await result.json(); await ready(); return body;
  }
  async function screenshot(name, cardOnly = false) {
    const file = resolve(evidence, name);
    if (cardOnly) await panel().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push(file);
  }
  const factsDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    await page.goto(`${host.origin}/admin/stocks`);
    await control('account-operator'); await signIn();
    await page.getByRole('tab', { name: 'Orders', exact: true }).click();
    const beforeFacts = await fixtures.snapshotFacts();
    const walletBefore = wallet.calls.length, sendsBefore = wallet.sends.length, requestsBefore = stack.requests.length;
    const attemptsBefore = attempts.length;
    for (const row of fixtures.cases) {
      const body = await select(row), actual = body.data;
      assert.equal(actual.order.id, row.orderId); assert.equal(actual.order.side, row.side);
      assert.equal(actual.readOnly, true); assert.equal(actual.executionAuthorization, false); assert.equal(actual.resubmissionAllowed, false);
      assert.equal(actual.enrollment, row.expected.enrollment);
      assert.equal(actual.order.state, row.expected.order.state);
      const text = await panel().innerText(); assert.ok(text.includes(body.observedAt));
      for (const stage of ['APPROVAL', 'TRANSFER']) {
        const key = stage === 'APPROVAL' ? 'approval' : 'transfer', expected = row.expected[key];
        assert.deepEqual(actual[key], expected);
        const section = panel().locator(`[data-stage="${stage}"]`);
        assert.equal(await section.getAttribute('data-status'), expected?.status ?? 'NONE');
        const wording = stage === 'APPROVAL' ? 'Approval' : row.side === 'BUY' ? 'Deposit' : 'Escrow';
        assert.ok((await section.innerText()).includes(wording));
        if (expected?.txHash) assert.ok((await section.innerText()).includes(expected.txHash));
        if (expected && !expected.txHash) assert.ok((await section.innerText()).includes('No recorded hash'));
        if (expected?.receipt) assert.ok((await section.innerText()).includes(expected.receipt.blockHash));
      }
      if (actual.order.quoteExpired) assert.ok(text.includes('Passed as of the snapshot'));
      report.cases.push({ name: row.name, orderId: row.orderId, side: row.side, provenance: row.provenance,
        approval: actual.approval?.status ?? null, transfer: actual.transfer?.status ?? null,
        enrollment: actual.enrollment, expired: actual.order.quoteExpired });
    }
    passed('Real PostgreSQL records and trusted EVM receipt summaries rendered', { cases: report.cases.length });
    const target = fixtures.cases.find(row => row.side === 'SELL' && row.expected.transfer?.status === 'CONFIRMED');
    await select(target);
    for (const key of ['Enter', 'Space']) {
      const requestCount = attempts.filter(row => row.path === pathOf(target)).length;
      const response = page.waitForResponse(r => new URL(r.url()).pathname === pathOf(target));
      await refresh().focus(); await page.keyboard.press(key); assert.equal((await response).status(), 200); await ready();
      assert.equal(attempts.filter(row => row.path === pathOf(target)).length, requestCount + 1);
    }
    passed('Native keyboard Enter and Space each refresh once');
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(dimensions.document <= dimensions.viewport, `No horizontal overflow at ${width}px`);
      await panel().scrollIntoViewIfNeeded(); await screenshot(`diagnostics-${width}.png`, true);
    }
    passed('375 / 768 / 1440 layouts have no horizontal overflow');

    // Both errors come from actual Fastify responses: a foreign-deployment row
    // and an unregistered route. Retained and initially empty cards differ.
    const firstErrorOrder = fixtures.cases.find(row => row.side === 'BUY' && row.expected.approval?.status === 'UNKNOWN');
    for (const kind of ['not_found', 'disabled']) {
      const title = kind === 'not_found' ? 'Order not found in the current deployment (404)'
        : 'Wallet submission diagnostics are not available on this server (404)';
      const destination = row => kind === 'not_found'
        ? `${stack.apiBase}${pathOf(fixtures.foreignOrders.find(foreign => foreign.side === row.side))}`
        : `${stack.apiBase}/__local_missing_submission_diagnostics`;
      await page.route(`${stack.apiBase}${pathOf(target)}`, route => route.continue({ url: destination(target) }), { times: 1 });
      await refresh().click(); await wait(async () => await panel().getAttribute('data-phase') === 'error', `${kind} retained404`);
      let text = await panel().innerText();
      assert.ok(text.includes(title));
      assert.ok(text.includes('No new diagnostics were received.'));
      assert.ok(text.includes('from the earlier snapshot'));
      assert.ok(text.includes(target.expected.transfer.txHash));
      assert.doesNotMatch(text, /nothing is shown/i, '003E-1: a visible earlier record must never be described as absent');
      await screenshot(`diagnostics-${kind}-retained-snapshot.png`, true);
      passed(`${kind}: real404 preserves labeled earlier data without contradictory copy`);

      await page.route(`${stack.apiBase}${pathOf(firstErrorOrder)}`, route => route.continue({ url: destination(firstErrorOrder) }), { times: 1 });
      await page.getByRole('button', { name: `Show detail for ${firstErrorOrder.side} order ${firstErrorOrder.orderId}`, exact: true }).click();
      await wait(async () => await panel().getAttribute('data-phase') === 'error', `${kind} initial404`);
      text = await panel().innerText();
      assert.ok(text.includes(title) && text.includes('Nothing is shown.'));
      assert.ok(!text.includes('earlier snapshot') && !text.includes('Server snapshot'));
      assert.equal(await panel().locator('[data-stage]').count(), 0);
      assert.ok(!text.includes(target.expected.transfer.txHash));
      await screenshot(`diagnostics-${kind}-initial-empty.png`, true);
      passed(`${kind}: initial404 has no earlier record or leaked hash`);
      await select(target);
    }

    await page.route(`${stack.apiBase}${pathOf(target)}`, route => route.abort('failed'), { times: 1 });
    await refresh().click(); await wait(async () => await panel().getAttribute('data-phase') === 'error', 'Interrupted refresh');
    const text = await panel().innerText(); assert.ok(text.includes('from the earlier snapshot'));
    await refresh().click(); await ready(); passed('Interrupted read preserves an explicitly old snapshot; manual retry succeeds');

    const held = [];
    await page.route(`${stack.apiBase}${pathOf(target)}`, route => new Promise(resolveHold => held.push(async () => { await route.continue(); resolveHold(); })), { times: 1 });
    await refresh().click(); await wait(() => held.length === 1, 'Held refresh');
    assert.equal(await refresh().isDisabled(), true);
    const other = fixtures.cases.find(row => row.side === 'BUY' && row.expected.approval?.status === 'UNKNOWN');
    await select(other); await held[0]();
    await ready(); assert.equal(await panel().locator('[data-stage="APPROVAL"]').getAttribute('data-status'), 'UNKNOWN');
    assert.ok(!(await panel().innerText()).includes(target.expected.transfer.txHash));
    passed('Selecting another order cancels a held refresh and hides its prior hash');

    // Permanent stop of the disposable runtime blocks new execution. Its
    // read-only endpoints remain usable; this is not configuredPause=true.
    await stack.stopRuntime();
    const status = await stack.snapshot(); assert.equal(status.runtimeStatus.newOrdersPaused, true);
    assert.equal(status.runtimeStatus.runtimeState, 'STOPPED');
    assert.equal(status.runtimeStatus.configuredPause, false);
    const expired = fixtures.cases.find(row => row.expected.enrollment === 'NOT_ENROLLED' && row.side === 'BUY');
    await select(expired); passed('Stopped runtime and expired order remain readable', { runtimeState: status.runtimeStatus.runtimeState });
    assert.equal(wallet.calls.length, walletBefore); assert.equal(wallet.sends.length, sendsBefore);
    const readAttempts = attempts.slice(attemptsBefore);
    assert.equal(readAttempts.filter(row => row.origin === host.origin && row.path === '/__local/wallet').length, 0,
      'Count even rejected operator provider attempts, not just forwarded RPC calls');
    assert.ok(readAttempts.every(row => row.method === 'GET' && !row.hasBody));
    const readRequests = stack.requests.slice(requestsBefore).filter(row => row.path.startsWith('/api/v1/'));
    assert.ok(readRequests.length > 0); assert.ok(readRequests.every(row => ['GET', 'OPTIONS'].includes(row.method)));
    const afterFacts = await fixtures.snapshotFacts(); assert.deepEqual(afterFacts, beforeFacts);
    passed('All diagnostics reads preserve database facts, chain balances and nonces', {
      walletCalls: 0, walletSends: 0, mutationRequests: 0, requests: readRequests.length,
      databaseTables: Object.keys(beforeFacts.database).length, factsDigest: factsDigest(afterFacts) });

    // A real signed non-operator must be denied by the actual mounted route.
    const beforeDenied = report.http.length;
    await control('account-A');
    assert.equal(await panel().count(), 0);
    await signIn();
    await wait(async () => report.http.slice(beforeDenied).some(row => row.path.startsWith('/api/v1/admin/stocks/') && row.status === 403), 'Real regular-user403');
    assert.equal(await panel().count(), 0); await screenshot('diagnostics-user-forbidden.png');
    passed('Account switch hides diagnostics; signed ordinary wallet receives admin route403', {
      deniedPaths: report.http.slice(beforeDenied).filter(row => row.status === 403).map(row => row.path) });
    assert.deepEqual(report.pageErrors, []);
    report.result = report.knownFindings.length ? 'PASS_WITH_KNOWN_P3' : 'PASS';
    return report;
  } catch (error) {
    await page.screenshot({ path: resolve(evidence, 'diagnostics-failure.png'), fullPage: true }).catch(() => {});
    await writeFile(resolve(evidence, 'diagnostics-failure.txt'), `${error.stack}\n${await page.locator('body').innerText().catch(() => '')}\n`, { mode: 0o600 });
    throw error;
  } finally { await context.close(); }
}
