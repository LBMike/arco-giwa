// Backend/HTTP-adapter acceptance in real Chrome. Original transactions start at
// production UI buttons; explicit recovery below is a TEST PROBE, not a product UI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveOrder, digest } from '../../server/dist/stocks-submissions/contracts.js';

export async function runKnownHashScenario(h) {
  const { page, stack, wallet, report, passed, wait, control, signIn, place, select,
    check, status, action, approve, transfer, complete, holdings, heldAction, screenshot } = h;
  report.execution = 'LOCAL_CHROME_KNOWN_HASH_RECOVERY_PG_EVM_ONLY';
  report.recoveryUiImplemented = false;
  report.authFixture = 'Real SIWE; explicitly armed next holder login gets a signed 30-second JWT; other logins remain 900 seconds';
  const sessions = [], sessionReads = new Set(); let authFailure;
  const onResponse = response => {
    if (response.url() !== `${stack.apiBase}/api/v1/auth/verify` || response.status() !== 200) return;
    const work = (async () => {
      const row = await response.json();
      const claims = JSON.parse(Buffer.from(row.token.split('.')[1], 'base64url').toString('utf8'));
      // Credentials stay only in the live test process/page call arguments, never in report or disk.
      sessions.push({ id: `test-client:${randomUUID()}`, accessToken: row.token, walletAddress: row.walletAddress,
        chainId: row.chainId, createdAt: Date.now(), expiresAt: claims.exp * 1000, duration: claims.exp - claims.iat });
    })().catch(() => { authFailure = Error('LOCAL_RECOVERY_AUTH_CAPTURE_FAILED'); });
    sessionReads.add(work); void work.finally(() => sessionReads.delete(work));
  };
  page.on('response', onResponse);
  async function login() {
    const before = sessions.length; await signIn();
    return wait(() => { if (authFailure) throw authFailure; return sessions.length > before && sessions.at(-1); }, 'real SIWE response');
  }
  // Native Chrome fetch; only already-observed session credentials and reviewed routes.
  async function api(session, path, body) {
    return page.evaluate(async ({ base, bearer, path, body }) => {
      const response = await fetch(`${base}/api/v1/stocks/wallet-submissions/${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        credentials: 'omit', cache: 'no-store', redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
    }, { base: stack.apiBase, bearer: session.accessToken, path, body });
  }
  async function client(session, context, operation, txHash) {
    return page.evaluate(async ({ session, context, operation, txHash }) => {
      try {
        const { createSubmissionGate } = await import('/src/demo/giwa/stocks-wallet-submissions/client.ts');
        const gate = createSubmissionGate({ session, apiBase: context.apiBase, side: context.side,
          orderId: context.orderId, deploymentDigest: context.deploymentDigest, walletAddress: session.walletAddress });
        const prior = await gate.inspect(context.intentKey);
        const row = context.stage === 'APPROVAL' ? prior.approval : prior.transfer;
        if (!row) return { error: 'NO_ORIGINAL_CLAIM' };
        const binding = { claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest };
        if (operation === 'record') await gate.record({ ...binding, status: 'SUBMITTED', ...(txHash === undefined ? {} : { txHash }) });
        if (operation === 'reconcile') return { row: await gate.reconcile({ ...binding, txHash }) };
        const observed = await gate.inspect(context.intentKey);
        return { row: context.stage === 'APPROVAL' ? observed.approval : observed.transfer };
      } catch (error) { return { error: typeof error?.message === 'string' && /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_CLIENT_FAILED' }; }
    }, { session, context, operation, txHash });
  }
  const outcome = (row, txHash) => ({ claimId: row.claimId, intentKey: row.intentKey, stage: row.stage,
    transactionDigest: row.transactionDigest, status: 'SUBMITTED', txHash });
  const receipt = (row, txHash) => ({ claimId: row.claimId, intentKey: row.intentKey, stage: row.stage,
    transactionDigest: row.transactionDigest, txHash });
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
  try {
    await page.goto(h.host.url); await page.getByTestId('local-test-controls').waitFor();
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
      if (stage === 'APPROVAL') {
        order = await place(side, quantity); await check();
        await wait(async () => await status() === 'APPROVAL_REQUIRED', `${label} approval required`);
      } else {
        await select(side, quantity); await check();
        await wait(async () => await status() === 'READY_TRANSFER', `${label} transfer ready`);
      }
      await control('stopProcessing');
      const knownHash = await heldAction(stage === 'APPROVAL' ? 'approve' : 'submit');
      const sendsBefore = wallet.sends.length;
      const claimed = (await facts(order.id)).claims.find(r => r.stage === stage);
      assert.equal(claimed.status, 'REQUEST_MAY_START'); assert.equal(claimed.txHash, null);
      const context = { apiBase: stack.apiBase, deploymentDigest: stack.digest, side, orderId: order.id, stage, intentKey: claimed.intentKey };
      const beforeOutcomeHttp = stack.requests.filter(r => r.path.endsWith('/outcomes')).length;
      await until(original.expiresAt + 150, `${label}: actual signed JWT expiry`);
      await wait(async () => (await page.locator('main').innerText()).includes('A wallet request from your last Stocks session'), 'expired-session notice');
      await control('releaseHeld');
      await wait(() => wallet.sends.at(-1).outcome === 'RETURNED', 'late wallet answer returned'); await delay(100);
      assert.equal(stack.requests.filter(r => r.path.endsWith('/outcomes')).length, beforeOutcomeHttp, 'old UI gate never adopts a new session');
      const beforeExpired = await facts(order.id);
      const rows = [await api(original, `${side}/${order.id}`), await api(original, 'outcomes', outcome(claimed, knownHash)), await api(original, 'reconcile', receipt(claimed, knownHash))];
      for (const row of rows) { assert.equal(row.status, 401); assert.equal(row.body.error, 'UNAUTHORIZED'); assert.equal(row.cache, 'no-store'); }
      const requestsBeforeClient = stack.requests.length;
      assert.equal((await client(original, context, 'record', knownHash)).error, 'SUBMISSION_AUTH_REQUIRED');
      assert.equal(stack.requests.length, requestsBeforeClient, 'expired adapter refuses before HTTP');
      assert.deepEqual(await facts(order.id), beforeExpired);
      passed(`${label}: actual expired JWT rejected; late original UI gate and adapter cannot record`, { orderId: order.id, jwtSeconds: 30, expiredAt: new Date(original.expiresAt).toISOString() });

      await until(Date.parse(order.quoteExpiresAt) + 150, `${label}: unchanged original 60-second quote expiry`);
      await control('restartApi'); await page.reload(); current = await login(); assert.equal(current.duration, 900);
      assert.notEqual(current.accessToken, original.accessToken);
      const first = await client(current, context, 'inspect'); assert.equal(first.row.claimId, claimed.claimId); assert.equal(first.row.txHash, undefined);
      assert.equal(first.row.status, 'REQUEST_MAY_START');
      const beforeDenied = await facts(order.id);
      // Missing hashes stay locked; neither a guess nor a new wallet request is made.
      assert.ok((await client(current, context, 'record')).error);
      await control('account-B'); const other = await login();
      for (const row of [await api(other, `${side}/${order.id}`), await api(other, 'outcomes', outcome(claimed, knownHash)), await api(other, 'reconcile', receipt(claimed, knownHash))]) assert.equal(row.status, 404);
      await control('account-A'); await page.reload(); current = await login();
      for (const payload of [{ ...outcome(claimed, knownHash), transactionDigest: 'f'.repeat(64) }, { ...outcome(claimed, knownHash), status: 'CONFIRMED' }])
        assert.equal((await api(current, 'outcomes', payload)).status, 409);
      assert.deepEqual(await facts(order.id), beforeDenied);
      passed(`${label}: wrong owner, missing hash, altered binding and client terminal claim cannot change journal`);

      // Explicit test recovery through the unchanged production HTTP adapter.
      const recorded = await client(current, context, 'record', knownHash);
      assert.equal(recorded.row.claimId, claimed.claimId); assert.equal(recorded.row.txHash, knownHash); assert.equal(recorded.row.status, 'SUBMITTED');
      const once = await facts(order.id);
      const duplicate = await client(current, context, 'record', knownHash); assert.deepEqual(duplicate, recorded);
      assert.deepEqual(await facts(order.id), once, 'identical outcome creates no second audit or claim');
      const alternateHash = wallet.sends[0].hash === knownHash ? wallet.sends[1].hash : wallet.sends[0].hash;
      assert.equal((await api(current, 'outcomes', outcome(claimed, alternateHash))).body.error, 'SUBMISSION_HASH_CONFLICT');
      assert.deepEqual(await facts(order.id), once);
      const confirmed = await wait(async () => {
        const answer = await client(current, context, 'reconcile', knownHash);
        assert.ok(!answer.error, JSON.stringify(answer));
        if (answer.row.status === 'CONFIRMED') return answer.row;
        assert.equal(answer.row.status, 'SUBMITTED'); await delay(1000); return null;
      }, `${label} actual receipt verification`, 20000);
      const verified = await facts(order.id);
      assert.equal(verified.claims.find(r => r.stage === stage).status, 'CONFIRMED');
      assert.equal(verified.proofs.filter(r => r.claimId === claimed.claimId).length, 1);
      assert.deepEqual(verified.order, beforeDenied.order, 'record/reconcile does not complete or rewrite business order');
      const late = { claimId: claimed.claimId, intentKey: claimed.intentKey, stage, transactionDigest: claimed.transactionDigest, status: 'UNKNOWN' };
      assert.equal((await api(current, 'outcomes', late)).body.data.status, 'CONFIRMED');
      assert.deepEqual((await client(current, context, 'reconcile', knownHash)).row, confirmed);
      assert.deepEqual(await facts(order.id), verified);
      assert.equal(wallet.sends.length, sendsBefore);
      passed(`${label}: renewed SIWE session records original hash and real receipt; duplicate idempotent; no wallet send`, { orderId: order.id, claimId: claimed.claimId, hash: knownHash });

      await control('restartApi'); await page.reload(); current = await login();
      assert.deepEqual((await client(current, context, 'inspect')).row, confirmed);
      assert.equal(wallet.sends.length, sendsBefore);
      await control('startProcessing');
      await wait(async () => !(await stack.snapshot()).runtimeStatus.newOrdersPaused, 'observer healthy after processing resumes');
      const plan = deriveOrder(stack.manifest, verified.order, side);
      const claimBody = requestedStage => ({ side, orderId: order.id, deploymentDigest: stack.digest,
        intentKey: plan.intentKey, stage: requestedStage, transaction: requestedStage === 'APPROVAL' ? plan.approval : plan.transfer,
        transactionDigest: digest(requestedStage === 'APPROVAL' ? plan.approval : plan.transfer) });
      const replay = await api(current, 'claims', claimBody(stage)); assert.equal(replay.status, 200); assert.equal(replay.body.data, null);
      if (stage === 'APPROVAL') {
        const denied = await api(current, 'claims', claimBody('TRANSFER'));
        assert.equal(denied.status, 409); assert.ok(['ORDER_EXPIRED', 'ORDER_NOT_PAYABLE'].includes(denied.body.error));
      } else { await select(side, quantity); await complete(side, order.id); }
      assert.equal(wallet.sends.length, sendsBefore);
      const finalCase = await facts(order.id);
      assert.equal(finalCase.claims.length, verified.claims.length);
      assert.equal(new Date(finalCase.order.quoteExpiresAt).getTime(), Date.parse(order.quoteExpiresAt));
      cases.push({ side, stage, orderId: order.id, claimId: claimed.claimId, txHash: knownHash,
        quoteExpiresAt: order.quoteExpiresAt, recoveredAt: new Date().toISOString(), sends: sendsBefore, businessState: finalCase.order.state });
      passed(`${label}: API/browser restart preserves proof; original claim cannot be replayed; expired order grants no new transfer`);
    }
    await holdings('2.25'); await screenshot('recovery-portfolio-desktop.png');
    await page.setViewportSize({ width: 375, height: 900 }); await screenshot('recovery-portfolio-mobile.png');
    const snapshot = await stack.snapshot();
    assert.equal(String(snapshot.chain.holderStock), '2250000000'); assert.equal(String(snapshot.chain.stockSupply), '2250000000');
    assert.equal(String(snapshot.chain.holderCash), '1730000000'); assert.equal(String(snapshot.chain.vaultCash), '270000000');
    assert.equal(String(snapshot.chain.escrowStock), '0'); assert.equal(snapshot.reconciliation.status, 'MATCHED_AT_CUTOFF');
    assert.deepEqual(snapshot.workerErrors, { processing: [], reviewJobs: [] });
    assert.equal(wallet.sends.length, 8); assert.equal(snapshot.claims.length, 8); assert.deepEqual(report.pageErrors, []);
    report.recoveryCases = cases; report.final = { seedOrderId: seed.id, snapshot };
    passed('Four actual expired-JWT/quote recovery cases completed with original hashes only; final DB/chain match', { claims: 8, sends: 8, holdings: '2.25' });
    return report;
  } finally {
    page.off('response', onResponse); await Promise.all([...sessionReads]); sessions.length = 0;
  }
}
