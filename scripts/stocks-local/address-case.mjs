import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { callDigest, freezeManifest, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { authorizedCall } from '../../server/dist/stocks/chain.js';
import { externalStocksSigner } from '../../server/dist/stocks-runtime/transport.js';
import { localSigner } from './local-signer.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

export async function runStack({ rpcUrl, bundle, databaseUrl }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(bundle.execution, 'LOCAL_EVM_TEST_HARNESS_ONLY');
  assert.equal(new URL(rpcUrl).hostname, '127.0.0.1');
  assert.equal(new URL(databaseUrl).pathname, '/stocks_local_test');
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const servers = new Set();
  const token = `TEST_HARNESS_ONLY_CASE_${randomUUID()}`;
  const report = { execution: 'LOCAL_EVM_TEST_HARNESS_ONLY', scenarios: [] };
  let broadcasts = 0;
  async function rpc(method, params) {
    if (method === 'eth_sendTransaction') broadcasts++;
    const id = randomUUID();
    const response = await fetch(rpcUrl, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    assert.equal(value.id, id);
    assert.ok(!value.error, `${method}: ${value.error?.message ?? 'RPC error'}`);
    return value.result;
  }
  const lower = freezeManifest(bundle.manifest);
  const mixed = freezeManifest({ ...lower, deploymentId: `${lower.deploymentId}-case`,
    signerAddress: getAddress(lower.signerAddress), mintController: getAddress(lower.mintController) });
  assert.notEqual(lower.signerAddress, mixed.signerAddress, 'Fixture needs a genuine checksum spelling');
  assert.notEqual(lower.mintController, mixed.mintController, 'Fixture needs a checksum target too');
  const row = async id => (await pool.query('SELECT * FROM stocks_local_harness.signer_operations WHERE id=$1', [id])).rows[0];
  const nonce = () => rpc('eth_getTransactionCount', [lower.signerAddress, 'pending']);
  const mint = (manifest, id, quantity = '1') => authorizedCall(manifest, id, 'MINT', bundle.publicAccounts.holder, quantity);
  async function setup(manifest, transport = rpc) {
    const deploymentDigest = manifestDigest(manifest);
    const server = await localSigner({ pool, rpc: transport, manifest, deploymentDigest, token });
    servers.add(server);
    const client = externalStocksSigner({ url: server.url, authorization: token, deploymentDigest, manifest, localHarness: true });
    await client.probe();
    return { server, client };
  }
  async function close(server) { await server.close(); servers.delete(server); }
  async function minedOriginal(call) {
    const block = await rpc('eth_getBlockByNumber', ['latest', true]);
    const transaction = block.transactions.find(tx => tx.from.toLowerCase() === lower.signerAddress && tx.input === call.data);
    assert.ok(transaction, 'Original call must have actually mined before response loss');
    assert.equal((await rpc('eth_getTransactionReceipt', [transaction.hash])).status, '0x1');
    return transaction;
  }
  try {
    let checksum = await setup(mixed);
    const lost = mint(mixed, 'mint:case-lost-ack');
    checksum.server.controls.loseNextBroadcastAcknowledgement = true;
    await assert.rejects(() => checksum.client.submit(lost), /SIGNER_RESPONSE_UNAVAILABLE/);
    const original = await minedOriginal(lost);
    const beforeRestart = await row(lost.operationId);
    assert.equal(beforeRestart.state, 'PREPARED');
    assert.equal(beforeRestart.tx_hash, null);
    const beforeRecovery = { broadcasts, nonce: await nonce() };
    await close(checksum.server);
    checksum = await setup(mixed);
    const recovered = await checksum.client.lookup(lost.operationId);
    assert.equal(recovered?.txHash, original.hash, 'Checksum sender/target must recover the original mined hash after restart');
    assert.equal(recovered.callDigest, callDigest(lost));
    assert.equal(checksum.server.controls.submissions, 0);
    assert.equal(broadcasts, beforeRecovery.broadcasts);
    assert.equal(await nonce(), beforeRecovery.nonce);
    assert.equal((await row(lost.operationId)).account, lower.signerAddress);
    assert.deepEqual((await row(lost.operationId)).payload, lost);
    report.scenarios.push('Checksum sender and target recover original mined hash after lost response/restart without resubmission');

    const lowercase = await setup(lower);
    const calls = [mint(lower, 'mint:case-concurrent-lower', '2'), mint(mixed, 'mint:case-concurrent-checksum', '3')];
    const results = await Promise.all([lowercase.client.submit(calls[0]), checksum.client.submit(calls[1])]);
    const concurrentRows = await Promise.all(calls.map(call => row(call.operationId)));
    const nonces = concurrentRows.map(value => BigInt(value.nonce)).sort((a, b) => a < b ? -1 : 1);
    assert.equal(nonces[1], nonces[0] + 1n);
    assert.notEqual(concurrentRows[0].deployment_digest, concurrentRows[1].deployment_digest);
    assert.deepEqual(new Set(concurrentRows.map(value => value.account)), new Set([lower.signerAddress]));
    for (let n = 0; n < calls.length; n++) {
      assert.deepEqual(concurrentRows[n].payload, calls[n]);
      assert.equal(concurrentRows[n].call_digest, callDigest(calls[n]));
      assert.equal((await rpc('eth_getTransactionReceipt', [results[n].txHash])).status, '0x1');
    }
    const replayBefore = { broadcasts, nonce: await nonce() };
    assert.deepEqual(await checksum.client.submit(calls[1]), results[1]);
    assert.equal(broadcasts, replayBefore.broadcasts);
    assert.equal(await nonce(), replayBefore.nonce);
    report.scenarios.push('Mixed-case concurrent requests across deployment digests serialize physical nonces and preserve original payload/digest');

    // Simulate one pre-upgrade checksum account row by changing only its address
    // spelling. The original call/digest/nonce and actual broadcast remain intact.
    const legacy = mint(mixed, 'mint:case-legacy-lost-ack', '4');
    checksum.server.controls.loseNextBroadcastAcknowledgement = true;
    await assert.rejects(() => checksum.client.submit(legacy), /SIGNER_RESPONSE_UNAVAILABLE/);
    const legacyOriginal = await minedOriginal(legacy);
    await pool.query('UPDATE stocks_local_harness.signer_operations SET account=$2 WHERE id=$1', [legacy.operationId, mixed.signerAddress]);
    const legacyBefore = await row(legacy.operationId);
    await close(checksum.server);
    checksum = await setup(mixed);
    const legacyRecovered = await checksum.client.lookup(legacy.operationId);
    assert.equal(legacyRecovered?.txHash, legacyOriginal.hash);
    assert.equal(checksum.server.controls.submissions, 0);
    assert.deepEqual((await row(legacy.operationId)).payload, legacyBefore.payload);
    assert.equal((await row(legacy.operationId)).call_digest, legacyBefore.call_digest);
    // Force a stale chain nonce read: the stored maximum must include the legacy
    // checksum account, not allocate an older nonce from lower-case rows alone.
    const staleReader = await setup(lower, (method, params) => method === 'eth_getTransactionCount' ? Promise.resolve('0x0') : rpc(method, params));
    const afterLegacy = mint(lower, 'mint:case-after-legacy', '5');
    await staleReader.client.submit(afterLegacy);
    assert.equal(BigInt((await row(afterLegacy.operationId)).nonce), BigInt(legacyBefore.nonce) + 1n);
    report.scenarios.push('Existing checksum row participates in restart recovery and stored nonce maximum without rewriting request evidence');

    let failBeforeSend = true;
    const beforeSendFailure = await setup(lower, async (method, params) => {
      if (method === 'eth_sendTransaction' && failBeforeSend) { failBeforeSend = false; throw new Error('TEST_ONLY_PRE_BROADCAST_FAILURE'); }
      return rpc(method, params);
    });
    const prepared = mint(lower, 'mint:case-prepared-original', '6');
    await assert.rejects(() => beforeSendFailure.client.submit(prepared), /SIGNER_RESPONSE_UNAVAILABLE/);
    const preparedBefore = await row(prepared.operationId);
    assert.equal(preparedBefore.state, 'PREPARED');
    const blockedBefore = { broadcasts, nonce: await nonce() };
    const blocked = [mint(mixed, 'mint:case-blocked-checksum'), mint(lower, 'mint:case-blocked-lower')];
    await Promise.all([
      assert.rejects(() => checksum.client.submit(blocked[0]), /SIGNER_RESPONSE_UNAVAILABLE/),
      assert.rejects(() => lowercase.client.submit(blocked[1]), /SIGNER_RESPONSE_UNAVAILABLE/),
    ]);
    assert.equal(await beforeSendFailure.client.lookup(prepared.operationId), null);
    await assert.rejects(() => beforeSendFailure.client.submit(prepared), /SIGNER_RESPONSE_UNAVAILABLE/);
    assert.equal(broadcasts, blockedBefore.broadcasts);
    assert.equal(await nonce(), blockedBefore.nonce);
    assert.deepEqual(await row(prepared.operationId), preparedBefore);
    for (const call of blocked) assert.equal(await row(call.operationId), undefined);
    assert.equal(checksum.server.controls.unresolvedBlocks, 1);
    report.scenarios.push('Lowercase PREPARED operation blocks mixed-case concurrent later requests across deployments without resubmission');

    // Explicitly model a database from the old case-sensitive schema. Do not
    // delete/reset conflict rows to make startup pass: the new signer must stop.
    for (const server of [...servers]) await close(server);
    const collision = mint(mixed, 'mint:case-legacy-collision');
    const insertCollision = () => pool.query(`INSERT INTO stocks_local_harness.signer_operations
      (id,deployment_digest,call_digest,payload,node_instance,account,nonce,prepared_block,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED')`, [collision.operationId, manifestDigest(mixed), callDigest(collision),
      JSON.stringify(collision), preparedBefore.node_instance, mixed.signerAddress, preparedBefore.nonce, preparedBefore.prepared_block]);
    await assert.rejects(insertCollision, /duplicate key/);
    await pool.query('DROP INDEX stocks_local_harness.signer_operations_physical_nonce');
    await insertCollision();
    const preserved = (await pool.query('SELECT * FROM stocks_local_harness.signer_operations ORDER BY id')).rows;
    const beforeCollision = broadcasts;
    await assert.rejects(() => setup(mixed), /physical.account nonce records conflict/i);
    assert.deepEqual((await pool.query('SELECT * FROM stocks_local_harness.signer_operations ORDER BY id')).rows, preserved);
    assert.equal(broadcasts, beforeCollision);
    report.scenarios.push('Case-insensitive DB uniqueness rejects new collision and existing legacy collision fails startup with all evidence preserved');
    report.result = 'PASS';
    return report;
  } finally {
    for (const server of servers) await server.close();
    await pool.end();
  }
}
