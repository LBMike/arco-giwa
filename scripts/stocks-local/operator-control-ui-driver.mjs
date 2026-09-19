// Actual product control UI, signed sessions, local PostgreSQL and EVM only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SiweMessage } from 'siwe';
import { getAddress, stringToHex } from 'viem';

export async function runOperatorControlUiScenario({ host, stack, wallet, browser, evidence }) {
  assert.equal(stack.operatorControls, true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const root = '/api/v1/admin/stocks/trading-control';
  const report = { checks: [], http: [], pageErrors: [], screenshots: [], knownFindings: [] };
  const pending = new Set();
  const instrumentationErrors = [];
  let session, operatorSession;
  const posts = [];
  const walletAttempts = [];
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => {
    try {
      const url = new URL(request.url());
      if (url.origin === host.origin && url.pathname === '/__local/wallet') walletAttempts.push(request.postDataJSON()?.method);
      if (url.origin === stack.apiBase && request.method() === 'POST' && url.pathname === root) {
        const body = request.postDataJSON();
        assert.deepEqual(Object.keys(body).sort(), ['expectedVersion', 'idempotencyKey', 'paused', 'reason']);
        posts.push(body);
      }
    } catch { instrumentationErrors.push('CONTROL_REQUEST_SHAPE_INVALID'); }
  });
  page.on('response', response => {
    const url = new URL(response.url()); if (url.origin !== stack.apiBase) return;
    report.http.push({ path: url.pathname, method: response.request().method(), status: response.status() });
    if (url.pathname === '/api/v1/auth/verify' && response.status() === 200) {
      const work = response.json().then(row => { session = row.token; }).catch(() => { instrumentationErrors.push('CONTROL_SESSION_RESPONSE_UNAVAILABLE'); });
      pending.add(work); void work.finally(() => pending.delete(work));
    }
  });
  const panel = () => page.getByTestId('stocks-trading-control');
  const outcome = () => page.getByTestId('stocks-trading-control-outcome');
  const gate = () => page.getByTestId('stocks-trading-control-gate');
  const history = () => page.getByTestId('stocks-trading-control-history');
  const wait = async (read, label) => {
    const deadline = performance.now() + 15000;
    for (;;) {
      assert.deepEqual(instrumentationErrors, []);
      if (await read()) return;
      assert.ok(performance.now() < deadline, label); await delay(50);
    }
  };
  const passed = name => { report.checks.push(name); console.log(`STOCKS_LOCAL_CONTROL_UI_STEP ${JSON.stringify({ name })}`); };
  const screenshot = async name => { const path = resolve(evidence, name); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
  const interceptOnce = handle => page.route(`${stack.apiBase}${root}`, async route => {
    try { await handle(route); }
    catch { instrumentationErrors.push('CONTROL_ROUTE_PROBE_FAILED'); await route.abort('failed').catch(() => {}); }
  }, { times: 1 });
  async function localAccount(account) {
    await page.locator(`[data-local-action="account-${account}"]`).click();
    await wait(async () => !await page.locator('[data-local-action="refresh"]').isDisabled(), 'Account selected');
  }
  async function signIn() {
    session = undefined;
    await page.getByRole('region', { name: 'Stocks sign-in', exact: true }).getByRole('button', { name: /^(Sign in to Stocks|Retry Stocks sign-in)$/ }).click();
    await wait(() => Boolean(session), 'Signed session');
    await page.getByRole('region', { name: 'Stocks sign-in', exact: true }).getByRole('button', { name: 'Sign out of Stocks', exact: true }).waitFor();
  }
  async function ready() { await wait(async () => await gate().getAttribute('data-phase') === 'ready', 'Current manual state'); }
  async function refresh() {
    const request = page.waitForResponse(response => response.url() === `${stack.apiBase}${root}` && response.request().method() === 'GET');
    await panel().getByRole('button', { name: 'Refresh trading control', exact: true }).click();
    await request; await ready();
  }
  async function call(path, body, token = operatorSession, status = 200) {
    const response = await fetch(`${stack.apiBase}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const row = await response.json(); assert.equal(response.status, status, JSON.stringify({ path, row }));
    return row.data ?? row;
  }
  const current = () => call(root);
  async function change(paused, reason, expected = 'accepted', double = false) {
    const walletAttemptsBefore = walletAttempts.length;
    await ready();
    if (await outcome().count() && await outcome().getByRole('button', { name: 'Close', exact: true }).count()) {
      await outcome().getByRole('button', { name: 'Close', exact: true }).click(); await ready();
    }
    await panel().getByLabel('Reason (recorded in the change history)', { exact: true }).fill(reason);
    await panel().getByRole('button', { name: paused ? 'Review pause' : 'Review resume', exact: true }).click();
    const confirm = panel().getByRole('button', { name: paused ? 'Confirm pause' : 'Confirm resume', exact: true });
    if (double) await confirm.dblclick(); else await confirm.click();
    await wait(async () => await outcome().getAttribute('data-outcome') === expected, `Command ${expected}`);
    assert.equal(walletAttempts.length, walletAttemptsBefore, 'A control command must not request any wallet operation');
  }
  const secondLogin = async () => {
    const address = stack.accounts.faucetOperator;
    const nonce = await call('/api/v1/auth/nonce', { walletAddress: address, domain: new URL(host.origin).host }, '');
    const message = new SiweMessage({ domain: new URL(host.origin).host, address: getAddress(address), uri: host.origin,
      version: '1', chainId: 91342, nonce: nonce.nonce, issuedAt: new Date().toISOString() }).prepareMessage();
    const signature = await stack.rpc('personal_sign', [stringToHex(message), address]);
    return (await call('/api/v1/auth/verify', { message, signature }, '')).token;
  };
  try {
    await page.goto(`${host.origin}/admin/stocks`); await localAccount('operator'); await signIn(); operatorSession = session;
    await ready();
    assert.equal((await current()).state.version, 0); assert.equal((await current()).state.paused, true);
    const walletBefore = wallet.sends.length;
    await call('/api/v1/stocks/quotes', { symbol: 'NVDA', quantity: '0.125' }, operatorSession, 503);
    await screenshot('control-initial-paused.png');
    passed('Real SIWE control operator sees initial paused/version0 and backend denies new quotes');

    stack.controlForHarness.faults.observerUnavailable = true;
    await stack.controlForHarness.runtime.tick();
    const before = posts.length;
    await change(false, 'Browser resume while observation unavailable', 'accepted', true);
    assert.equal(posts.length, before + 1);
    await wait(async () => (await panel().innerText()).includes('Still paused by: Chain observation not current'), 'Resume preserves other gate');
    await call('/api/v1/stocks/quotes', { symbol: 'NVDA', quantity: '0.125' }, operatorSession, 503);
    await screenshot('control-resumed-observer-blocked.png');
    stack.controlForHarness.faults.observerUnavailable = false; await stack.controlForHarness.runtime.tick();
    await refresh();
    passed('Double confirmation sends once; manual resume cannot override unavailable observation');

    await change(true, 'Browser manual pause');
    await call('/api/v1/stocks/quotes', { symbol: 'NVDA', quantity: '0.125' }, operatorSession, 503);
    await outcome().getByRole('button', { name: 'Close', exact: true }).click(); await ready();
    await interceptOnce(async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
    });
    const previousVersion = (await current()).state.version;
    await change(false, 'Lost browser response after actual commit', 'unknown');
    const lost = posts[posts.length - 1];
    assert.equal((await current()).state.version, previousVersion + 1);
    await screenshot('control-lost-response-unknown.png');
    await outcome().getByRole('button', { name: 'Read state and history', exact: true }).click(); await ready();
    await outcome().getByRole('button', { name: 'Retry the same command', exact: true }).click();
    await wait(async () => await outcome().getAttribute('data-outcome') === 'replayed', 'Same-key replay');
    assert.deepEqual(posts[posts.length - 1], lost); assert.equal((await current()).state.version, previousVersion + 1);
    passed('Lost actual commit response remains unknown; same body/key retry returns one event');

    await outcome().getByRole('button', { name: 'Close', exact: true }).click(); await ready();
    const second = await secondLogin();
    await interceptOnce(async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const command = route.request().postDataJSON();
      await call(root, { ...command, idempotencyKey: randomUUID(), reason: 'Competing second signed operator' }, second);
      await route.continue();
    });
    const beforeConflict = posts.length;
    await change(true, 'First operator competing pause', 'conflict');
    await ready(); assert.equal(posts.length, beforeConflict + 1);
    assert.equal((await current()).state.reason, 'Competing second signed operator');
    passed('Second real signed operator wins CAS; product displays conflict and does not automatically resend');

    await localAccount('B'); await signIn(); await ready();
    const versionBeforeDenied = (await current()).state.version;
    await change(false, 'Read-only operator must not resume', 'rejected');
    assert.equal((await current()).state.version, versionBeforeDenied);
    assert.ok(report.http.some(row => row.path === root && row.method === 'POST' && row.status === 403));
    await screenshot('control-read-only-forbidden.png');
    await localAccount('A'); await signIn();
    await wait(async () => (await panel().innerText()).includes('403'), 'Unregistered operator forbidden');
    assert.equal(await page.getByTestId('stocks-trading-control-event').count(), 0);
    await screenshot('control-unregistered-forbidden.png');
    passed('Read-only signed operator POST403 and unregistered wallet GET403 leave DB unchanged and hide prior data');

    await localAccount('operator'); await signIn(); operatorSession = session; await ready();
    // Independent reproduction: the original POST never reaches the API. A
    // different signed operator records the same visible action/reason/version.
    // Public history has no command key and cannot prove the first command ran.
    await interceptOnce(route => route.abort('failed'));
    await change(false, 'Shared incident reason across operators', 'unknown');
    const unrecorded = posts[posts.length - 1];
    await call(root, { ...unrecorded, idempotencyKey: randomUUID() }, second);
    await outcome().getByRole('button', { name: 'Read state and history', exact: true }).click(); await ready();
    await wait(async () => await history().getAttribute('data-phase') === 'ready', 'Competing event history');
    assert.equal((await current()).state.operatorId, 'local-second-operator');
    assert.equal(await outcome().getAttribute('data-outcome'), 'unknown');
    const uncertainText = await outcome().innerText();
    if (uncertainText.includes('means it was recorded')) {
      report.knownFindings.push({ id: 'CONTROL-UI-003F-P2-01', severity: 'P2',
        observation: 'Another operator owns the matching immutable event, but the UI says matching action/reason/version means this unknown command was recorded.' });
      await screenshot('control-other-operator-false-certainty.png');
    }
    await outcome().getByRole('button', { name: 'Discard this command', exact: true }).click(); await ready();
    await page.getByTestId('stocks-trading-control-command').getByRole('button', { name: 'Close', exact: true }).click();
    const afterUnknown = (await current()).state;
    await call(root, { paused: true, expectedVersion: afterUnknown.version, idempotencyKey: randomUUID(), reason: 'Prepare history boundary fixture' }, second);
    await refresh();
    passed('Real concurrent-operator unknown-command identity probe recorded separately from functional acceptance');
    for (let n = 0; n < 22; n++) {
      const state = (await current()).state;
      await call(root, { paused: state.paused, expectedVersion: state.version, idempotencyKey: randomUUID(), reason: `History fixture ${n}` }, second);
    }
    await refresh(); await wait(async () => await history().getAttribute('data-phase') === 'ready', 'History newest page');
    assert.equal(await page.getByTestId('stocks-trading-control-event').count(), 20);
    await panel().getByRole('button', { name: 'Load older changes', exact: true }).click();
    await wait(async () => await history().getAttribute('data-complete') === 'true', 'History end');
    assert.equal(await page.getByTestId('stocks-trading-control-event').count(), (await current()).state.version);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow ${width}`);
      await screenshot(`control-${width}.png`);
      await panel().evaluate(node => node.scrollIntoView({ block: 'start' }));
      const viewportPath = resolve(evidence, `control-${width}-viewport.png`);
      await page.screenshot({ path: viewportPath, fullPage: false }); report.screenshots.push(viewportPath);
    }
    passed('Real DB audit pages reach explicit end; latest UI has no overflow at375/768/1440');

    stack.controlForHarness.faults.unavailable = true;
    await panel().getByRole('button', { name: 'Refresh trading control', exact: true }).click();
    await wait(async () => await gate().getAttribute('data-phase') === 'error', 'Real service503');
    await screenshot('control-store-unavailable.png');
    stack.controlForHarness.faults.unavailable = false; await refresh();
    stack.controlForHarness.faults.disabled = true; await stack.restartApi();
    await panel().getByRole('button', { name: 'Refresh trading control', exact: true }).click();
    await wait(async () => (await panel().innerText()).includes('not enabled on this server'), 'Absent route404');
    await screenshot('control-disabled.png');
    stack.controlForHarness.faults.disabled = false; await stack.restartApi(); await refresh();
    passed('API service-port503 injection and actual unregistered-route404 show unavailable states without fabricating success');

    await change(false, 'Resume before investor regression');
    assert.equal((await current()).state.paused, false);
    await stack.controlForHarness.runtime.tick();
    assert.equal((await stack.snapshot()).runtimeStatus.newOrdersPaused, false);
    assert.equal(wallet.sends.length, walletBefore, 'Control UI makes zero wallet transaction requests');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(instrumentationErrors, []);
    report.controlPosts = posts;
    report.walletSends = wallet.sends.length - walletBefore;
    assert.ok(walletAttempts.every(method => ['personal_sign', 'eth_accounts', 'eth_chainId'].includes(method)));
    report.walletMethods = walletAttempts; // Method names only; never signatures or message bodies.
    report.finalControl = (await current()).state;
    report.result = report.knownFindings.length ? 'PASS_WITH_KNOWN_P2' : 'PASS';
    await localAccount('A');
    return report;
  } catch (error) {
    await screenshot('control-failure.png').catch(() => {});
    await writeFile(resolve(evidence, 'control-failure.txt'), `${error.stack}\n${await page.locator('body').innerText().catch(() => '')}\n`, { mode: 0o600 });
    throw error;
  } finally { await Promise.allSettled([...pending]); await context.close(); }
}
