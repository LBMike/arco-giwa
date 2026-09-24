// Product recovery buttons in real Chrome, with real expired JWTs, PostgreSQL and
// local EVM receipts. Diagnostics never inject a candidate, hash or session into UI.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveOrder, digest } from '../../server/dist/stocks-submissions/contracts.js';

export async function runKnownHashUiScenario(h) {
  const { host, page, stack, wallet, report, passed, wait, control, signIn, place, select,
    check, status, approve, transfer, complete, holdings, heldAction, screenshot } = h;
  report.execution = 'LOCAL_CHROME_KNOWN_HASH_UI_PG_EVM_ONLY';
  report.recoveryViaProductButtons = true;
  report.authFixture = 'Real SIWE; one armed login per case has a signed 30-second JWT; normal logins 900 seconds';
  report.networkFault = 'Abort first recovery reconcile request before server dispatch; record succeeds, then explicit receipt button retries';
  const sessions = [], sessionReads = new Set(), submissionRequests = [];
  let authFailure;
  const submissionPrefix = `${stack.apiBase}/api/v1/stocks/wallet-submissions/`;
  // Credentials live in this test process only. Evidence stores equality checks,
  // never tokens, session bodies, signatures or authorization headers.
  const onResponse = response => {
    if (response.url() !== `${stack.apiBase}/api/v1/auth/verify` || response.status() !== 200) return;
    const work = (async () => {
      const row = await response.json();
      const claims = JSON.parse(Buffer.from(row.token.split('.')[1], 'base64url').toString('utf8'));
      sessions.push({ token: row.token, expiresAt: claims.exp * 1000, duration: claims.exp - claims.iat });
    })().catch(() => { authFailure = Error('LOCAL_UI_RECOVERY_AUTH_CAPTURE_FAILED'); });
    sessionReads.add(work); void work.finally(() => sessionReads.delete(work));
  };
  const onRequest = request => {
    if (!request.url().startsWith(submissionPrefix) || request.method() === 'OPTIONS') return;
    submissionRequests.push({ method: request.method(), path: request.url().slice(submissionPrefix.length),
      bearer: request.headers().authorization, body: request.postDataJSON() });
  };
  page.on('response', onResponse); page.on('request', onRequest);
  async function login() {
    const before = sessions.length; await signIn();
    return wait(() => { if (authFailure) throw authFailure; return sessions.length > before && sessions.at(-1); }, 'real SIWE response');
  }
  // Negative/restart backend probes are separate from product recovery. No module
  // imports, storage edits or product state writes through page.evaluate.
  async function api(session, path, body) {
    return page.evaluate(async ({ base, bearer, path, body }) => {
      const response = await fetch(`${base}/api/v1/stocks/wallet-submissions/${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        credentials: 'omit', cache: 'no-store', redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
    }, { base: stack.apiBase, bearer: session.token, path, body });
  }
  const binding = row => ({ claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest });
  const outcome = (row, txHash) => ({ ...binding(row), status: 'SUBMITTED', txHash });
  async function facts(orderId) {
    const snapshot = await stack.snapshot();
    return { claims: snapshot.claims.filter(r => r.orderId === orderId).sort((a, b) => a.stage.localeCompare(b.stage)),
      proofs: snapshot.proofs.filter(r => snapshot.claims.some(c => c.orderId === orderId && c.claimId === r.claimId)).sort((a, b) => a.claimId.localeCompare(b.claimId)),
      auditCount: snapshot.audits.length,
      order: [...snapshot.buyOrders, ...snapshot.sellOrders].find(r => r.id === orderId) };
  }
  async function until(timestamp, label) {
    while (Date.now() < timestamp) {
      await delay(Math.min(5000, timestamp - Date.now()));
      console.log(`STOCKS_LOCAL_RECOVERY_WAIT ${JSON.stringify({ label, remainingMs: Math.max(0, timestamp - Date.now()) })}`);
    }
  }
  const card = stage => page.locator(`[data-testid="stocks-known-hash-recovery"][data-claim-stage="${stage}"]`);
  const notice = 'This tab kept a transaction hash the server may not have recorded';
  try {
    await page.goto(host.url); await page.getByTestId('local-test-controls').waitFor();
    let current = await login(); assert.equal(current.duration, 900);
    const seed = await place('BUY', '2'); await approve('Seed BUY'); await transfer('Seed BUY');
    await complete('BUY', seed.id); await holdings('2');
    const cases = [];
    for (const [side, stage, quantity] of [['BUY', 'APPROVAL', '0.25'], ['SELL', 'APPROVAL', '0.1'], ['BUY', 'TRANSFER', '0.5'], ['SELL', 'TRANSFER', '0.25']]) {
      const label = `${side} ${stage}`;
      let order;
      if (stage === 'TRANSFER') { order = await place(side, quantity); await approve(label); }
      await page.getByRole('button', { name: 'Sign out of Stocks', exact: true }).click();
      await control('armShortSession'); const original = await login(); assert.equal(original.duration, 30);
      if (stage === 'APPROVAL') order = await place(side, quantity);
      else await select(side, quantity);
      await check(); await wait(async () => await status() === (stage === 'APPROVAL' ? 'APPROVAL_REQUIRED' : 'READY_TRANSFER'), `${label} ready`);
      await control('stopProcessing');
      const knownHash = await heldAction(stage === 'APPROVAL' ? 'approve' : 'submit');
      const sendsBefore = wallet.sends.length;
      const claimed = (await facts(order.id)).claims.find(r => r.stage === stage);
      assert.equal(claimed.status, 'REQUEST_MAY_START'); assert.equal(claimed.txHash, null);
      const beforeOutcomeHttp = stack.requests.filter(r => r.path.endsWith('/outcomes')).length;
      await until(original.expiresAt + 150, `${label}: actual signed JWT expiry`);
      await wait(async () => (await page.locator('main').innerText()).includes('A wallet request from your last Stocks session'), 'expired-session no-hash notice');
      // One case specifically returns the OLD wallet answer after the new login.
      const lateAfterLogin = side === 'SELL' && stage === 'TRANSFER';
      if (lateAfterLogin) current = await login();
      await control('releaseHeld');
      await wait(() => wallet.sends.at(-1).outcome === 'RETURNED', 'late wallet answer returned');
      if (!lateAfterLogin) {
        await wait(async () => (await page.locator('main').innerText()).includes(notice), 'same-tab kept-hash notice');
        const signedOutText = await page.locator('main').innerText();
        assert.ok(!signedOutText.includes(knownHash) && !signedOutText.includes(order.id), 'signed-out notice reveals no hash/order');
      } else {
        await select(side, quantity); await card(stage).waitFor();
      }
      assert.equal(stack.requests.filter(r => r.path.endsWith('/outcomes')).length, beforeOutcomeHttp, 'late original gate never adopts renewed credentials');
      const beforeExpired = await facts(order.id);
      for (const [path, body] of [[`${side}/${order.id}`], ['outcomes', outcome(claimed, knownHash)], ['reconcile', { ...binding(claimed), txHash: knownHash }]]) {
        const answer = await api(original, path, body);
        assert.equal(answer.status, 401); assert.equal(answer.body.error, 'UNAUTHORIZED'); assert.equal(answer.cache, 'no-store');
      }
      assert.deepEqual(await facts(order.id), beforeExpired);
      passed(`${label}: real JWT expired; original callback cannot record; actual wallet hash retained`, { lateAfterLogin });
      await until(Date.parse(order.quoteExpiresAt) + 150, `${label}: unchanged 60-second quote expiry`);
      await control('restartApi'); // Same tab: reloading here would correctly lose the kept candidate.
      if (!lateAfterLogin) current = await login();
      assert.equal(current.duration, 900); assert.ok(current.token !== original.token, 'renewed token differs');
      await select(side, quantity); await card(stage).waitFor();
      assert.equal(await card(stage).getAttribute('data-state'), 'KEPT');
      assert.equal(await card(stage).getByTestId('stocks-known-hash-value').textContent(), knownHash);
      const beforeIsolation = await facts(order.id);
      await control('account-B'); const other = await login();
      const otherText = await page.locator('main').innerText();
      assert.ok(!otherText.includes(knownHash) && !otherText.includes(order.id) && !otherText.includes(notice));
      assert.equal(await page.getByTestId('stocks-known-hash-recovery').count(), 0);
      for (const [path, body] of [[`${side}/${order.id}`], ['outcomes', outcome(claimed, knownHash)], ['reconcile', { ...binding(claimed), txHash: knownHash }]])
        assert.equal((await api(other, path, body)).status, 404);
      await control('account-A'); current = await login(); await select(side, quantity); await card(stage).waitFor();
      assert.equal(await card(stage).getAttribute('data-state'), 'KEPT');
      assert.deepEqual(await facts(order.id), beforeIsolation);
      passed(`${label}: A → B → A in same tab hides other owner's candidate; API restart preserves original binding`);

      const callsBefore = wallet.calls.length;
      let recordAction = 'Record this hash';
      if (side === 'BUY' && stage === 'APPROVAL') {
        const beforeInspect = submissionRequests.length;
        let inspectAborted = 0;
        await page.route(`${submissionPrefix}${side}/${order.id}`, async route => {
          inspectAborted++; await route.abort('failed');
        }, { times: 1 });
        await card(stage).getByRole('button', { name: recordAction, exact: true }).dblclick();
        await wait(async () => await card(stage).getAttribute('data-state') === 'KEPT' &&
          await card(stage).getByRole('button', { name: 'Check again', exact: true }).isEnabled(), 'KEPT failure stays uncertain');
        assert.equal(inspectAborted, 1);
        const text = await card(stage).innerText();
        assert.match(text, /may or may not have recorded the hash/);
        assert.doesNotMatch(text, /stays recorded|The server has recorded/);
        assert.deepEqual(await facts(order.id), beforeIsolation, 'failed inspect writes no hash, claim or proof');
        assert.equal(wallet.calls.length, callsBefore);
        const failedRequests = submissionRequests.slice(beforeInspect);
        assert.deepEqual(failedRequests.map(r => [r.method, r.path]), [['GET', `${side}/${order.id}`]]);
        assert.ok(failedRequests.every(r => r.bearer === `Bearer ${current.token}`));
        recordAction = 'Check again';
        passed('KEPT + failed inspect retains uncertainty; zero outcomes, claims and wallet calls');
      }
      const requestsBefore = submissionRequests.length;
      let aborted = 0;
      const abortFirstReceipt = async route => { aborted++; await route.abort('failed'); };
      await page.route(`${submissionPrefix}reconcile`, abortFirstReceipt, { times: 1 });
      await card(stage).getByRole('button', { name: recordAction, exact: true }).dblclick();
      await wait(async () => await card(stage).getAttribute('data-state') === 'RECORDED' &&
        await card(stage).getByRole('button', { name: 'Check the receipt again', exact: true }).isEnabled(), 'explicit receipt retry after lost request');
      assert.equal(aborted, 1);
      const step = stage === 'APPROVAL' ? 'approval' : side === 'BUY' ? 'deposit' : 'escrow';
      const recordedText = await card(stage).innerText();
      assert.ok(recordedText.includes(`The server has recorded this ${step} hash`));
      assert.ok(recordedText.includes(`The ${step} hash stays recorded on the server`));
      assert.match(recordedText, /The receipt check could not be completed/);
      assert.doesNotMatch(recordedText, /may or may not|may not have (it|recorded)|could not be recorded/i);
      assert.ok(recordedText.includes(`Do not send this ${step} again`));
      const recorded = await facts(order.id);
      assert.equal(recorded.claims.find(r => r.stage === stage).txHash, knownHash);
      assert.equal(recorded.claims.find(r => r.stage === stage).status, 'SUBMITTED');
      assert.equal(recorded.proofs.filter(r => r.claimId === claimed.claimId).length, 0);
      assert.deepEqual(recorded.order, beforeIsolation.order, 'record is not business completion');
      const firstRequests = submissionRequests.slice(requestsBefore);
      assert.deepEqual(firstRequests.map(r => [r.method, r.path]), [['GET', `${side}/${order.id}`], ['POST', 'outcomes'], ['POST', 'reconcile']]);
      assert.deepEqual(firstRequests[1].body, outcome(claimed, knownHash));
      if (side === 'BUY' && stage === 'APPROVAL') {
        await screenshot('known-hash-pending-desktop.png');
        await page.setViewportSize({ width: 375, height: 900 }); await screenshot('known-hash-pending-mobile.png');
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      // No background recovery: only this distinct, real button checks the receipt.
      await delay(1200); assert.equal(submissionRequests.length, requestsBefore + 3);
      await card(stage).getByRole('button', { name: 'Check the receipt again', exact: true }).dblclick();
      await wait(async () => await card(stage).getAttribute('data-state') === 'VERIFIED_CONFIRMED', 'trusted real receipt rendered');
      const recoveryRequests = submissionRequests.slice(requestsBefore);
      assert.deepEqual(recoveryRequests.map(r => [r.method, r.path]), [
        ['GET', `${side}/${order.id}`], ['POST', 'outcomes'], ['POST', 'reconcile'],
        ['GET', `${side}/${order.id}`], ['POST', 'reconcile'],
      ]);
      assert.ok(recoveryRequests.every(r => r.bearer === `Bearer ${current.token}` && r.bearer !== `Bearer ${original.token}`), 'every recovery request pins renewed token');
      assert.equal(wallet.calls.length, callsBefore, 'recovery makes zero wallet calls of any kind');
      assert.equal(wallet.sends.length, sendsBefore);
      const verified = await facts(order.id);
      assert.equal(verified.claims.find(r => r.stage === stage).status, 'CONFIRMED');
      assert.equal(verified.proofs.filter(r => r.claimId === claimed.claimId).length, 1);
      assert.equal(verified.claims.length, beforeIsolation.claims.length);
      assert.deepEqual(verified.order, beforeIsolation.order);
      assert.equal(await card(stage).getByRole('button').count(), 0, 'verified card has no repeat action');
      passed(`${label}: actual Record/Check receipt buttons; real proof; one outcome, zero claims/wallet calls`, {
        orderId: order.id, claimId: claimed.claimId, txHash: knownHash, inspect: 2, outcomes: 1, reconcileAttempted: 2, reconcileDispatched: 1,
      });

      await control('restartApi'); await page.reload(); current = await login(); await select(side, quantity);
      assert.equal(await page.getByTestId('stocks-known-hash-recovery').count(), 0, 'reload drops in-memory card');
      const durable = await api(current, `${side}/${order.id}`);
      assert.equal(durable.status, 200);
      const durableRow = stage === 'APPROVAL' ? durable.body.data.approval : durable.body.data.transfer;
      assert.equal(durableRow.claimId, claimed.claimId); assert.equal(durableRow.txHash, knownHash); assert.equal(durableRow.status, 'CONFIRMED');
      assert.deepEqual(await facts(order.id), verified, 'restart/reload changes no journal/proof');
      await control('startProcessing');
      await wait(async () => !(await stack.snapshot()).runtimeStatus.newOrdersPaused, 'observer healthy');
      const plan = deriveOrder(stack.manifest, verified.order, side);
      const claimBody = requestedStage => ({ side, orderId: order.id, deploymentDigest: stack.digest,
        intentKey: plan.intentKey, stage: requestedStage, transaction: requestedStage === 'APPROVAL' ? plan.approval : plan.transfer,
        transactionDigest: digest(requestedStage === 'APPROVAL' ? plan.approval : plan.transfer) });
      const replay = await api(current, 'claims', claimBody(stage)); assert.equal(replay.status, 200); assert.equal(replay.body.data, null);
      if (stage === 'APPROVAL') {
        const denied = await api(current, 'claims', claimBody('TRANSFER'));
        assert.equal(denied.status, 409); assert.ok(['ORDER_EXPIRED', 'ORDER_NOT_PAYABLE'].includes(denied.body.error));
      } else await complete(side, order.id);
      assert.equal(wallet.sends.length, sendsBefore);
      const finalCase = await facts(order.id);
      assert.equal(finalCase.claims.length, verified.claims.length);
      assert.equal(new Date(finalCase.order.quoteExpiresAt).getTime(), Date.parse(order.quoteExpiresAt));
      cases.push({ side, stage, orderId: order.id, claimId: claimed.claimId, txHash: knownHash, lateAfterLogin,
        quoteExpiresAt: order.quoteExpiresAt, recoveredAt: new Date().toISOString(), businessState: finalCase.order.state });
      passed(`${label}: reload loses tab memory but preserves DB proof; expired quote permits no new transfer`);
    }
    await holdings('2.25'); await screenshot('known-hash-ui-portfolio-desktop.png');
    await page.setViewportSize({ width: 375, height: 900 }); await screenshot('known-hash-ui-portfolio-mobile.png');
    const snapshot = await stack.snapshot();
    assert.equal(String(snapshot.chain.holderStock), '2250000000'); assert.equal(String(snapshot.chain.stockSupply), '2250000000');
    assert.equal(String(snapshot.chain.holderCash), '1730000000'); assert.equal(String(snapshot.chain.vaultCash), '270000000');
    assert.equal(String(snapshot.chain.escrowStock), '0'); assert.equal(snapshot.reconciliation.status, 'MATCHED_AT_CUTOFF');
    assert.deepEqual(snapshot.workerErrors, { processing: [], reviewJobs: [] });
    assert.equal(wallet.sends.length, 8); assert.equal(snapshot.claims.length, 8); assert.deepEqual(report.pageErrors, []);
    report.recoveryCases = cases; report.final = { seedOrderId: seed.id, snapshot };
    passed('Four expired-JWT/quote product UI recoveries; final DB/chain match', { claims: 8, sends: 8, holdings: '2.25' });
    return report;
  } finally {
    page.off('response', onResponse); page.off('request', onRequest);
    await Promise.all([...sessionReads]); sessions.length = 0; submissionRequests.length = 0;
  }
}
