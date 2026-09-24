// Real browser clicks only. Diagnostic reads never feed hashes or state into the UI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function runBrowserScenario({ host, stack, wallet, browser, evidence, probe, scenario = '' }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const report = { execution: 'LOCAL_CHROME_PG_EVM_ONLY', browserVersion: browser.version(),
    actualRoutes: true, strictMode: true, scenarios: [], pageErrors: [], http: [], screenshots: [] };
  const responseReads = new Set();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== stack.apiBase) return;
    const entry = { method: response.request().method(), path: url.pathname, status: response.status() };
    report.http.push(entry);
    if (entry.method === 'POST' && /\/stocks\/(orders|sell-orders)$/.test(entry.path)) {
      const work = response.json().then(body => { entry.order = body.data; });
      responseReads.add(work); void work.finally(() => responseReads.delete(work));
    }
  });
  let foreign;
  async function wait(read, label, timeout = 15000) {
    const until = performance.now() + timeout;
    for (;;) {
      const value = await read(); if (value) return value;
      assert.ok(performance.now() < until, `Browser timeout: ${label}`); await delay(60);
    }
  }
  function passed(name, details = {}) {
    const row = { name, ...details }; report.scenarios.push(row);
    console.log(`STOCKS_LOCAL_BROWSER_STEP ${JSON.stringify(row)}`);
  }
  const panel = () => page.getByTestId('stocks-wallet-panel');
  const action = name => panel().locator(`button[data-action="${name}"]`);
  const status = () => panel().getAttribute('data-status');
  const hash = async () => await page.getByTestId('stocks-wallet-tx-hash').count() ? page.getByTestId('stocks-wallet-tx-hash').textContent() : null;
  const tab = name => page.locator(`#giwa-stocks-tab-${name}`).click();
  async function control(name) {
    await page.locator(`[data-local-action="${name}"]`).click();
    await wait(async () => !await page.locator('[data-local-action="refresh"]').isDisabled(), `control ${name}`);
    assert.doesNotMatch(await page.getByTestId('local-test-message').innerText(), /FAILED/);
  }
  async function signIn() {
    await page.getByRole('region', { name: 'Stocks sign-in', exact: true })
      .getByRole('button', { name: /^(Sign in to Stocks|Retry Stocks sign-in)$/ }).click();
    await wait(async () => (await page.getByTestId('giwa-stocks-session').innerText()).startsWith('Signed in as'), 'SIWE signed in');
  }
  async function place(side, quantity) {
    await tab('stocks');
    if (!await page.locator('input[inputmode="decimal"]').count()) {
      const view = page.getByRole('button', { name: 'View NVDA', exact: true });
      if (await view.count()) await view.click();
    }
    const start = page.getByRole('button', { name: 'Start a new order', exact: true });
    if (await start.count()) await start.click();
    await page.locator(`[data-side="${side}"]`).click();
    await page.locator('input[inputmode="decimal"]').fill(quantity);
    await page.getByRole('button', { name: 'Get quote', exact: true }).click();
    const path = `/api/v1/stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}`;
    const before = report.http.length;
    const reply = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST');
    await page.getByRole('button', { name: side === 'BUY' ? 'Place buy order' : 'Place sell order', exact: true }).dblclick();
    const order = (await (await reply).json()).data;
    assert.ok(order?.id);
    await page.locator('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]').waitFor();
    assert.equal(report.http.slice(before).filter(r => r.method === 'POST' && r.path === path).length, 1);
    return order;
  }
  async function select(side, quantity) {
    await tab('orders');
    const all = page.getByRole('button', { name: 'All orders', exact: true });
    if (await all.count()) await all.click();
    await page.getByRole('button', { name: new RegExp(`^${side === 'BUY' ? 'Buy' : 'Sell'}.*${quantity.replace('.', '\\.')} NVDA`) }).click();
  }
  const check = () => action('prepare').click();
  async function approve(label) {
    const before = wallet.sends.length;
    await check(); await wait(async () => await status() === 'APPROVAL_REQUIRED', 'approval required');
    const observedDisabled = await action('approve').isDisabled();
    assert.equal(observedDisabled, true, 'initial approval disabled while arming');
    await action('approve').dblclick();
    await wait(async () => ['APPROVAL_SUBMITTED', 'READY_TRANSFER'].includes(await status()), 'approval answer');
    const until = performance.now() + 35000;
    while (await status() !== 'READY_TRANSFER') {
      assert.ok(performance.now() < until, 'approval finality'); await delay(1200); await check();
      await wait(async () => ['APPROVAL_SUBMITTED', 'READY_TRANSFER'].includes(await status()), 'approval check');
    }
    assert.equal(wallet.sends.length, before + 1);
    passed(`${label}: approval; separate transfer required`, { sends: wallet.sends.length, observedDisabled });
  }
  async function transfer(label) {
    const before = wallet.sends.length;
    await action('submit').dblclick();
    await wait(async () => await status() === 'SUBMITTED' && await hash(), 'durable transfer hash');
    assert.equal(wallet.sends.length, before + 1); const txHash = await hash(); assert.match(txHash, /^0x[0-9a-f]{64}$/i);
    passed(`${label}: separate transfer click`, { hash: txHash, sends: wallet.sends.length }); return txHash;
  }
  async function refreshOrder() {
    const card = page.getByTestId('stocks-order-card');
    const button = card.getByRole('button', { name: 'Refresh status', exact: true });
    if (await button.count()) await button.click();
    else await page.getByRole('button', { name: 'Refresh order status', exact: true }).click();
  }
  async function complete(side, orderId) {
    const snapshot = await wait(async () => {
      const value = await stack.snapshot();
      if (value[side === 'BUY' ? 'buyOrders' : 'sellOrders'].find(r => r.id === orderId)?.state === 'COMPLETED') return value;
      await refreshOrder(); return null;
    }, `${side} native completion`, 55000);
    await refreshOrder(); await wait(async () => (await page.getByTestId('stocks-order-card').innerText()).includes('Completed'), 'COMPLETED rendered');
    passed(`${side}: real observer/worker COMPLETED`, { orderId, holderStock: snapshot.chain.holderStock }); return snapshot;
  }
  async function holdings(quantity) {
    await tab('portfolio');
    const scope = page.locator('[aria-labelledby="giwa-stocks-portfolio-title"]');
    await scope.getByRole('button', { name: 'Refresh', exact: true }).click();
    await wait(async () => (await scope.getByTestId('stocks-holding').allTextContents()).some(text =>
      text.includes(`Total (wallet + escrow)${quantity} NVDA`) && text.includes(`In wallet${quantity} NVDA`)), `holdings ${quantity}`);
    passed('Browser portfolio matches chain', { quantity });
  }
  async function heldAction(name) {
    await control('holdNextSend'); await action(name).click();
    await wait(async () => { await control('refresh'); return await page.getByTestId('local-wallet-held').innerText() === 'waiting'; }, 'chain accepted held response');
    assert.equal(await status(), 'SIGNING');
    const send = wallet.sends.at(-1); assert.match(send.hash, /^0x[0-9a-f]{64}$/i); return send.hash;
  }
  async function screenshot(name) {
    const path = resolve(evidence, name); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(dimensions.document <= dimensions.viewport + 1, `horizontal overflow: ${JSON.stringify(dimensions)}`);
    passed('Viewport has no horizontal overflow', dimensions);
  }
  try {
    if (scenario === 'known-hash-ui') {
      const { runKnownHashUiScenario } = await import('./known-hash-ui-driver.mjs');
      return await runKnownHashUiScenario({ host, stack, wallet, page, report, passed, wait,
        control, signIn, place, select, check, status, panel, action, hash, approve, transfer,
        complete, holdings, heldAction, screenshot });
    }
    if (scenario === 'known-hash') {
      // Retained adapter baseline. Product recovery buttons are exercised by
      // the separate known-hash-ui case above.
      const { runKnownHashScenario } = await import('./known-hash-driver.mjs');
      return await runKnownHashScenario({ host, stack, wallet, page, report, passed, wait,
        control, signIn, place, select, check, status, panel, action, hash, approve, transfer,
        complete, holdings, heldAction, screenshot });
    }
    await page.goto(host.url); await page.getByTestId('local-test-controls').waitFor();
    await signIn(); assert.equal(wallet.sends.length, 0);
    passed('Chrome native cross-origin API + real SIWE login; mount/login sends zero transactions');
    const buy = await place('BUY', '2'); assert.equal(buy.quantity, '2000000000');
    if (probe === 'held') {
      await check(); await wait(async () => await status() === 'APPROVAL_REQUIRED', 'probe approval');
      await heldAction('approve'); console.log(JSON.stringify({ kind: 'LOCAL_BROWSER_HELD' })); await new Promise(() => {});
    }
    await approve('BUY'); await control('stopProcessing'); const buyHash = await transfer('BUY');
    const beforeReload = wallet.sends.length;
    await control('restartApi'); await page.reload();
    await page.getByRole('button', { name: 'Sign in to Stocks', exact: true }).waitFor();
    assert.equal(wallet.sends.length, beforeReload);
    await signIn(); await select('BUY', '2'); await check();
    await wait(async () => await status() === 'SUBMITTED' && await hash() === buyHash, 'reload original hash');
    assert.equal(wallet.sends.length, beforeReload);
    passed('Real browser reload + API restart restores original durable hash without resend', { buyHash });
    await control('startProcessing'); await complete('BUY', buy.id); await holdings('2');
    const sell = await place('SELL', '0.5'); await approve('SELL'); const sellHash = await transfer('SELL');
    await complete('SELL', sell.id); await holdings('1.5'); assert.equal(wallet.sends.length, 4);
    const swap = await place('BUY', '0.25'); await check();
    await wait(async () => await status() === 'APPROVAL_REQUIRED', 'swap approval');
    const swapHash = await heldAction('approve'); const swapSends = wallet.sends.length;
    await control('account-B');
    assert.equal(await panel().count(), 0);
    assert.ok(!(await page.locator('main').innerText()).includes(swap.id));
    await control('releaseHeld');
    await wait(async () => (await stack.snapshot()).claims.some(r => r.orderId === swap.id && r.txHash === swapHash), 'late A outcome original claim');
    assert.ok(!(await page.locator('main').innerText()).includes(swapHash));
    assert.equal(wallet.sends.length, swapSends);
    assert.equal(wallet.sends.filter(r => r.transaction.from.toLowerCase() === stack.accounts.otherHolder.toLowerCase()).length, 0);
    await control('account-A'); await page.reload(); await signIn(); await select('BUY', '0.25'); await check();
    await wait(async () => ['READY_TRANSFER', 'APPROVAL_SUBMITTED'].includes(await status()), 'same-owner approval read');
    assert.equal(wallet.sends.length, swapSends);
    passed('Account swap hides A; late A hash stays in original claim; reload A does not resend', { orderId: swap.id });
    const lost = await place('SELL', '0.25'); await approve('SELL response loss'); await control('stopProcessing');
    const lostHash = await heldAction('submit'); const lostSends = wallet.sends.length;
    await control('dropHeld'); await wait(async () => await status() === 'UNKNOWN', 'unknown wallet response');
    assert.equal(await hash(), null);
    assert.equal(await page.getByTestId('stocks-known-hash-recovery').count(), 0, 'no recovery candidate is inferred from a hashless UNKNOWN');
    const lostSnapshot = await wait(async () => {
      const snapshot = await stack.snapshot(); return snapshot.claims.some(r => r.orderId === lost.id && r.stage === 'TRANSFER' && r.status === 'UNKNOWN') && snapshot;
    }, 'durable unknown claim');
    const lostClaim = lostSnapshot.claims.find(r => r.orderId === lost.id && r.stage === 'TRANSFER'); assert.equal(lostClaim.txHash, null);
    await control('startProcessing'); await complete('SELL', lost.id); await holdings('1.25');
    await screenshot('portfolio-desktop.png'); await page.setViewportSize({ width: 375, height: 900 }); await screenshot('portfolio-mobile.png');
    await page.setViewportSize({ width: 1440, height: 1000 }); await control('restartApi'); await page.reload(); await signIn(); await select('SELL', '0.25');
    await wait(async () => (await page.getByTestId('stocks-order-card').innerText()).includes('Completed'), 'completed after loss reload');
    assert.equal(await hash(), null); assert.equal(wallet.sends.length, lostSends);
    assert.equal(await page.getByTestId('stocks-known-hash-recovery').count(), 0, 'observer completion/reload does not manufacture a candidate');
    passed('Lost response: UNKNOWN/no hash → real observer completion → browser reload without resend', { orderId: lost.id, instrumentationOnlyHash: lostHash });

    // A second owned origin exercises browser CORS, including with the correct bridge capability.
    foreign = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Owned negative CORS test</title>'); });
    await new Promise((done, fail) => { foreign.once('error', fail); foreign.listen(0, '127.0.0.1', done); });
    const other = await context.newPage(); await other.goto(`http://127.0.0.1:${foreign.address().port}`);
    const config = await page.evaluate(async () => (await fetch('/__local/config')).json());
    const callsBeforeCors = wallet.calls.length;
    const cors = await other.evaluate(async ({ apiBase, bridge, capability }) => {
      const denied = async (url, options) => { try { await fetch(url, options); return false; } catch (error) { return error instanceof TypeError; } };
      return {
        apiRead: await denied(`${apiBase}/api/v1/stocks/catalog`, { headers: { 'X-Cors-Negative-Probe': '1' } }),
        bootstrapRead: await denied(`${bridge}/__local/config`),
        walletWrite: await denied(`${bridge}/__local/wallet`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Stocks-Local-Capability': capability }, body: JSON.stringify({ method: 'eth_accounts', params: [] }) }),
      };
    }, { apiBase: stack.apiBase, bridge: host.origin, capability: config.capability });
    assert.deepEqual(cors, { apiRead: true, bootstrapRead: true, walletWrite: true }); assert.equal(wallet.calls.length, callsBeforeCors);
    passed('Foreign browser origin cannot read API/bootstrap or reach wallet, even with capability', cors); await other.close();
    const snapshot = await stack.snapshot();
    assert.equal(snapshot.reconciliation.status, 'MATCHED_AT_CUTOFF');
    assert.equal(String(snapshot.chain.holderStock), '1250000000'); assert.equal(String(snapshot.chain.holderCash), '1850000000');
    assert.equal(String(snapshot.chain.vaultCash), '150000000'); assert.equal(String(snapshot.chain.escrowStock), '0');
    assert.deepEqual(snapshot.workerErrors, { processing: [], reviewJobs: [] });
    assert.equal(wallet.sends.length, 7); assert.equal(snapshot.claims.length, 7);
    const finalLost = snapshot.claims.filter(r => r.orderId === lost.id && r.stage === 'TRANSFER');
    assert.equal(finalLost.length, 1); assert.equal(finalLost[0].claimId, lostClaim.claimId); assert.equal(finalLost[0].txHash, null);
    assert.deepEqual(report.pageErrors, []); await Promise.all([...responseReads]);
    report.final = { buyOrderId: buy.id, sellOrderId: sell.id, swapOrderId: swap.id, lostOrderId: lost.id, buyHash, sellHash, snapshot };
    passed('Final database/chain reconciliation matched; seven claims and seven wallet sends'); return report;
  } catch (error) {
    await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(resolve(evidence, 'failure.txt'), `${error.stack}\n${await page.locator('body').innerText().catch(() => '')}\n`, { mode: 0o600 });
    throw error;
  } finally {
    if (foreign) { foreign.closeAllConnections(); await new Promise(done => foreign.close(done)); }
    await context.close();
  }
}
