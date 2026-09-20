// Black-box acceptance of the command the owner actually runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPortClosed } from './assert-port-closed.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = process.env.STOCKS_LOCAL_BROWSER_EVIDENCE;
assert.ok(evidence && evidence.startsWith('/'), 'Explicit evidence directory required');
mkdirSync(evidence, { recursive: true });
const { chromium } = createRequire(join(root, 'scripts/stocks-ci/package.json'))('playwright');
const executablePath = process.env.STOCKS_LOCAL_CHROME || chromium.executablePath();
assert.ok(existsSync(executablePath), 'Install Chromium or set STOCKS_LOCAL_CHROME');
const child = spawn(process.execPath, ['scripts/stocks-local/owner.mjs', 'start'], {
  cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', outcome, spawnError, browser, page, interrupted;
child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
child.once('error', error => { spawnError = error; });
child.once('close', (code, signal) => { outcome = { code, signal }; });
const stop = signal => { interrupted ??= signal; child.kill('SIGTERM'); };
const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
const records = () => stdout.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row.kind ? [row] : []; } catch { return []; } });
const report = { result: 'RUNNING', checks: [], pageErrors: [], navigation: [], clientEvents: [], rejectedRequests: [] };
const passed = name => { report.checks.push(name); console.log(`STOCKS_OWNER_CHECK ${name}`); };
const until = async (read, name, timeout = 20000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    assert.ok(!interrupted, 'Owner verification interrupted');
    if (spawnError) throw spawnError;
    if (await read()) return;
    await delay(75);
  }
  throw Error(`Owner verification timed out: ${name}`);
};
try {
  await until(() => records().some(row => row.kind === 'LOCAL_OWNER_READY') || !!outcome, 'startup', 90000);
  assert.equal(outcome, undefined, stderr);
  const ready = records().find(row => row.kind === 'LOCAL_OWNER_READY');
  assert.ok(ready?.initialPaused && ready.persistentAcrossRestart === false);
  report.ready = ready;
  browser = await chromium.launch({ executablePath, headless: true,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) report.navigation.push({ at: Date.now(), path: new URL(frame.url()).pathname }); });
  page.on('console', message => { if (message.text().startsWith('[vite]')) report.clientEvents.push({ at: Date.now(), message: message.text().slice(0, 250) }); });
  page.on('response', response => { if (response.status() >= 400) report.rejectedRequests.push({ at: Date.now(), status: response.status(), path: new URL(response.url()).pathname }); });
  const local = async action => {
    await page.locator(`[data-local-action="${action}"]`).click();
    await until(async () => !await page.locator('[data-local-action="refresh"]').isDisabled(), action);
    assert.doesNotMatch(await page.getByTestId('local-test-message').innerText(), /FAILED/);
  };
  const signIn = async () => {
    await page.getByRole('region', { name: 'Stocks sign-in', exact: true })
      .getByRole('button', { name: /^(Sign in to Stocks|Retry Stocks sign-in)$/ }).click();
    await page.getByRole('button', { name: 'Sign out of Stocks', exact: true }).waitFor();
  };
  const state = () => page.evaluate(async () => {
    const config = await fetch('/__local/config').then(r => r.json());
    return fetch('/__local/state', { headers: { 'X-Stocks-Local-Capability': config.capability } }).then(r => r.json());
  });
  const gate = () => page.getByTestId('stocks-trading-control-gate');
  const change = async paused => {
    const panel = page.getByTestId('stocks-trading-control');
    await until(async () => await gate().getAttribute('data-phase') === 'ready', 'control ready');
    const close = page.getByTestId('stocks-trading-control-outcome').getByRole('button', { name: 'Close', exact: true });
    if (await close.count()) await close.click();
    await panel.getByLabel('Reason (recorded in the change history)', { exact: true }).fill('Owner workspace verification');
    await panel.getByRole('button', { name: paused ? 'Review pause' : 'Review resume', exact: true }).click();
    await panel.getByRole('button', { name: paused ? 'Confirm pause' : 'Confirm resume', exact: true }).click();
    await until(async () => await page.getByTestId('stocks-trading-control-outcome').getAttribute('data-outcome') === 'accepted', 'control accepted');
  };
  await page.goto(ready.adminUrl);
  // Vite can reload once while optimizing a cold dependency cache. Finish that
  // startup before beginning the signed-session assertions.
  await page.waitForLoadState('networkidle');
  await local('account-operator'); await signIn();
  await until(async () => await gate().getAttribute('data-phase') === 'ready', 'initial control');
  assert.match(await gate().innerText(), /Paused/);
  assert.equal((await state()).sends.length, 0);
  await change(false);
  assert.equal((await state()).sends.length, 0);
  await page.screenshot({ path: join(evidence, 'owner-admin.png'), fullPage: true });
  passed('operator signs in and resumes through the product UI without a wallet transaction');

  await local('account-A'); await page.goto(ready.investorUrl); await signIn();
  await page.getByText('시세 연결 준비 중', { exact: true }).first().waitFor();
  assert.ok(!report.rejectedRequests.some(request => request.path.startsWith('/api/v1/stocks/market/')), 'Market display routes are mounted without live provider credentials');
  const wallet = () => page.getByTestId('stocks-wallet-panel');
  const action = name => wallet().locator(`[data-action="${name}"]`);
  const status = () => wallet().getAttribute('data-status');
  for (const [side, quantity] of [['BUY', '2'], ['SELL', '0.5']]) {
    await page.locator('#giwa-stocks-tab-stocks').click();
    const view = page.getByRole('button', { name: 'View NVDA', exact: true });
    if (await view.count()) await view.click();
    const fresh = page.getByRole('button', { name: 'Start a new order', exact: true });
    if (await fresh.count()) await fresh.click();
    await page.locator(`[data-side="${side}"]`).click();
    await page.locator('input[inputmode="decimal"]').fill(quantity);
    await page.getByRole('button', { name: 'Get quote', exact: true }).click();
    const orderResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/v1/stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}`);
    await page.getByRole('button', { name: side === 'BUY' ? 'Place buy order' : 'Place sell order', exact: true }).click();
    const order = (await (await orderResponse).json()).data;
    assert.ok(order?.id);
    await action('prepare').click();
    await until(async () => await status() === 'APPROVAL_REQUIRED', 'approval');
    await action('approve').click();
    await until(async () => ['APPROVAL_SUBMITTED', 'READY_TRANSFER'].includes(await status()), 'approval sent');
    const approvalDeadline = performance.now() + 35000;
    while (await status() !== 'READY_TRANSFER') {
      assert.ok(performance.now() < approvalDeadline, 'Approval finality deadline');
      await delay(1200);
      if (await status() === 'READY_TRANSFER') break;
      // A status update can replace the old approval button with an intentionally
      // disabled one. Do not wait on that retired action until the policy expires.
      const check = page.locator('[data-testid="stocks-wallet-panel"][data-status="APPROVAL_SUBMITTED"] button[data-action="prepare"]:enabled');
      if (await check.count()) await check.click({ timeout: 1000 }).catch(async error => {
        if (await status() !== 'READY_TRANSFER') throw error;
      });
    }
    await action('submit').click();
    await until(async () => (await state()).snapshot[side === 'BUY' ? 'buyOrders' : 'sellOrders']
      .some(row => row.id === order.id && row.state === 'COMPLETED'), `${side} completed`, 55000);
    passed(`${side} completes through separate approval and transfer clicks`);
  }
  const completed = await state();
  assert.equal(completed.sends.length, 4); assert.equal(completed.snapshot.claimCount, 4);
  assert.equal(completed.snapshot.holderStock, '1500000000');
  assert.equal(completed.snapshot.holderCash, '1820000000');
  assert.equal(completed.snapshot.vaultCash, '180000000');
  assert.equal(completed.snapshot.escrowStock, '0');
  assert.equal(completed.snapshot.reconciliationStatus, 'MATCHED_AT_CUTOFF');
  report.final = { sends: completed.sends.length, ...completed.snapshot };
  await local('restartApi'); await page.reload(); await signIn();
  assert.deepEqual((await state()).snapshot, completed.snapshot);
  assert.equal((await state()).sends.length, 4);
  passed('API restart and page reload preserve orders, balances and four sends');
  await page.locator('#giwa-stocks-tab-portfolio').click();
  await page.screenshot({ path: join(evidence, 'owner-portfolio.png'), fullPage: true });
  await local('account-operator'); await page.goto(ready.adminUrl); await signIn(); await change(true);
  await local('restartApi'); await page.reload(); await signIn();
  await until(async () => await gate().getAttribute('data-phase') === 'ready', 'pause after restart');
  assert.match(await gate().innerText(), /Paused/);
  passed('operator pause survives API restart');
  await local('topUpTestCash');
  assert.equal(await page.getByTestId('local-test-cash').innerText(), '2,000');
  const toppedUp = await state();
  assert.equal(toppedUp.snapshot.holderCash, '2000000000');
  for (const key of ['buyOrders', 'sellOrders', 'claimCount', 'proofCount', 'holderStock', 'vaultCash', 'escrowStock', 'stockSupply'])
    assert.deepEqual(toppedUp.snapshot[key], completed.snapshot[key], key);
  assert.equal(toppedUp.sends.length, 4);
  await local('topUpTestCash'); // Already at target: no new faucet transaction.
  assert.equal((await state()).snapshot.blockNumber, toppedUp.snapshot.blockNumber);
  await local('restartApi'); await page.reload(); await signIn();
  await until(async () => await gate().getAttribute('data-phase') === 'ready', 'pause after cash top-up');
  assert.match(await gate().innerText(), /Paused/);
  const retained = await state();
  assert.equal(retained.snapshot.holderCash, '2000000000');
  assert.deepEqual(retained.snapshot.buyOrders, completed.snapshot.buyOrders);
  assert.deepEqual(retained.snapshot.sellOrders, completed.snapshot.sellOrders);
  report.topUp = { ...retained.snapshot, sends: retained.sends.length };
  await page.screenshot({ path: join(evidence, 'owner-cash-top-up.png'), fullPage: true });
  passed('local cash top-up preserves trade history and pause; repeated top-up sends nothing and survives API restart');
  const beforeExport = await state();
  let failedDownloads = 0;
  const countFailedDownload = () => { failedDownloads++; };
  page.on('download', countFailedDownload);
  await page.route(`${ready.origin}/__local/state`, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await page.locator('[data-local-action="export-summary"]').click();
  await until(async () => (await page.getByTestId('local-test-message').innerText()).includes('LOCAL_EXPORT_FAILED'), 'failed export notification');
  assert.equal(failedDownloads, 0, 'Unavailable server must not generate a summary from stale UI state');
  page.off('download', countFailedDownload);
  const downloading = page.waitForEvent('download');
  await local('export-summary');
  const download = await downloading;
  assert.match(download.suggestedFilename(), /^stocks-local-summary-[0-9TZ-]+\.json$/);
  const exportPath = join(evidence, 'downloaded-session-summary.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
  assert.equal(exported.kind, 'STOCKS_LOCAL_SESSION_SUMMARY');
  assert.equal(exported.coverage.account, 'A'); assert.equal(exported.restorableBackup, false);
  assert.equal(exported.balances.holderCash, '2000'); assert.equal(exported.balances.holderStock, '1.5');
  assert.deepEqual(exported.orders.buy, beforeExport.snapshot.buyOrders);
  assert.deepEqual(exported.orders.sell, beforeExport.snapshot.sellOrders);
  const afterExport = await state();
  assert.deepEqual(afterExport.snapshot, beforeExport.snapshot);
  assert.equal(afterExport.sends.length, beforeExport.sends.length);
  report.export = { kind: exported.kind, buyCount: exported.orders.buy.length, sellCount: exported.orders.sell.length, holderCash: exported.balances.holderCash };
  passed('downloaded Account A summary preserves live state and includes bounded orders and exact balances');
  assert.deepEqual(report.pageErrors, []);
  assert.ok(report.clientEvents.some(event => event.message.includes('[vite] connected.')), 'Development updates use the owned listener');
  assert.ok(!report.clientEvents.some(event => /connection lost|failed to connect/.test(event.message)), 'No development-server reconnect/reload loop');
  await page.getByRole('button', { name: '로컬 실행 종료', exact: true }).click();
  await until(async () => (await page.getByTestId('local-test-message').innerText()).includes('로컬 실행을 종료했습니다'), 'stop acknowledged');
  await browser.close(); browser = undefined;
  await until(() => !!outcome, 'owned shutdown');
  assert.deepEqual(outcome, { code: 0, signal: null });
  const stopped = records().find(row => row.kind === 'LOCAL_OWNER_OWNED_SERVICES_STOPPED');
  report.stopped = stopped;
  assert.ok(stopped?.postgresPidFileAbsent && stopped.postgresSocketAbsent && stopped.nodeGroupAbsent);
  for (const pid of [ready.ownerPid, stopped.postgresPid, -stopped.nodeGroup])
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  for (const url of [ready.origin, ready.apiBase, ready.rpcUrl]) await assertPortClosed(url);
  assert.equal(existsSync(stopped.temp), false);
  assert.deepEqual(JSON.parse(readFileSync(exportPath, 'utf8')), exported, 'Downloaded summary remains readable after the disposable workspace stops');
  passed('owner stop button closes the owned API, bridge, DB and EVM and removes temporary data');
  report.result = 'PASS'; report.cleanupVerified = true;
} catch (error) {
  report.result = 'FAIL'; report.error = error.message; process.exitCode = interrupted ? 143 : 1;
  await page?.screenshot({ path: join(evidence, 'owner-failure.png'), fullPage: true }).catch(() => {});
  console.error(error.stack);
} finally {
  await browser?.close();
  if (!outcome) {
    child.kill('SIGTERM');
    const deadline = performance.now() + 20000;
    while (!outcome && performance.now() < deadline) await delay(50);
    if (!outcome) { report.result = 'FAIL'; report.cleanupVerified = false; process.exitCode = 1; }
  }
  writeFileSync(join(evidence, 'owner.stdout.log'), stdout, { mode: 0o600 });
  writeFileSync(join(evidence, 'owner.stderr.log'), stderr, { mode: 0o600 });
  writeFileSync(join(evidence, 'owner-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  console.log(JSON.stringify({ kind: 'STOCKS_OWNER_RESULT', ...report }));
}
